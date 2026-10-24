# HK SYNC deployment

## Railway

Production runs as two Railway services that deploy automatically from `main`:

- **bahari-operations-api** — root directory `/backend`, `npm install`, `node server.js`, health check `/api/health`. A volume holds the SQLite database (`bahari.sqlite`), chat files (`uploads/`) and report photos (`report-photos/`); the API finds it through `RAILWAY_VOLUME_MOUNT_PATH`.
- **bahari-operations-web** — root directory `/frontend`, `npm install && npm run build`, served from `dist` by Caddy with `frontend/Caddyfile` (security headers and caching).

Keep the API to one instance while it uses SQLite on a volume; move to PostgreSQL before running several.

### Addresses

- The web app finds the API through **`VITE_API_URL`** (the web service's Railway variable; `frontend/.env.production` is the fallback for local builds). If the API's address ever changes, also update `connect-src` in `frontend/Caddyfile`: the production build stops with a message until both agree.
- The API always accepts the web app's address (`PRODUCTION_WEB_URL` at the top of `backend/server.js`), any origin in `CLIENT_URL`, and the Android app.

## Required production settings

- `JWT_SECRET`: long random secret, never commit it.
- `CLIENT_URL`: comma-separated frontend origin(s), with no trailing slash.
- `VITE_API_URL`: the public API origin, with no trailing `/api` suffix.
- `RESEND_API_KEY` and `EMAIL_FROM` (optional): turn on "Forgot password" emails via Resend. `EMAIL_FROM` must be on a domain verified in Resend, e.g. `HK SYNC <noreply@yourhotel.com>`. Without them, managers can still create a 24-hour reset link from the People page and pass it on.
- `APP_URL` (optional): the frontend URL used in reset links; defaults to the first `CLIENT_URL`.
- `SEED_MANAGER_PASSWORD` (optional): initial manager password for an empty database. If unset in production, a random one is generated and printed once in the logs.
- `NODE_ENV=production`: "Forgot password" never returns the reset link in the response (only by email); a manager's "Reset password" always returns a 24-hour link so it can be handed over in person. Self-service reset emails need `RESEND_API_KEY` and `EMAIL_FROM`.

## Backups

Production runs on Railway (Hobby plan), whose built-in volume backups need the Pro plan, so the API backs itself up to a Railway Storage Bucket instead.

- Every night after 02:00 hotel time (and about a minute after a deploy if the last backup is over a day old) the API uploads `db/YYYY-MM-DD.sqlite.gz`, a consistent compressed copy of the whole database, plus each chat file once as `files/<id>` and each report photo once as `photos/<name>`.
- Report photos are files in `report-photos/` on the volume (the database only names them). Photos are never removed from the bucket, since older database copies may still use them. Database copies made before photos became files hold the photos themselves; restoring one works as before, and the API moves those photos into files when it starts.
- It keeps the newest 14 daily copies and the first copy of each of the last 12 months. Chat files deleted in the app stay in the bucket for 35 days.
- The manager (not assistant managers) sees the status on **Account › Data backups**, can run **Back up now**, and can **Download a copy** of the database to keep elsewhere. A backup holds everything, including password hashes, so keep downloaded copies private.
- Settings on the API service, all Railway variable references to the bucket: `BACKUP_BUCKET`, `BACKUP_ACCESS_KEY_ID`, `BACKUP_SECRET_ACCESS_KEY`, `BACKUP_ENDPOINT`, `BACKUP_REGION`. Without them backups are off and the panel says so.

### Restoring a backup

1. Pick the copy: the bucket's **Files** tab in Railway lists `db/…` files, or use `latest`.
2. On the API service, add the variable `RESTORE_BACKUP` = `db/2026-10-05.sqlite.gz` (or `latest`) and let it redeploy.
3. On start the API downloads that copy, moves the current database aside into `before-restore-<time>/` on the volume (nothing is deleted), puts the copy in place and brings back any missing chat files and report photos. The deploy log says `RESTORE_BACKUP: restored …`. If the name is wrong or the bucket can't be reached, it logs why and keeps running on the current data.
4. Check the app, then **remove `RESTORE_BACKUP`**. Leaving it set does no harm (the same restore never runs twice), but it is clearer to remove it.

`ALLOW_ANY_REPORT_DATE=1` lifts the 7-days-back report date rule, for example when re-entering old paper reports.

## Local preview

Backend:

```powershell
Push-Location backend; npm start; Pop-Location
```

Frontend:

```powershell
Push-Location frontend; npm run dev; Pop-Location
```
