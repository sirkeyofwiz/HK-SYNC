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

## Local preview

Backend:

```powershell
Push-Location backend; npm start; Pop-Location
```

Frontend:

```powershell
Push-Location frontend; npm run dev; Pop-Location
```
