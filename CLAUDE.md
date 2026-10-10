# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start                 # node server.js on PORT (default 3000)
npm run dev               # node --watch server.js
npm test                  # node --test — 94 tests across the seven *.test.js files
node --test pr.test.js    # one file
node --test --test-name-pattern="assisted"   # one test by name
node --check public/workout.js               # syntax-only check (pre-approved in .claude/settings.json)
```

Run a throwaway instance against a copy of the DB, never the real one — and **from the repo root**, because `db.js` resolves its seed data relatively. Note the `C:/` drive letter: Node does **not** understand Git Bash's `/c/tmp/...`, it resolves that drive-relative to `C:\c\tmp\...` and silently creates a database there instead (harmless but not where you are looking, and it has littered that path before):

```bash
DB_PATH=C:/tmp/ilaudit/db/audit.db PORT=3111 node server.js
```

`scripts/build-exercise-library.js` is a one-shot that regenerates `vendor/exercise-library.json` from an external dataset. Only run it when refreshing that dataset.

## Hard rules

- **Never read, write, copy over, or delete `data/ironlog.db`.** That is the user's real training history, and there is one copy of it. Anything that needs a live server gets its own `DB_PATH`.
- **`public/sw.js` `VERSION` and `public/bugreport.js` `SW_VERSION` must be bumped together** on any frontend change that alters behaviour. They are two hand-maintained string literals that must match: the first decides whether phones fetch new code, the second labels every bug report. A frontend fix shipped without the bump reaches nobody. The one exception is a change that cannot affect behaviour — a comment or a doc fix — where a bump would force every phone to re-download ~860 KB to receive nothing; `7d4c23c` is an example, so don't read it as the rule being broken. If in doubt, bump: a needless re-download is cheap, a fix that never arrives is not.
- **Line endings are mixed and there is no `.gitattributes`.** `core.autocrlf=true`, so `public/workout.js`, `progress.js`, `programs.js` and `history.js` are CRLF in the working tree while everything else is LF. A patch written with the wrong ending silently fails to match, or lands a file in mixed endings. Use the helper at `C:/tmp/ilaudit/patch.py`, which detects the file's own ending, asserts the match count, and writes back in kind.
- **Commit and push after every change without asking.** This is the user's standing instruction for this repo specifically (it overrides the global "never commit unless asked").

## Architecture

### Request pipeline (`server.js`)

Mount order is load-bearing — three different auth gates, and everything before the session gate is deliberately before it:

1. `/health` — unauthenticated probe.
2. `/api/auth` — login must work without a session.
3. `/api/plated` — machine-to-machine, authenticated by **per-profile API key** (`platedAuth`, `X-API-Key` or `Bearer`), never a cookie.
4. `/api/orbit` — read-only cross-profile admin feed, gated by `ORBIT_API_KEY` (localhost-only when unset).
5. `/api/bug-report` — `optionalProfile`: attaches a profile if a session exists, never rejects, because lock-screen errors must still report.
6. `app.use('/api', requireProfile)` — **everything below is session-gated and scoped to `req.profileId`**.
7. JSON 404 for unknown `/api/*` paths, then static `public/`, then the SPA catch-all.

The global error handler funnels 5xx into `recordBugReport()`, so a flapping 500 is deduped on a 5-minute window rather than inserting a row and POSTing Orbit per request.

### Data layer (`db.js`, ~2000 lines)

One file holds the schema, every migration, and the seed data. `init()` runs on **every boot** and each step must stay idempotent — `columnExists()`/`tableExists()` guards, an `ALTER TABLE` loop keyed on column presence, then `migrateMultiUser()`, `seed()`, and the calorie recalcs. Consequence worth knowing: **you cannot learn the live schema by reading the file top to bottom**, because later functions reshape what the `CREATE TABLE` statements declare. Check against a real DB.

`node:sqlite` (`DatabaseSync`), WAL + `synchronous=NORMAL`, foreign keys on. `tx(fn)` wraps BEGIN/COMMIT/ROLLBACK.

Multi-user shape: `profiles`, `sessions`, and a `profile_id` column on every per-user table. **`exercises` is shared across all profiles** (one "Bench Press" for everyone), which is why edits to a shared exercise sit behind `ADMIN_CODE`. Legacy single-user rows carry `profile_id = 0` and are adopted by the first profile created.

### Frontend (`public/`)

No framework, no build step, no bundler. `public/package.json` is `{"type": "module"}` so the browser modules parse as ESM under Node too (that is how `utils.test.js` imports `utils.js`), while the **server is CommonJS**. Modules render by building HTML strings and assigning `innerHTML` — so **every piece of user data must go through `escapeHtml()`**.

- `app.js` — entry point. Tab routing over four `<section>` views, lock screen, service-worker update prompt, boot. `boot()` re-runs on every unlock, so one-time wiring sits behind the `booted` flag.
- One module per tab: `workout.js` (191 KB, the bulk of the app), `programs.js`, `progress.js`, `history.js`; plus `settings.js`, `utils.js`, `api.js`, `audio.js`, `bugreport.js`.
- Cross-module calls go through DOM custom events (`ironlog:switch-tab`, `ironlog:unauthorized`, `ironlog:lock`, `ironlog:serving-cached`, `ironlog:back-online`) rather than imports, to avoid cycles back into `app.js`.
- `api.js` wraps `fetch`: 30 s timeout, one silent retry on 502/503/504 **for idempotent methods only**, 401 fires `ironlog:unauthorized`, and only genuine 5xx are reported as bugs.
- `sw.js` is network-first for the shell *and* for `/api` (`API_CACHE`, 120 entries, LRU-trimmed, excluded from the version wipe so the first launch after a deploy still has a fallback). A cached answer is tagged `X-Ironlog-Cached` so the UI can say it is showing stale data instead of pretending it is live. `/api/auth/` is deliberately never cached.
- Offline writes queue in a localStorage outbox in `workout.js` and replay on reconnect.

### Integrations

- **Plated** (nutrition) — `routes/plated.js`. Per-profile API key; `CONTRACT_VERSION` is returned in the payloads Plated actually fetches so it can detect capabilities without a version negotiation.
- **Orbit** (admin dashboard) — `routes/orbit.js` read feed, and `lib/orbitReport.js` forwards bug reports outbound (15 s timeout, one retry on transport failures and 502/503/504, because Orbit sleeps on Railway and a cold start outlasts a short timeout).
- Bug reports: `lib/bugReports.js` is the single pipeline — dedupe, insert locally, then forward. It never throws, so callers can respond immediately.

## Invariants that are easy to break

These are the ones where a locally correct change breaks something held elsewhere:

- **`sets.load_multiplier` is a snapshot** taken at log time. Never recompute a historical set's effective load from the exercise's *current* `weight_mode` — flipping an exercise between per-arm and combined would rewrite history. Use `effectiveLoadKgSql()` from `db.js` (SQL) or the per-row `COALESCE(load_multiplier, CASE WHEN weight_mode = 'per_arm' THEN 2 ELSE 1 END)` fallback.
- **Effective load**: assisted → `max(0, bodyweight - logged)` (less assistance is better, so PR ranking inverts to ASC); bodyweight → `logged + bodyweight`; otherwise `logged x load_multiplier`. 1RM is Epley: `w x (1 + reps/30)`.
- **Warmups (`is_warmup = 1`) never count** toward PRs, volume, or calories. A rebuild that forgets this resurrects a warmup as a best set.
- **Two opposite timezone conventions.** `/api/*` takes `?tzOffset=` as minutes **east** of UTC (`-getTimezoneOffset()`); `/api/plated/*` takes `?tz=` as the **raw** `getTimezoneOffset()` (NZ sends `-720`). Plated routes now accept both. Getting the sign wrong buckets a workout on the wrong day, which is invisible until a chart looks odd.
- **`PATCH /api/sets`** distinguishes `bodyHasSides` (the key is present) from `sidesDriveReps` (a side value is non-null). Collapsing them means an explicit `reps_r: null` vetoes a plain `reps` edit and the edit silently does not save.
- **CSP is `script-src 'self'`** — no CDN, no inline `<script>`. Chart.js is vendored at `public/chart.umd.min.js`. `'unsafe-inline'` exists for `style-src` only.
- Activity sessions (`kind = 'activity'`) are not gym attendance; they are excluded from streak/calendar/"active today" unless `counts_as_workout = 1`.
- **Value rules live in a leaf module under `lib/`, never inside a route.** This has now been learned twice, so treat it as the default for any new validated field. `lib/setBounds.js` (`validateSetNumerics`) is shared by `routes/sets.js` and `routes/import.js`; `lib/activityFields.js` (`cleanActivityFields`) by `routes/workouts.js` and `routes/import.js`. Both started as constants local to a route, and both times the backup restore silently bypassed every bound the UI enforced. Same rules, different reaction: the live route 400s; the restore skips-and-counts for a set (a bogus set poisons that exercise's PRs forever) and clamps-and-counts for an activity (its identity is "I played squash on Tuesday", not its duration, so dropping the session loses more).
- **A shared parser with two callers needs a test per caller, not per parser.** Adding `activity_label` meant threading a field through `parseActivityBody`; the POST was updated and the PATCH was not, so every activity edit 500'd while 88 tests stayed green. `activity.test.js` exists for that reason.
- **`export` must cover everything deleting a profile deletes.** The delete reads `accounts.PER_PROFILE_TABLES`; `backup.test.js` derives its assertion from that same list, so adding a per-profile table fails the suite until it is either exported or added to `EXPORT_EXEMPT` with a reason. Don't satisfy it by editing the exemption list without one.
- **Bodyweights hold one row per profile per local day**, in all three writers (`POST /api/bodyweight`, `POST /api/plated/bodyweight`, and the import's upsert). `bodyweights.source` ('manual' | 'plated') decides who may overwrite what — a human editing the weight takes ownership, and Plated then leaves that day alone. Never key that distinction off the note text again.
- **Exercise names are globally UNIQUE and `created_by_profile_id` means private.** Resolving an exercise by name alone can cross profiles, which on restore attaches one person's sets to another's private row and then fabricates a PR for them when `personal_records` is recomputed.

## Browser testing

A zero-dependency CDP harness lives outside the repo at `C:/tmp/ilaudit/`: `cdp.js` (DevTools Protocol over Node's global `WebSocket`), `lib.js` (`boot()` navigates and unlocks with passcode 1234, `tab(s, name)` taps a nav tab, `done(s)` dumps JS errors and network failures), and `launch-chrome.sh` (port 9222, its own Chrome profile — quote the path and use forward slashes, or Chrome silently attaches to the user's own profile).

Four traps that have each produced a wrong conclusion here:

- **CDP offline emulation does not reach service-worker fetches.** `Network.emulateNetworkConditions` leaves SW-mediated GETs working, so "it works offline" was claimed for a week and was false. To test offline reads, **stop the server** with the page already warm.
- **`iphone()` turns touch emulation off** and drives with a mouse. Any gesture test must re-enable `Emulation.setTouchEmulationEnabled` and use `Input.dispatchTouchEvent` — a mouse drag passes where a real thumb fails.
- **Chrome's emulated viewport includes a 15 px classic scrollbar** a real iPhone lacks. Inject `html::-webkit-scrollbar{width:0}` before measuring widths.
- **Keep a stateful UI flow inside one driver script.** Split across scripts, the sheet closes between them and every element reads as invisible — which looks exactly like a bug.

## Docs

`README.md` covers setup, deploy (Railway + a volume at `/data`), and the public API surface.

`ARCHITECTURE.md` is a long plain-language walkthrough of *why* the app is shaped the way it is — tracked, and refreshed on 3 Oct 2026 against commit `0ebacf5`. Read it before a change that crosses subsystems; §8 is an honest list of the known weaknesses, and §5.4 explains the three separate offline problems. This file (`CLAUDE.md`) holds the rules and traps; that one holds the reasoning. Where either disagrees with the code, the code wins — check the date at the top.
