# IronLog

A mobile-first PWA gym tracker. Log workouts with sweaty hands, follow Day A/B programs, and watch your strength progress over time.

## What it does

- **Fast logging** — sets pre-fill from your last session; big +/- buttons; one-tap confirm
- **Programs** — pre-built Push / Pull / Legs split; each day shows "last trained X days ago"
- **Progressive overload nudges** — if you hit all your reps last time, the app suggests +2.5 kg
- **Progress charts** — strength curve per exercise (PRs starred), weekly volume by muscle group, GitHub-style consistency calendar
- **History** — expandable workout log with per-set detail and filter
- **PIN lock** — 4-digit PIN so nobody reads your data over your shoulder
- **Installable PWA** — add to home screen, works offline for the app shell

## Tech

- Node.js 22+ + Express
- SQLite via Node's built-in `node:sqlite` (no native compilation, zero deps)
- Vanilla JS / CSS on the frontend with Chart.js via CDN
- Service worker caches the app shell

## Local development

```bash
npm install
npm start
# http://localhost:3000
```

The SQLite file defaults to `./data/ironlog.db` and is created on first run, seeded with 20 common exercises and one sample program (PPL).

## Deploy to Railway

1. Create a new Railway project and connect this repo (or use `railway up`).
2. Railway detects the `Dockerfile` automatically.
3. **Add a persistent volume** mounted at `/data` so the SQLite DB survives deploys:
   - In the service settings → **Volumes** → **New volume**
   - Mount path: `/data`
4. **Environment variables** Railway sets `PORT` automatically. The `DB_PATH` is already set to `/data/ironlog.db` in the Dockerfile.
5. Railway gives you a public URL. Open it on your phone → Share → Add to Home Screen and IronLog installs as a PWA.

## Adding your own exercises

Via the API:

```bash
curl -X POST https://<your-app>.up.railway.app/api/exercises \
  -H 'Content-Type: application/json' \
  -d '{"name":"Cable Crossover","muscle_group":"chest","notes":"high to low"}'
```

`muscle_group` is free-form, but stick to `chest`, `back`, `shoulders`, `arms`, `legs` if you want them color-coded in the weekly volume chart.

## Data model

- `exercises` — library of movements
- `programs` → `program_days` → `program_day_exercises` — your training splits
- `workouts` — one per session, with `started_at` / `finished_at`
- `sets` — weight/reps/unit for each logged set
- `personal_records` — auto-updated on every set (keyed on exercise + reps)

## Health check

`GET /health` → `{ "status": "ok", "uptime": <seconds> }` — point Railway's healthcheck at this.
