# IronLog

A mobile-first PWA gym tracker. Log workouts with sweaty hands, follow Day A/B programs, and watch your strength progress over time.

## What it does

- **Fast logging** — sets pre-fill from your last session; big +/- buttons; one-tap confirm
- **Programs** — pre-built Push / Pull / Legs split; each day shows "last trained X days ago"
- **Progressive overload nudges** — if you hit all your reps last time, the app suggests +2.5 kg
- **Progress charts** — strength curve per exercise (PRs starred), weekly volume by muscle group, GitHub-style consistency calendar
- **History** — expandable workout log with per-set detail and filter
- **Multi-user** — each person logs in with a 4-digit passcode and gets their own workouts, body weight, profile and Plated API key; the exercise library and program templates are shared
- **Installable PWA** — add to home screen, and genuinely usable with no signal: all four tabs render from the last-known data, and sets you log are queued and sync when you are back

## Tech

- Node.js 22+ + Express
- SQLite via Node's built-in `node:sqlite` (no native compilation, zero deps)
- Vanilla JS / CSS on the frontend with Chart.js via CDN
- Service worker caches the app shell and the last-known API responses (network-first, so a reachable server always wins)

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

## Accounts & auth

- `profiles` — one per person: name, accent colour, scrypt-hashed passcode, and a unique API key
- Logging in with a 4-digit passcode mints a 30-day session (random token in an HttpOnly cookie). Every `/api/*` route requires it and is scoped to `req.profileId`.
- Each profile's API key authenticates the Plated integration (`X-API-Key` or `Authorization: Bearer`) and returns only that profile's data. Manage / regenerate it in Settings → Plated API key.
- On upgrade from the old single-user database, the first profile created adopts all existing data and inherits the previously active Plated key, so the integration keeps working with no changes on Plated's side.

## Data model

- `exercises` — shared library of movements; each carries a `sub_muscle` (e.g. upper/mid/lower pec, front/side/rear delt, lats vs upper back) and a `met` used for the calorie estimate. A row with `created_by_profile_id` set is **private** to that profile; names are globally unique
- `programs` → `program_days` → `program_day_exercises` — per-profile training-split templates; every account is seeded its own editable copy of the defaults on signup
- `workouts` — one per session (per profile), with `started_at` / `finished_at`. `calories_burned` is estimated per-exercise: Σ MET × bodyweight × effective set time (not session duration)
- `sets` — weight/reps/unit for each logged set (per profile)
- `personal_records` — auto-updated on every set (keyed on profile + exercise + reps). A cache: rebuilt from `sets`, and deliberately not restored from a backup
- `bodyweights` — one entry per profile per local day, enforced by all three writers (the app, the Plated push, and the backup restore). `source` is `'manual'` or `'plated'` and decides who may overwrite what: editing the weight by hand takes ownership of that day, and Plated then leaves it alone
- `notes` — a per-profile notes/ideas list, included in the backup

### Plated integration endpoints (per-profile, API-key auth)

- Reads: `GET /api/plated/profile` · `GET /api/plated/bodyweight` · `GET /api/plated/workouts/calories` · `GET /api/plated/workouts/recent` · `GET /api/plated/summary` · `GET /api/plated/whoami`
- Writes: `POST /api/plated/bodyweight {weight_kg, date?}` — lets a caller push body weight into IronLog. Re-pushing the same day corrects that day's Plated-sourced entry (idempotent). If the day already holds a **manual** weigh-in, the push writes nothing and says so (`{ updated: false, skipped: "..." }`) — a weight the user typed here is theirs, and inserting alongside it would leave two readings for one day. `POST /api/plated/profile` — writes back the profile fields Plated also collects (`height_cm`, `birth_year`, `sex`, `activity_level`, `goal`), so the user enters them once in either app.
- `GET /api/plated/summary` is `profile` + `calories` + `recent` + `bodyweight` in one round trip, plus a `resolved` block echoing the local date and tz offset it settled on — so the caller can confirm the bucketing agrees rather than re-deriving it.
- **Timezone:** `calories`, `recent` and `summary` accept `tz=<minutes>` (JS `Date.getTimezoneOffset()` convention, e.g. NZ at UTC+12 sends `tz=-720`) so workouts are bucketed by the caller's LOCAL calendar day instead of UTC. `tzOffset=<minutes>` is also accepted and is the OPPOSITE sign — minutes east of UTC, matching the rest of `/api/*` — because that is the spelling every other IronLog route uses. Missing/invalid defaults to UTC, unchanged for existing callers.
- Every payload Plated fetches carries `contract_version` (currently 3) so a caller can tell which shape it is talking to without a round trip. A deployment too old to have it simply omits the field, so `undefined` means "assume the oldest shape".
- `calories_estimated` / `calories_source` say whether a day's figure was measured per-exercise or fell back to the flat 4 kcal/min estimate. `tdee_includes_workouts` on `profile` says whether `tdee_kcal` already prices in training — when true, adding `workouts/calories` on top double-counts.

## Health check

`GET /health` → `{ "status": "ok", "uptime": <seconds> }` — point Railway's healthcheck at this.
