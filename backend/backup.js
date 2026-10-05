// Off-site backups to an S3-compatible bucket (a Railway Storage Bucket in production).
// Each night: a compressed copy of the whole database as db/YYYY-MM-DD.sqlite.gz, plus every chat file
// not yet in the bucket as files/<id>. Old database copies are thinned out to 14 daily + 12 monthly.
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand } from '@aws-sdk/client-s3';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
const env = process.env;
const BUCKET = env.BACKUP_BUCKET;
export const DAILY_KEEP = 14;
export const MONTHLY_KEEP = 12;
// Files removed in the app stay in the bucket this long, so recent database copies can still be restored with them.
const FILE_GRACE_DAYS = 35;
const SQLITE_HEADER = Buffer.from('SQLite format 3\0');

export const backupConfigured = Boolean(BUCKET && env.BACKUP_ACCESS_KEY_ID && env.BACKUP_SECRET_ACCESS_KEY && env.BACKUP_ENDPOINT);
const client = backupConfigured ? new S3Client({
  region: env.BACKUP_REGION || 'auto',
  endpoint: env.BACKUP_ENDPOINT,
  forcePathStyle: env.BACKUP_PATH_STYLE === 'true',
  credentials: { accessKeyId: env.BACKUP_ACCESS_KEY_ID, secretAccessKey: env.BACKUP_SECRET_ACCESS_KEY },
  // Only send checksums S3 itself requires; not every S3-compatible store accepts the newer optional ones.
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED'
}) : null;

async function listAll(prefix) {
  const objects = [];
  let ContinuationToken;
  do {
    const page = await client.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken }));
    objects.push(...(page.Contents || []).map((item) => ({ key: item.Key, size: Number(item.Size) || 0, lastModified: item.LastModified ? new Date(item.LastModified).toISOString() : null })));
    ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return objects;
}

const put = (key, body, contentType) => client.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: contentType }));
const remove = (key) => client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
async function download(key) {
  const result = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return Buffer.from(await result.Body.transformToByteArray());
}

