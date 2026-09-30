# HK SYNC deployment

## Render

1. Push this repository to GitHub.
2. In Render, choose **New > Blueprint** and select the repository.
3. Render reads `render.yaml` and creates the API and static frontend.
4. After the API is created, set its `CLIENT_URL` to the exact frontend URL shown by Render.
5. Point the frontend at the Render API: production builds use the API URL in `API_ORIGIN` at the top of `frontend/src/App.jsx` (currently the Railway API), so change it there; `VITE_API_URL` is ignored in production builds.
6. Open the frontend URL and sign in with an account created by the manager.

The API uses SQLite at `backend/data/bahari.sqlite`. The Render persistent disk mounted at `backend/data` keeps the database between deploys. Keep the disk attached to one API instance; move to PostgreSQL before running multiple API instances.

## Required production settings

- `JWT_SECRET`: long random secret, never commit it.
- `CLIENT_URL`: comma-separated frontend origin(s), with no trailing slash.
- `VITE_API_URL`: the public API origin, with no trailing `/api` suffix.
- `SEED_MANAGER_PASSWORD` (optional): initial manager password for an empty database. If unset in production, a random one is generated and printed once in the logs.
- `NODE_ENV=production`: reset tokens are not returned in API responses in production. Connect the reset flow to an email provider before enabling self-service password reset.

## Local preview

Backend:

```powershell
Push-Location backend; npm start; Pop-Location
```

Frontend:

```powershell
Push-Location frontend; npm run dev; Pop-Location
```
