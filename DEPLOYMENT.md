# HK SYNC deployment

## Render

1. Push this repository to GitHub.
2. In Render, choose **New > Blueprint** and select the repository.
3. Render reads `render.yaml` and creates the API and static frontend.
4. After the API is created, set its `CLIENT_URL` to the exact frontend URL shown by Render.
5. Confirm `VITE_API_URL` on the frontend matches the API URL, then redeploy the frontend.
6. Open the frontend URL and sign in with an account created by the manager.

The API uses SQLite at `backend/data/bahari.sqlite`. The Render persistent disk mounted at `backend/data` keeps the database between deploys. Keep the disk attached to one API instance; move to PostgreSQL before running multiple API instances.

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

- Every night after 02:00 hotel time (and about a minute after a deploy if the last backup is over a day old) the API uploads `db/YYYY-MM-DD.sqlite.gz`, a consistent compressed copy of the whole database, plus each chat file once as `files/<id>`.
- It keeps the newest 14 daily copies and the first copy of each of the last 12 months. Chat files deleted in the app stay in the bucket for 35 days.
- The manager (not assistant managers) sees the status on **Account › Data backups**, can run **Back up now**, and can **Download a copy** of the database to keep elsewhere. A backup holds everything, including password hashes, so keep downloaded copies private.
- Settings on the API service, all Railway variable references to the bucket: `BACKUP_BUCKET`, `BACKUP_ACCESS_KEY_ID`, `BACKUP_SECRET_ACCESS_KEY`, `BACKUP_ENDPOINT`, `BACKUP_REGION`. Without them backups are off and the panel says so.

### Restoring a backup

1. Pick the copy: the bucket's **Files** tab in Railway lists `db/…` files, or use `latest`.
2. On the API service, add the variable `RESTORE_BACKUP` = `db/2026-10-05.sqlite.gz` (or `latest`) and let it redeploy.
3. On start the API downloads that copy, moves the current database aside into `before-restore-<time>/` on the volume (nothing is deleted), puts the copy in place and brings back any missing chat files. The deploy log says `RESTORE_BACKUP: restored …`. If the name is wrong or the bucket can't be reached, it logs why and keeps running on the current data.
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
