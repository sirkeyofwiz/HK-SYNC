# HK SYNC

HK-SYNC is a housekeeping operations command centre. It brings inspections, shift handovers, vehicle and tools checks, follow-up tasks, and staff performance into one place.

## Features

- Role-based access for managers, supervisors, drivers, and storekeepers
- Inspection reports for neglected areas, room quality, trolleys and pantries, shift handovers, vehicles, and tools
- Photo attachments on field reports
- Manager review, sign-off, and follow-up task dispatch
- Staff performance and daily score views
- Excel and PDF report exports
- SQLite persistence and Socket.IO-ready backend architecture

## Project structure

- `backend/` - Express API, authentication, SQLite database, and server-side business logic
- `frontend/` - React and Vite web application
- `DEPLOYMENT.md` - Detailed Render deployment instructions
- `render.yaml` - Render Blueprint configuration

## Run locally

Prerequisites: Node.js 18 or newer and npm.

Install dependencies:

```powershell
Push-Location backend; npm install; Pop-Location
Push-Location frontend; npm install; Pop-Location
```

Start the API in one terminal:

```powershell
Push-Location backend; npm start; Pop-Location
```

Start the frontend in another terminal:

```powershell
Push-Location frontend; npm run dev; Pop-Location
```

The frontend uses `http://localhost:5000` as the default API origin. To use another API origin, create `frontend/.env` with:

```env
VITE_API_URL=http://localhost:5000
```

For a production frontend build:

```powershell
Push-Location frontend; npm run build; Pop-Location
```

## Demo account

The development login is prefilled with:

- Email: `manager@bahari.local`
- Password: `password123`

Change demo credentials before using the application in a real environment.

## Production configuration

The backend uses these environment variables:

- `JWT_SECRET` - long random secret used to sign authentication tokens
- `CLIENT_URL` - comma-separated frontend origin(s), without trailing slashes
- `NODE_ENV=production` - enables production behavior

The frontend uses:

- `VITE_API_URL` - public API origin, without the `/api` suffix

See [DEPLOYMENT.md](DEPLOYMENT.md) for the Render setup and SQLite persistent-disk requirements.

## Data

The local SQLite database is stored under `backend/data`. Keep database files out of source control when deploying or sharing the project, and back up production data before maintenance.