// A consistent copy of the live database (safe while the app is running), compressed.
export async function databaseSnapshot(database, dataDir) {
  const temp = path.join(dataDir, `backup-${process.pid}-${Date.now()}.sqlite`);
  try {
    await database.backup(temp);
    return await gzip(fs.readFileSync(temp));
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

const snapshotDate = (key) => (key.match(/^db\/(\d{4}-\d{2}-\d{2})\.sqlite\.gz$/) || [])[1] || null;

// Keep the newest DAILY_KEEP copies, plus the first copy of each of the last MONTHLY_KEEP months.
export function snapshotsToDelete(keys) {
  const dated = keys.map((key) => ({ key, date: snapshotDate(key) })).filter((item) => item.date).sort((a, b) => b.date.localeCompare(a.date));
  const keep = new Set(dated.slice(0, DAILY_KEEP).map((item) => item.key));
  const firstOfMonth = new Map();
  for (const item of dated) firstOfMonth.set(item.date.slice(0, 7), item.key); // newest-first, so the last write is the month's earliest
  [...firstOfMonth.keys()].sort().reverse().slice(0, MONTHLY_KEEP).forEach((month) => keep.add(firstOfMonth.get(month)));
  return dated.filter((item) => !keep.has(item.key)).map((item) => item.key);
}

export async function runBackup({ database, dataDir, uploadDir, attachmentIds, today }) {
  if (!backupConfigured) throw new Error('Backups are not set up: the BACKUP_* settings are missing.');
  const snapshot = await databaseSnapshot(database, dataDir);
  const key = `db/${today}.sqlite.gz`;
  await put(key, snapshot, 'application/gzip');

  const stored = new Map((await listAll('files/')).map((item) => [item.key, item]));
  let filesUploaded = 0;
  for (const id of attachmentIds) {
    const local = path.join(uploadDir, id);
    if (stored.has(`files/${id}`) || !fs.existsSync(local)) continue;
    await put(`files/${id}`, fs.readFileSync(local), 'application/octet-stream');
    filesUploaded += 1;
  }
  const current = new Set(attachmentIds.map((id) => `files/${id}`));
  const graceCutoff = Date.now() - FILE_GRACE_DAYS * 86400000;
  for (const item of stored.values()) {
    if (!current.has(item.key) && item.lastModified && new Date(item.lastModified).getTime() < graceCutoff) await remove(item.key);
  }

  const snapshots = await listAll('db/');
  const expired = snapshotsToDelete(snapshots.map((item) => item.key));
  for (const old of expired) await remove(old);
  return { key, size: snapshot.length, filesUploaded, filesTotal: current.size, snapshotsKept: snapshots.length - expired.length };
}

// Readable reason for a failed storage call (network errors arrive as an AggregateError with no message).
export function describeError(error) {
  const inner = error?.errors?.[0] || error?.cause;
  const code = error?.code || inner?.code || error?.Code;
  if (['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN'].includes(code)) return `Could not reach the backup storage (${code}).`;
  if (error?.$metadata?.httpStatusCode === 403 || code === 'AccessDenied' || code === 'InvalidAccessKeyId' || code === 'SignatureDoesNotMatch') return 'The backup storage refused the keys (access denied). Check the BACKUP_* settings.';
  return String(error?.message || code || inner?.message || error).slice(0, 300);
}

export async function listSnapshots() {
  if (!backupConfigured) return [];
  return (await listAll('db/')).filter((item) => snapshotDate(item.key)).sort((a, b) => b.key.localeCompare(a.key));
}

// Restore, run before the database is opened: set RESTORE_BACKUP to a key such as db/2026-10-05.sqlite.gz
// (or "latest") and redeploy. The current database is moved aside, never deleted, and a marker stops the
// same restore from running again on later restarts. Remove RESTORE_BACKUP once the app looks right.
export async function restoreIfRequested({ dataDir, databasePath, uploadDir }) {
  const requested = String(env.RESTORE_BACKUP || '').trim();
  if (!requested) return null;
  if (!backupConfigured) { console.error('RESTORE_BACKUP is set but backups are not configured; nothing restored.'); return null; }
  const markerPath = path.join(dataDir, 'restored-backup.json');
  const available = await listSnapshots();
  const key = requested === 'latest' ? available[0]?.key : available.find((item) => item.key === requested)?.key;
  if (!key) { console.error(`RESTORE_BACKUP: no backup called "${requested}" was found; nothing restored.`); return null; }
  const marker = fs.existsSync(markerPath) ? JSON.parse(fs.readFileSync(markerPath, 'utf8')) : null;
  if (marker?.key === key) { console.log(`RESTORE_BACKUP: ${key} was already restored on ${marker.at}. Remove the RESTORE_BACKUP setting.`); return null; }

  const restored = await gunzip(await download(key));
  if (!restored.subarray(0, SQLITE_HEADER.length).equals(SQLITE_HEADER)) throw new Error(`RESTORE_BACKUP: ${key} is not a database backup; nothing restored.`);
  const aside = path.join(dataDir, `before-restore-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(aside, { recursive: true });
  const moved = [];
  try {
    for (const suffix of ['', '-wal', '-shm']) {
      if (!fs.existsSync(databasePath + suffix)) continue;
      fs.renameSync(databasePath + suffix, path.join(aside, path.basename(databasePath) + suffix));
      moved.push(suffix);
    }
    fs.writeFileSync(databasePath, restored);
  } catch (error) {
    // Put the original database back exactly as it was.
    fs.rmSync(databasePath, { force: true });
    for (const suffix of moved) fs.renameSync(path.join(aside, path.basename(databasePath) + suffix), databasePath + suffix);
    throw error;
  }

  // Bring back any chat files that are missing on this volume.
  fs.mkdirSync(uploadDir, { recursive: true });
  let files = 0;
  for (const item of await listAll('files/')) {
    const local = path.join(uploadDir, path.basename(item.key));
    if (fs.existsSync(local)) continue;
    fs.writeFileSync(local, await download(item.key));
    files += 1;
  }
  fs.writeFileSync(markerPath, JSON.stringify({ key, at: new Date().toISOString(), previous: aside }));
  console.log(`RESTORE_BACKUP: restored ${key} (${files} chat files brought back). The previous database was kept in ${aside}.`);
  return { key, files, previous: aside };
}
