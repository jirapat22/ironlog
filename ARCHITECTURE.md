# IronLog — Architecture

> Refreshed 3 October 2026, for the version at commit `0ebacf5`. Previously written against `a071b16` (August), 63 commits earlier. If something here contradicts the code, the code is right — check the date on this file.
>
> **Scope:** this file explains *why* the app is shaped the way it is, for a human reading it cold. `CLAUDE.md` is the short operational companion — the commands, the invariants, and the traps that make an edit silently fail. Rules live there, not here.
>
> **How to read this:** every section starts with a plain-language explanation and a worked example, then goes into the technical detail. If you only want the concepts, read the *"In plain terms"* boxes and the examples and skip the rest.

---

## 1. What it is

IronLog is a phone-first web app for tracking gym workouts. You follow a program (Push/Pull/Legs, Upper/Lower, etc.), log each set with big thumb-sized +/− buttons, and the app tells you what to lift next based on what you managed last time.

It's built as one small server program that keeps all its data in a single file on disk. It's installed on a phone like an app (via "Add to Home Screen"), but it's really a website.

It supports a handful of people — each person has a 4-digit passcode and their own workouts, programs, and body weight. The *list of exercises* is shared between everyone, since "Bench Press" means the same thing to all of them.

Beyond logging, it suggests weight increases, tracks personal records, draws progress charts, estimates calories burned, exports a training log you can hand to a coach, and talks to two other apps (Plated for nutrition, Orbit for admin).

---

## 2. Stack

> **In plain terms:** most modern web apps are assembled from hundreds of third-party building blocks. IronLog uses **three**. Everything else is either written by hand or built into Node.js itself. This is a deliberate choice: fewer moving parts means less to break, less to update, and no "build step" — the code you write is the code that runs.

| Dependency | What it does *here* |
| --- | --- |
| `express` ^4.21 | The web server. It's what turns "someone visited `/api/sets`" into "run this function." `server.js` wires up 15 groups of endpoints and serves the app's files. |
| `compression` ^1.8 | Squeezes responses before sending them over the network. Matters more than usual here because the app re-fetches its own shell on every cold launch (network-first, see §5.4), so that ~860 KB of HTML/CSS/JS travels a lot. Brotli was benchmarked and rejected: the quality level worth having costs ~180 ms synchronously on the largest asset. |
| `web-push` ^3.6 | Sends the rest-timer notification to your phone even when the app is closed. |
| **`node:sqlite`** (built into Node) | The database. This is *why* the dependency list is so short — Node 22+ ships a database driver, so IronLog doesn't need an external one. No compilation step, which is why the Dockerfile is 6 lines. |
| **Chart.js** (vendored) | Draws the progress graphs. The file is committed directly into the repo at `public/chart.umd.min.js` rather than downloaded from the internet at page load — partly for offline support, partly because the app's security policy (`script-src 'self'`) blocks loading code from other domains. |

**On the front end there is no framework at all** — no React, no Vue. The browser code is plain JavaScript that builds HTML as text strings and drops it into the page. This is unusual for an app this size and is the main reason `public/workout.js` is 187 KB: without a framework to split things into components, related behavior piles into one file. Because HTML is assembled as strings, every piece of user data has to pass through `escapeHtml()` by hand — there is no framework escaping it for you.

**Testing:** 80 automated tests run with `node --test`. They cover the maths-heavy parts — personal records (against a real in-memory database, not mocks), mislog detection, calorie estimates, unit conversions and set-picking — plus, since October, the backup/restore route end to end over real HTTP (`backup.test.js`). Still zero tests for browser code — see §8.5.

---

## 3. Directory map

> **In plain terms:** the code splits along two lines. On the server, one file per *kind of thing* (workouts, exercises, programs). On the phone, one file per *tab at the bottom of the screen* (Workout, Programs, Progress, History).

```text
.
├── server.js              Start-up file. Sets up security headers, decides which
│                            URLs need a login, connects everything together.
├── db.js          (103KB) The database: table definitions, upgrades, and the
│                            131 built-in exercises. Biggest file here. See §4.
├── auth.js                Checks "is this person logged in?" on every request.
├── accounts.js            Creating profiles, hashing passcodes, managing logins.
├── pr.js                  Recalculates personal records after an edit or delete.
├── calories.js            Estimates calories burned from sets and activities.
├── push.js                Phone notification plumbing.
│
├── routes/                One file per type of data. Each defines its URLs.
│   ├── auth.js              login / create profile / logout / change passcode
│   ├── exercises.js (32KB)  the exercise catalog
│   ├── programs.js  (22KB)  training templates: programs → days → exercises
│   ├── workouts.js  (39KB)  workout sessions, finishing, history, trends
│   ├── sets.js      (21KB)  logging a set — the busiest code path in the app
│   ├── progress.js  (21KB)  all the charts and analytics
│   ├── plated.js    (30KB)  nutrition-app integration (logs in with a key, not a
│   │                          passcode). Grew most since August — see §9.
│   ├── orbit.js             admin dashboard feed
│   ├── export.js / import.js   backup download + restore, and the coach-friendly log
│   └── bodyweight, notes, push, settings, bugReport
│
├── lib/                   Logic pulled out of routes so it can be reused/tested.
│   ├── improved.js          Works out "did you beat last session?" for each set.
│   ├── mislog.js    (12KB)  Spots sets whose weight is out of all proportion to
│   │                          your own history — a fat-fingered 850 kg would
│   │                          otherwise become your best set and poison every
│   │                          later suggestion. 28 tests, the best-covered file.
│   ├── bugReports.js        Catches errors, removes duplicates, forwards to Orbit.
│   ├── orbitReport.js       The actual outbound call to Orbit.
│   └── exerciseLibrary.js   Searching the big reference exercise dataset.
│
├── public/                Everything the phone downloads. Served as-is, no build.
│   ├── index.html           The only HTML page. Four empty sections the tabs fill in.
│   ├── app.js       (21KB)  Start-up: tab switching, lock screen, update prompts,
│   │                          and the offline fallback path (see §5.4).
│   ├── api.js               All server communication funnels through here.
│   ├── utils.js     (91KB)  Shared helpers + the exercise edit forms.
│   ├── workout.js  (187KB)  THE big one — the active workout screen and everything
│   │                          on it, including the offline set outbox.
│   ├── progress.js  (87KB)  Charts, calendar, muscle coverage.
│   ├── history.js   (51KB)  Browsing and editing past workouts.
│   ├── programs.js  (38KB)  Building and editing training templates.
│   ├── settings.js  (37KB)  Settings, export/import, profile management, and the
│   │                          two "check my data" tools (unit mix-ups, mislogs).
│   ├── style.css   (101KB)  All the styling. Third-largest file in the repo.
│   ├── sw.js                "Service worker" — makes the app installable and
│   │                          readable offline. Its VERSION must be bumped on
│   │                          every release (see §8.7 — this is a known trap).
│   └── chart.umd.min.js     The vendored charting library.
│
├── vendor/exercise-library.json   762 KB reference dataset used to fill in
│                                    exercise instructions automatically. In
│                                    vendor/ and not data/ because data/ is
│                                    gitignored and this file must ship.
├── data/                  Not in git. The database file and notification keys.
│                            In production this is a Railway "volume" (a disk
│                            that survives redeploys).
├── CLAUDE.md              Operational notes for working in this repo: commands,
│                            the invariants that break quietly, the testing traps.
└── Dockerfile             6 lines. Describes how to package the app for the server.
```

---

## 4. Data model

### How the database is defined

> **In plain terms:** most projects describe their database in one place, and change it through numbered "migration" files that each run exactly once. IronLog doesn't. It re-runs *all* its setup instructions every single time the server starts, and each instruction checks "have I already done this?" before acting.
>
> **Example:** the instruction to add a `rep_min` column to exercises reads roughly *"if the exercises table doesn't already have a column called rep_min, add one."* On a brand-new database it adds it. On the live database, where it was added months ago, it looks, sees it's there, and does nothing. Run it a thousand times, same result.

That's `db.js`'s `init()`, which runs on every boot and does three things:

1. **Create the original tables** — 15 `CREATE TABLE IF NOT EXISTS` statements.
2. **Add every column invented since** — ~40 guarded `ALTER TABLE ... ADD COLUMN` calls.
3. **Fill in the built-in data** — the 131 standard exercises and their classifications.

Two tables (`app_settings`, `personal_records`) needed a change SQLite can't do with `ALTER` — changing the primary key. Those get a create-new / copy-everything-over / delete-old / rename dance inside a transaction (`db.js:468-506`).

> ⚠️ **The catch:** the `CREATE TABLE` statements at the top of the file do **not** describe the database as it is today. Measured against a freshly initialised database: `sets` is declared with **10** columns and actually has **19**; `exercises` is declared with **5** and has **19**; `workouts` ends up with **20**. To know what a table really looks like you have to read the creation statement *and* mentally apply 400 lines of later additions. This is a genuine readability problem — see §8.3.
>
> The cheap way to answer "what columns does this table have?" without guessing, and without going near the real database:
>
> ```js
> process.env.DB_PATH = ':memory:';
> const { db, init } = require('./db');
> init();
> console.log(db.prepare('PRAGMA table_info(sets)').all());
> ```

### The tables, and why they're shaped that way

**`profiles`** — one row per person. Name, accent colour, and the passcode stored as a *scrypt hash* with a random per-person salt. Also `is_owner`: exactly one profile is the owner, and the owner can edit shared exercises without typing the admin code (everyone else needs it). Delete the owner and the flag is inherited by another profile rather than left dangling.

> **In plain terms:** the app never stores your actual passcode. It stores the result of scrambling it in a way that can't be reversed. When you log in, it scrambles what you typed and compares the two scrambles. Even someone with full database access can't read your passcode out of it.

**`sessions`** — proof you're logged in. A long random string (the "token") paired with your profile. Lives 30 days.

**`meta`** — global settings that belong to the *app*, not to any person. It exists because of a real bug: certain setup flags were originally stored per-person, which meant the first person to sign up "adopted" them and they never ran again for anyone else.

**`exercises`** — the shared catalog, and the most conceptually loaded table:

- `muscle_group` — a strict list: chest, back, shoulders, biceps, triceps, forearms, legs, core. Anything else is rejected.
- `sub_muscle` — the finer detail, e.g. "upper chest", "long head".
- `secondary_muscles` — other muscles the exercise also works, stored as a list.
- `secondary_major` — a *shorter* list: which of those get worked hard enough to really count.

> **Example — why two lists:** a Bench Press primarily works your chest. It also works your front shoulders and triceps meaningfully, and your forearms a tiny bit just from gripping the bar.
>
> - `secondary_muscles` = `["front delt", "triceps", "lateral head"]` — everything it touches. Used for "when did I last train my triceps?"
> - `secondary_major` = `["front delt"]` — only what's worked hard enough to count toward "have I hit shoulders twice this week?"
>
> Without the split, gripping a bar would count as a forearm workout.
>
> There's a third state that matters: if `secondary_major` is **empty**, that means "credit nothing." If it's **not set at all**, that means "we haven't classified this yet — credit everything," which is the old behaviour kept for exercises that predate the feature. Empty and unset look similar but mean opposite things.

- `weight_mode` — `per_arm` or `combined`. Whether the number you type is one hand's weight or the total. (This one is subtle enough to have its own section below.)
- `is_bodyweight` / `is_assisted` — these flip the maths. An assisted pull-up machine *takes weight off you*, so more weight on the stack means it's **easier**. Effective load is `your bodyweight − assistance`, the reverse of every other exercise.
- `created_by_profile_id` — empty means "built-in, shared by everyone"; filled in means "someone's personal custom exercise, only they can edit it."
- `classification_customized` — a flag meaning "a human deliberately set this exercise's muscle group." Essential, because the built-in setup instructions re-run on every boot and would otherwise overwrite deliberate edits. See §8.2.

**`programs` → `program_days` → `program_day_exercises`** — the template hierarchy.

> **Example:** a program called "Push/Pull/Legs" contains three days. The "Push" day contains Bench Press (3 sets × 8), Overhead Press (3 × 10), and so on. Each of those slots stores the *prescription* — how many sets and reps you're aiming for on that day — which is separate from the exercise's own preferred rep range.

Only `programs` records who owns it; days and exercises inherit ownership through their parent, and are automatically deleted with it.

**`workouts`** — one row per gym session. Also handles non-gym sessions (a run, a class) via `kind = 'activity'`, which reuse the same table so they show up on the consistency calendar for free.

Two fields worth understanding:

- `bw_kg` — a **snapshot of your body weight**, taken when you finish the workout.

  > **Why:** if you do 10 pull-ups at 80 kg bodyweight, that's 800 kg of work. If the app looked up your *current* weight every time it drew a chart, then losing 5 kg would silently rewrite last year's pull-up numbers downward. Freezing the value at finish time means history stays true.
  >
  > **Gotcha:** it's empty for the whole time a workout is still in progress, since you haven't finished yet. Code that runs mid-workout has to handle that — this caused a real bug (see the fallback in `lib/improved.js`).

- `exercise_list` — a saved copy of the workout's exercise list after mid-session swaps. Exists because this used to be stored only on the phone, and iPhones clear that storage aggressively — people would swap an exercise, background the app, come back, and find their swap undone.

Three more added since August:

- `counts_as_workout` — an activity (HIIT, boxing, a hard class) can be real training rather than secondary cardio. This opts one specific logged activity into counting toward the consistency calendar's streak like a strength session. Defaults to 0, so nothing changed retroactively.
- `created_at` — when the row was *really* made, as opposed to `started_at`, which a backdated session deliberately sets days in the past. "Is this workout still in progress?" is a question about the former; using `started_at` meant a backdated session could never be recovered. Left NULL on old rows, and every reader falls back to `started_at` — which is what those rows already meant.
- `is_backdated` — marks a session logged for an earlier day (up to a week back), so the UI can show the real date rather than implying you trained just now.

**`sets`** — the core record: weight, unit, reps, attached to a workout.

> **Why sets attach to the workout and not the program slot:** a set has to outlive its template. You might swap an exercise mid-workout, delete the whole program next month, or do a quick unplanned session with no program at all. In every one of those cases, the set still describes something that genuinely happened in a gym. Attaching it to the *workout* means it only depends on facts that can never be retracted. Deleting a program can never delete your history.

Notable columns:

- `load_multiplier` — the per-arm doubling factor (2 or 1), **frozen at the moment you logged the set**. Covered in detail below.
- `reps_r` / `reps_l` — optional per-side reps, for when your right arm gets 9 and your left gets 7. When both are filled in, the main `reps` value is forced to the *weaker* side, so every calculation downstream keys off the honest number without needing to know these columns exist.
- `is_warmup` — warm-ups count as done but never toward personal records, volume, calories or progression. It is a *toggle*, not a property set at log time: tapping the set number flips it afterwards, which is why several code paths have to re-dress a row they have already drawn.
- `unit_reviewed` / `weight_reviewed` — "I have looked at this set and it really is that heavy / really is in those units." Both exist so the two data-checking tools (§5.3) stop asking about a set you have already confirmed, and so a confirmed outlier starts counting toward your best-ever instead of being held back.
- `form_flag` — "I hit the reps but my form fell apart." The set counts, but the app won't suggest a weight increase off it.
- `rir` — "reps in reserve," how many more you could have done.
- `rpe` — **dead column.** Nothing writes it any more; old rows have leftover values (often 0) that the export code deliberately ignores so a coach doesn't read "RPE 0/10" as real.

**`personal_records`** — a *cache*, rebuilt from raw sets whenever anything changes.

> **Example:** it's keyed by rep count, so 100 kg × 5 reps and 90 kg × 8 reps are **both** personal records, stored separately. That's intentional — they're different achievements. `set_id` records exactly which set holds each record, because matching on the numbers alone meant that any later set *tying* your record also showed the trophy badge.

**Also:** `bodyweights`, `app_settings`, `push_subscriptions`, `notes`, `bug_reports`. Fifteen tables in total.

`bug_reports` is worth one line: both the browser and the server write to it through a single pipeline (`lib/bugReports.js`), which drops duplicates inside a 5-minute window before storing them and forwarding to Orbit. That dedupe is what stops a 500 that fires on every request from inserting a row and making an outbound HTTP call each time.

### The weight_mode / load_multiplier problem — worked example

This is the most interesting design decision in the codebase, so here it is concretely.

You do an Incline Dumbbell Press holding a 20 kg dumbbell in each hand. What do you type into the app — `20` or `40`?

IronLog says: type `20` (one dumbbell), and it marks the exercise `weight_mode = 'per_arm'` so it knows to double the number when calculating how much work you did. Your volume counts as 40 kg per rep.

**Now the trap.** Suppose that setting is wrong — the exercise is marked `per_arm` but you've been typing `40` (the combined total) all along. The app doubles it to 80 kg. Every volume chart for that exercise has been **twice the truth** for months, with nothing visibly wrong on screen.

**The naive fix makes it worse.** If the doubling factor were only ever read from the exercise's current setting, then flipping that setting to correct it would retroactively rewrite *every historical set* — including all the ones you logged correctly.

**The actual solution:** each set stores its own copy of the doubling factor (`load_multiplier`) at the moment it's created. History becomes immutable — flipping the setting only affects sets logged from that point on.

**And then the human problem:** but sometimes the setting really *was* wrong from day one, and you genuinely want the old sets corrected. So (added in `a071b16`) flipping the toggle asks: *"Fix past sets too?"* — an explicit, opt-in choice, scoped to only your own sets, since the exercise catalog is shared and someone else may have been logging it correctly all along. The same repair is reachable from History (`d6ed32b`) for when you notice while looking at the bad session rather than while editing the exercise, and the conversion now corrects the *stored number* too, not just the multiplier (`cef8505`).

### Entity relationship diagram

```mermaid
erDiagram
    profiles ||--o{ sessions : "logs in via"
    profiles ||--o{ programs : owns
    profiles ||--o{ workouts : owns
    profiles ||--o{ sets : owns
    profiles ||--o{ bodyweights : owns
    profiles ||--o{ personal_records : owns
    profiles ||--o{ app_settings : owns
    profiles ||--o{ push_subscriptions : owns
    profiles ||--o{ notes : owns
    profiles |o--o{ exercises : "may author (else shared)"

    programs ||--o{ program_days : contains
    program_days ||--o{ program_day_exercises : contains
    exercises ||--o{ program_day_exercises : "referenced by"

    program_days |o--o{ workouts : "templates (survives deletion)"
    workouts ||--o{ sets : contains
    exercises ||--o{ sets : "performed as"
    exercises ||--o{ personal_records : "tracked for"
    sets |o--o| personal_records : "may hold record"

    exercises {
        int id PK
        string name UK
        string muscle_group "strict list"
        string sub_muscle "e.g. upper chest"
        string secondary_muscles "also-worked list"
        string secondary_major "worked-hard subset"
        string weight_mode "per_arm | combined"
        int is_bodyweight
        int is_assisted "more weight = easier"
        real met "for calorie estimate"
        int created_by_profile_id "empty = shared"
        int classification_customized "protects manual edits"
    }

    workouts {
        int id PK
        int profile_id FK
        int program_day_id FK "nullable"
        string kind "strength | activity"
        string started_at
        string finished_at "empty = in progress"
        real bw_kg "frozen at finish"
        string exercise_list "survives phone storage wipe"
        int calories_burned
        int counts_as_workout "activity that counts as training"
        string created_at "real creation time vs backdated start"
        int is_backdated
    }

    sets {
        int id PK
        int profile_id FK
        int workout_id FK
        int exercise_id FK
        real weight
        string weight_unit "kg | lbs"
        int reps "= weaker side if per-side"
        int reps_l "nullable"
        int reps_r "nullable"
        int load_multiplier "FROZEN doubling factor"
        int is_warmup "toggleable after the fact"
        int form_flag "hit reps, form broke"
        int rir "reps in reserve"
        int unit_reviewed "kg/lbs confirmed by a human"
        int weight_reviewed "weight confirmed by a human"
    }

    personal_records {
        int id PK
        int profile_id FK
        int exercise_id FK
        int reps "one record per rep count"
        real weight
        int set_id FK "which set holds it"
    }
```

---

## 5. What happens when you log a set

> **In plain terms:** this is the app's most-used action, and it touches almost every interesting mechanism — so it's the best single thing to follow end to end. Below is the same journey told twice: once in plain language, then with the actual file names and functions.

### 5.1 The plain-language version

You've done your set. You tap the ✓ button.

1. The app reads what's in the weight and reps boxes right there on screen.
2. It sanity-checks them. *(Empty reps? Refuse. Weight of 0? Normally refuse — but allow it for pull-ups and assisted machines, where zero is meaningful: zero added weight, or zero assistance, which is the hardest version.)*
3. It greys out the ✓ so you can't accidentally double-tap and log the set twice.
4. It sends the set to the server.
5. The server checks you're logged in, checks this workout is actually *yours*, and checks the numbers are really numbers.
6. It saves the set, then works out two things: **is this a personal record?** and **did you beat last session?**
7. It sends both answers back.
8. Your phone updates just that one row — adding a 🏆 or 📈 badge if earned — without redrawing the whole screen, so nothing jumps around under your thumb. It copies the weight into the next set's box, moves the "you're here" highlight down, and starts your rest timer.

Two details worth knowing:

**Your typing is saved as you go.** Every keystroke is mirrored into the phone's local storage. If your phone locks between sets, or the app gets backgrounded and reloaded, your half-entered set is still there. Once it's saved to the server, that local copy is thrown away.

**The rest timer knows about supersets.** If this exercise is paired with another one, the timer *doesn't* start — because you're supposed to go straight into the partner exercise, and starting a rest countdown would contradict the "go straight into it" text on screen.

### 5.2 The technical version

| # | Where | What happens |
| --- | --- | --- |
| 1 | `workout.js:wireWorkoutView()` | One click handler on the whole screen (not one per row) matches `[data-confirm]` and calls `confirmSet(row)`. |
| 2 | `workout.js:confirmSet()` (line 2417) | Reads values straight from the DOM — for unsaved rows, the DOM *is* the state. Reconciles per-side reps to `MIN(left, right)`. |
| 3 | `api.js:api()` | `POST /api/sets`. Adds a 30-second timeout. Retries once on gateway errors (502/503/504) — **but only for safe methods**; a POST is deliberately excluded, since retrying could create a duplicate set if the first one actually succeeded and only the reply got lost. |
| 3b | `workout.js` outbox | If the request never reached the server at all, the set is parked in a local queue and the row is drawn as logged-but-pending rather than discarded. See §5.4. |
| 4 | `auth.js:requireProfile` | Already ran via `server.js:114`. Read the `il_session` cookie, resolved it to a profile, set `req.profileId`. |
| 5 | `routes/sets.js:129` | The strictest validation in the codebase — because SQLite will happily store the text `"abc"` in a number column if you let it. Verifies the workout belongs to this profile (`WHERE id = ? AND profile_id = ?`), the exercise exists, and every number is a real number *and inside a sane bound* (`65dbcb2` added the bounds, after one absurd row could lock up a workout). |
| 6 | same file | `INSERT INTO sets`, then snapshot `load_multiplier` from the exercise's current `weight_mode`. |
| 7 | `checkAndUpdatePR()` | Estimates a one-rep-max equivalent, **flips the sign for assisted exercises** so "better" means less assistance, applies a 0.1% threshold to avoid rounding-noise records, updates `personal_records`. Warm-ups skip this. |
| 8 | `lib/improved.js` | Finds the most recent *finished* prior session for this exercise, takes its best set, compares. Only the first qualifying set per exercise per session gets flagged. |
| 9 | back in `confirmSet` | Response pushed into `workoutState.loggedSets`, the in-memory mirror. Row patched in place. `cascadePrefillSiblings()`, `moveNextHighlight()`, `refreshProgressionHint()`, `startRestCountdown()`. |

> ⚠️ **The three-render-paths trap.** Because the row is patched *in place* rather than redrawn, any badge must be written into **three** separate places: `setRowHTML()` (full redraw), `reconcileSetRowBadges()` (warm-up toggle), and `confirmSet()`'s in-place patch. Wire it into only one and it silently vanishes the moment a different path runs. This has been a recurring bug. The cause is the lack of a UI framework — normally the framework guarantees the screen matches the data, and here nothing does.

```mermaid
sequenceDiagram
    autonumber
    actor U as You
    participant DOM as set row on screen
    participant W as workout.js<br/>confirmSet()
    participant LS as phone storage<br/>(draft)
    participant API as api.js
    participant GATE as auth check
    participant R as routes/sets.js
    participant PR as PR check
    participant IMP as improved.js
    participant DB as database

    U->>DOM: tap ✓
    DOM->>W: confirmSet(row)
    W->>DOM: read weight / reps / notes
    W->>W: validate (per-side → weaker side,<br/>allow 0 only for bodyweight/assisted)
    W->>DOM: grey out ✓ (no double-tap)
    W->>API: send the set
    API->>GATE: POST /api/sets (+ session cookie)
    GATE->>DB: is this session valid?
    GATE-->>R: yes — here's whose it is
    R->>R: check the numbers are numbers
    R->>DB: is this workout theirs?
    R->>DB: does this exercise exist?
    R->>R: freeze load_multiplier
    R->>DB: save the set
    R->>PR: personal record? (skip if warm-up)
    PR->>DB: update records cache
    PR-->>R: 🏆 yes/no
    R->>IMP: beat last session?
    IMP->>DB: fetch last session's best set
    IMP-->>R: 📈 yes/no
    R-->>API: saved set + both badges
    API-->>W: reply
    W->>LS: discard local draft (server has it now)
    W->>DOM: patch this row only<br/>(badges, prefill next set)
    W->>DOM: update hint + start rest timer
```

### 5.3 Checking your own data for mistakes

> **In plain terms:** the app's advice is only ever as good as what you typed into it. One fat-fingered `850` becomes your best-ever set, and every "add 2.5 kg" suggestion after that is nonsense. Two tools in Settings look for typos you have already made, and they are deliberately shy about it.

Both are manual — a **Check** button in Settings, not a background scan — because a false alarm is worse than a miss here. Being told a genuine PR looks suspicious blocks a suggestion you were relying on.

| Tool | Endpoint | What it looks for |
| --- | --- | --- |
| Unit mix-ups | `GET /api/sets/unit-outliers` | Sets logged in kg that look like lbs figures, or the reverse. Had to learn to recognise a deliberate *changeover* — an early version reported one person switching units permanently as 43 separate mistakes (`25bcfaf`). |
| Mislogs | `GET /api/sets/suspicious` (`lib/mislog.js`) | Two narrow rules: a set more than a few multiples above your credible best-ever, and a **decimal slip** — roughly 10x or 1/10 of your typical working load. The second rule exists separately because a 1/10 slip is *below* your best-ever, so the first rule would never see it. |

Both compare **effective** load (per-arm doubling applied, bodyweight added, assistance subtracted), not the raw number, or a per-arm exercise would look like a mislog against a combined one. Confirming a set sets `weight_reviewed` / `unit_reviewed`, which both stops the nagging and lets that set count toward your best-ever.

A third, different kind of check: `a2c08a3` handles an exercise whose sets are counted two different ways — some logged per-arm, some combined — by explaining the split in plain words and offering to repair it, rather than silently picking one interpretation.

### 5.4 When there is no signal

> **In plain terms:** this app gets used in basement gyms. For a long time it *looked* fine offline — all four tabs would render — right up to the moment you tapped ✓ and got the raw browser text "Failed to fetch", with the set simply gone. Reading and writing offline were fixed separately, and they work differently.

**Reading** (`0256775`): `sw.js` is network-first for `/api` as well as for the app's own files. A successful response is copied into a cache that holds the last 120 distinct URLs; when the network fails, the cache answers instead, and the reply is stamped `X-Ironlog-Cached`. `api.js` sees that stamp and raises `ironlog:serving-cached`, which puts up a banner saying the data is what the phone had, not what is true now. The cache deliberately **survives** a version upgrade — wiping it on deploy would leave the first launch after an update with nothing to fall back on, which is exactly when you are least likely to have signal to spare. `/api/auth/` is never cached, because a cached "yes you're logged in" is a lie worth avoiding.

**Writing** (`c7c6aca`): a set that cannot reach the server is parked in a localStorage queue (`ironlog.setOutbox`, last 300 entries) and replayed when the connection returns. The subtleties are all in the identity of a queued item:

- A **new set** has no server id yet, so it is keyed by the slot it occupies in the session (workout + exercise + set number + warm-up flag). Tapping ✓ again on a row that is already waiting *corrects* that entry instead of logging the set twice.
- An **edit** is to a set the server already has, so its id is the identity.
- Deletes, RIR and finishing a workout still need a connection, because they act on a server-assigned id which may belong to a set still sitting unsent in this very queue.
- Only failures where the request *never arrived* are replayed. A 4xx/5xx means the server received it and refused; replaying that just fails again and blocks everything queued behind it.
- Cancelling a workout drops anything queued for it, rather than letting the next flush POST into a 404.

**Getting in** (`bfb1241`): launching with no signal used to land on the passcode screen — which you also could not get past, because checking a passcode is a request too. iOS discards a backgrounded PWA routinely, so losing signal mid-session meant being locked out of your own workout with the logged sets sitting unreachable in the outbox. Now the last signed-in profile is remembered locally, and a launch that cannot *ask* whether the session is valid opens on what the phone knows and says so. The distinction that makes this safe: **"I could not ask" is not "I was told no."** A real rejection is a 401 or `authenticated: false`; an unreachable server is a 503 `{"error":"offline"}` from the service worker.

> ⚠️ **The testing trap, and it is a bad one.** Chrome's DevTools offline emulation **does not reach service-worker fetches**. A page driven offline that way keeps working, so "verified offline" was claimed for about a week and was false for every read. The only honest test is to **stop the server** with the page already warm. This is recorded in `CLAUDE.md` too, because it is the kind of thing that costs a day twice.

---

## 6. Auth (logging in)

> **In plain terms:** there are no usernames. You type a 4-digit code, and the app figures out who you are *from the code itself*. That's why two people can't share a passcode — the app would have no way to tell them apart.

### What actually happens when you type your passcode

1. You tap 4 digits on the lock screen.
2. The app sends just those 4 digits to the server.
3. The server takes your code, scrambles it, and compares the scramble against every profile's stored scramble until one matches. *(Scrambling is one-way — the server can check a code is right without ever knowing what it is.)*
4. On a match, the server generates a long random string, saves it as a "session," and sends it back as a cookie your phone stores.
5. Every later request automatically includes that cookie. The server looks it up to know who you are.

**If no profile matches**, the app doesn't just show an error — it assumes you might be a new person and offers to create a profile with that code. There's no separate sign-up screen.

**The cookie is `HttpOnly`**, meaning JavaScript running in the page can't read it. If someone managed to inject malicious code into the app, they still couldn't steal your login token.

**Sessions last 30 days**, enforced by checking the creation date at lookup time rather than by any expiry timer. Logging out is just deleting the row. A sweep for expired rows runs 30 seconds after boot and hourly after that — it used to piggyback on a nudge cron that has since been removed, which is why it now schedules itself.

**One profile is the owner.** `e92d7b1` lets the owner edit shared exercises without typing the admin code, on the reasoning that the person who owns the deployment should not have to authenticate twice to fix a typo in a catalog they maintain. Everyone else still needs the code, because the catalog is shared and a reclassification affects everybody's charts.

**Offline is a third state.** The lock screen cannot work without a connection, since checking a passcode is a server round trip. See §5.4 — "could not ask" is handled separately from "was told no", and conflating the two locked people out of their own workouts.

### How routes get protected

Essentially one line does it — `server.js:114`:

```js
app.use('/api', requireProfile);
```

> **In plain terms:** everything defined *after* this line requires a login. Everything defined *before* it is public. It's a horizontal line through the file, and where a route sits relative to it determines whether it's protected.

Five things sit deliberately above the line:

| Public route | Why it must be |
| --- | --- |
| `/health` | The hosting platform pings it to check the app is alive. It has no login to offer. |
| `/api/auth` | Chicken-and-egg — you can't require a login on the thing that gives you a login. Its own `/me` and `/logout` sub-routes guard themselves individually. |
| `/api/plated` | The nutrition app isn't a person and has no passcode. It authenticates with a secret key in a header instead. |
| `/api/orbit` | Admin dashboard, uses its own separate key. |
| `/api/bug-report` | Must work *before* login — crashes on the lock screen are exactly the ones worth reporting. Uses a check that identifies you if it can but never rejects you. |

**When an unauthenticated request arrives:** the server replies `401 authentication required`. On the phone, `api.js` catches *any* 401 anywhere in the app and shows the lock screen. So if your session expires mid-workout, you get bounced to the numpad rather than watching things silently fail.

**Brute-force protection:** login attempts are rate-limited per IP address and globally, both on 15-minute windows. `server.js` is configured to trust exactly one proxy hop (Railway's), so an attacker can't fake their IP address to escape the limit.

---

## 7. Deployment

> **In plain terms:** you push code to GitHub. Railway notices, packages the app into a container, and starts it. The database lives on a separate disk that survives redeployment — without that, every update would wipe all your data.

```mermaid
flowchart LR
    A[git push main] --> B[Railway sees the push]
    B --> C[Build container<br/>node:24-alpine]
    C --> D[Install dependencies]
    D --> E[Copy app files in]
    E --> F[Start: node server.js]
    F --> G[Database setup runs<br/>create tables, add columns, seed]
    G --> H[Listening]
    V[(Railway volume<br/>a disk at /data)] -.->|survives redeploys| F
```

**Build:** Railway auto-detects the `Dockerfile` — there's no Railway-specific config file. The Dockerfile is 6 meaningful lines. **There's no build step** because there's nothing to compile: the browser code ships exactly as written.

**Database upgrades happen at start-up, not as a separate command.** `server.js` calls `init()` before it starts listening. Because every instruction is self-checking (§4), this is safe to repeat forever. There's no "migrate" command to remember and no rollback.

**Persistence:** the database file sits on a Railway *volume* mounted at `/data`.

> ⚠️ This is load-bearing. A container's own filesystem is thrown away on every deploy. Without the volume, every single update would silently reset the app to an empty database.

> ⚠️ **The notification keys do not follow the same rule, and this asymmetry is easy to miss.** `DB_PATH` is set to the absolute `/data/ironlog.db` in the Dockerfile, so the database lands on the volume. The VAPID key file is resolved *relative to the code* (`path.join(__dirname, 'data', 'vapid.json')` in `push.js`), which inside the container is `/app/data/vapid.json` — on the throwaway filesystem. So unless `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` are set in the environment, or `VAPID_KEYS_FILE` is pointed at `/data/vapid.json`, the keys are regenerated on every deploy and every existing push subscription silently stops working. Nothing errors; notifications just quietly stop arriving. Worth checking which of the two is in place before debugging a missing rest-timer alert.

Because that volume is network-attached storage (slower than a local disk), `db.js` sets `synchronous = NORMAL` — a documented trade that avoids forcing a disk-sync on every single set you log. Combined with WAL mode, a crash can lose the last commit but can't corrupt the file.

**Environment variables** (names only, no values):

| Variable | Set by | What happens if it's missing |
| --- | --- | --- |
| `PORT` | Railway, automatically | Falls back to 3000. |
| `DB_PATH` | The Dockerfile | Falls back to a local folder — **which on Railway means data loss on redeploy.** |
| `NODE_ENV` | The Dockerfile | Error messages leak internal details; login cookie loses its HTTPS-only flag. |
| `ADMIN_CODE` | You, in Railway | **A random code is generated per restart and printed once to the logs.** It changes on every deploy. |
| `ORBIT_API_KEY` | You | The admin feed rejects everything except requests from the server itself. |
| `ORBIT_URL`, `INGEST_SECRET` | You | Bug reports still saved locally, just never forwarded. |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | You | Auto-generated to a file. Fine *if* that file is on the volume — otherwise notification keys rotate on redeploy and everyone's existing subscriptions silently break. |
| `VAPID_KEYS_FILE` | You | Falls back to `<repo>/data/vapid.json` — which inside the container is `/app/data/vapid.json`, **not** the volume at `/data`. See the warning below. |
| `VAPID_CONTACT` | You | Falls back to a hardcoded email in `push.js`. |
| `PLATED_ORIGIN` | You | Controls which domain may call the nutrition integration. |

---

## 8. Known weaknesses

Ordered by what could actually cause harm, not by how easy each is to explain.

**Changed since August:** §8.4 and §8.5 were both acted on and are rewritten below to say what is actually left. §8.1, §8.2, §8.3, §8.6 and §8.7 are unchanged and still true. §8.8 is new.

---

### 8.1 A real production key is committed into the source code

**What it is:** `accounts.js:11` contains a live 64-character API key written directly into the code as text.

**Why it's a problem, concretely:** anyone who can read the repository has a working key to the Plated integration on the live app. And because it's in git history, deleting the line today doesn't remove it — every past version of the file still contains it, forever, in every clone anyone has ever made.

The damage is bounded — that key accesses one profile's nutrition data (mostly reads, plus a body-weight write), not the whole app. So this isn't catastrophic. But it's the one actual secret sitting in source code, and if this repo ever becomes public it's immediately exposed.

**Roughly what fixing it involves:** generate a fresh key (there's already a button for this in Settings), move the old value into an environment variable read at start-up, and either rewrite git history or accept that the old key must be permanently revoked. Since the migration it supports was a one-time event that already happened, the cleanest fix might be deleting the mechanism entirely.

---

### 8.2 Setup instructions re-run forever, and can silently undo your edits

**What it is:** the built-in exercise data is re-applied every time the server starts. Some of those instructions *update* existing exercises' muscle classifications. The only thing stopping them from overwriting deliberate manual edits is a flag (`classification_customized`) that each instruction has to individually remember to check.

**Why it's a problem, concretely:** imagine you correct an exercise — you decide "Cable Crossover" should be classified as lower chest rather than mid chest. You save it. It looks right. Then two weeks later, a completely unrelated deploy happens, the setup instructions re-run, and one of them doesn't check the flag. Your correction silently reverts. There's no error, no warning, no log entry. The data just quietly changes back, and you probably won't notice for weeks.

This has already happened at least once — the flag exists *because* of it. The design relies on every future person (including you in six months) remembering an unwritten rule.

There's a related trap: deliberately choosing "whole muscle" saves an empty value, which looks *identical* to "never classified." Without the flag there is literally no way to tell a deliberate choice from an untouched default.

**Roughly what fixing it involves:** the proper fix is real one-time migrations — a table that records which instructions have already run, so data changes execute exactly once instead of on every boot. That's a meaningful rework of half of `db.js`. A cheaper middle step: funnel all classification updates through a single helper that has the safety check baked in, so it's structurally impossible to forget rather than merely inadvisable.

---

### 8.3 You can't tell what the database looks like by reading the database file

**What it is:** `db.js` declares each table's original shape, then adds ~40 columns across several hundred lines of separate instructions.

**Why it's a problem, concretely:** to answer "what columns does the `sets` table have?" you have to read the creation statement, then scan 400 more lines applying additions in order. In practice people don't — they guess, and guesses go wrong: writing a query against a column that doesn't exist, or missing a critical one like `load_multiplier` and accidentally halving everyone's volume numbers.

It also makes changes impossible to review properly. Adding a column shows up as one line buried in the middle of a 103 KB file, not as a visible change to a schema definition.

**Roughly what fixing it involves:** two independent, low-risk moves. Split `db.js` into separate files for schema, migrations, seed data, and shared query fragments — mechanical work, big readability payoff. Then generate a `schema.sql` snapshot as part of the release process, so the *current* shape of every table is one greppable file even though migrations remain the source of truth.

---

### 8.4 A wrong per-arm setting corrupts your charts invisibly

**What it is:** whether a typed number means "one dumbbell" or "both" is a setting, and nothing checks that the setting matches what you're actually doing.

**Why it's a problem, concretely:** if the setting is wrong, every volume chart, weekly total, and muscle-coverage number for that exercise is off by exactly double — in a way that looks completely normal on screen. You'd have no reason to suspect it. It could persist for months.

This isn't theoretical; it's the real reported issue behind commit `a071b16`.

**Status: largely addressed.** Both fixes this section proposed were built:

- The suggested extension of the kg/lbs checker exists as `/api/sets/suspicious` (`lib/mislog.js`, 28 tests), which catches the decimal-slip shape as well as the above-best-ever shape. `a2c08a3` handles the specific case of one exercise whose history is counted two different ways, explains the split in plain words, and offers to repair it.
- The set row now carries a live `~N kg 1RM` hint and a kg/lbs equivalence line that both recompute as you type, so a doubling error shows up while you are logging rather than in a chart months later.

**What's actually left:** the checks are **opt-in** — a Check button in Settings, not a background scan — and that is deliberate (a false alarm blocks a suggestion you were relying on, which is worse than a miss). But it means a wrong setting still persists until someone thinks to look. The honest remaining gap is that nothing *prompts* you to look. A once-a-month nudge when the checker would have found something, or surfacing the count passively rather than behind a button, would close it without reintroducing false alarms into the logging flow.

---

### 8.5 Almost nothing about the server or the UI is tested

**What it is:** 80 tests. Mostly pure calculations — personal records, mislog detection, calorie maths, unit conversion — plus one route covered end to end: `backup.test.js` drives `GET /api/export` and `POST /api/import` over real HTTP against an in-memory database, including profile isolation. Every other endpoint, the login path, and all browser code remain untested.

**Why it's a problem, concretely:** the untested part is exactly where the real bugs have been. Nothing verifies that every database query filters by profile — and a single missing filter is a privacy breach where one person sees another's workouts. Nothing verifies the login gate is positioned correctly in `server.js`. Nothing verifies that backup export and restore actually round-trip. These are currently checked by manually driving a browser, which is slow enough that it gets skipped.

The browser code is the harder half: `workout.js` is 187 KB where the decision-making logic (should we suggest more weight? is this a plateau?) is tangled together with code that writes to the screen, so there's no clean seam to test against.

**Roughly what fixing it involves:** the highest-value first step is endpoint tests against a temporary in-memory database — create two profiles, then assert that profile A cannot read or modify *anything* belonging to profile B through any endpoint. That's a few dozen tests locking down the property most likely to cause real harm. Second: lift the pure decision functions out of `workout.js` into their own file. They already have no screen dependencies — they're just sitting next to code that does — so this is mostly a cut-and-paste that makes the progression logic testable without a browser.

**The first step has now been taken, on the route where it mattered most.** `backup.test.js` mounts the real routers behind a stub gate, listens on an ephemeral port, and asserts over real HTTP — including the profile-isolation property this section called out ("a single missing filter is a privacy breach where one person sees another's workouts"). Two techniques from Plated's equivalent suite made it possible: reducing an export to what it *says* with every id stripped and references resolved to names, because the import remaps every id and comparing ids compares the wrong thing; and deriving the "export covers everything delete deletes" assertion from `PER_PROFILE_TABLES` itself, so a new table can't be forgotten rather than merely shouldn't be.

**And a method worth generalising:** every guard test there was verified by *breaking what it guards* and confirming it fails. This is not pedantry — Plated shipped an isolation test that asserted a row count and passed with the profile scoping removed from their delete, so it reported safety it did not have for as long as it existed. A guard test that has quietly stopped biting is worse than no test, because it still reports green.

`utils.test.js` already imports a browser module into Node (`public/package.json` marks the directory `"type": "module"`), so the "browser code can't be tested" objection is half-answered too. That half is still untouched.

**Why this keeps mattering:** the gap is exactly where the bugs have been. In the six weeks since this section was written, roughly a third of the commits were fixes to regressions found by manually driving a browser — and the recurring shape was always the same: *a change that is locally correct but breaks an invariant held somewhere else in the file.* A guard keyed on in-memory state when the state had moved to storage; a listener bound at setup time inside a function that re-runs on every render; a `dataset` attribute read by new code that nothing writes. Every one of those is the kind of thing a test pins down and a careful reading does not.

---

### 8.6 One database file, one disk, and backups are a button someone has to remember to press

**What it is:** all data lives in a single file on a single disk. The only backup is a manual "Export to JSON" button in Settings.

**Why it's a problem, concretely:** if that disk is lost or the file is corrupted, you lose everything back to whenever you last remembered to tap Export. There's no schedule, no copy stored anywhere else, and — importantly — no one has ever tested restoring from one. An untested restore isn't really a backup; plenty of people discover their backup format is broken only at the moment they need it.

Separately, the `synchronous = NORMAL` setting (a reasonable speed trade-off, see §7) means a hard crash can lose the most recent write — which in this app means "the set you just logged."

> **What is *not* a problem here:** SQLite's ability to handle the load. A handful of household users is nowhere near its limits, and this is a common misconception. Don't let "SQLite doesn't scale" drive a rewrite — the backup gap is the real risk, and it would exist with any database.

**Roughly what fixing it involves:** a scheduled job that calls the existing export endpoint and pushes the file to cloud storage would close most of the gap using code that already exists. Better is SQLite's built-in `VACUUM INTO` for a proper consistent snapshot, or a tool like Litestream that continuously streams changes to cloud storage and gives point-in-time recovery — roughly a config-and-sidecar change. Whichever route, the restore needs to be practised at least once, on purpose, before it's needed.

---

### 8.7 Two version numbers must be updated together by hand

**What it is:** `public/sw.js` and `public/bugreport.js` each contain a version string, and both must be changed identically on every release that touches browser code.

**Why it's a problem, concretely:** two silent failure modes.

- **Forget the one in `sw.js`:** phones keep serving the old cached code. You deploy a fix, look at your phone, and the bug is still there — with no error to explain why. You end up debugging code that isn't even running.
- **Forget the one in `bugreport.js`:** every bug report gets stamped with the wrong version. You then investigate a bug "in v195" that was actually fixed in v195 and reported from a phone still on v194. This has already caused real confusion — a batch of reports arrived tagged with a superseded version.

**Roughly what fixing it involves:** derive both from one place. Given there's no build step, the simplest option is a small `/api/version` endpoint reading the version out of `package.json`, which the reporting code fetches at start-up. The service worker still needs a literal string, so pair it with a pre-deploy check that fails loudly if the two constants don't match — turning a silent failure into an obvious one.

**Still unfixed.** This file was written at `ironlog-v196`; the app is now on `ironlog-v256`, with 56 distinct version strings appearing across the 63 commits in between. That is 56 occasions on which two unrelated files had to be edited in step, by hand, from memory. It has in fact been got wrong — §8.7's second failure mode is written in the past tense because it already happened.

---

### 8.8 The same question has two opposite answers depending on which route you ask

**What it is:** two different timezone conventions live in the same codebase, with opposite signs.

- Everything under `/api/*` takes `?tzOffset=` as **minutes east of UTC** — that is, `-getTimezoneOffset()`. Auckland sends `720`.
- Everything under `/api/plated/*` takes `?tz=` as the **raw** `getTimezoneOffset()`. Auckland sends `-720`.

**Why it's a problem, concretely:** both are plausible readings of "the timezone offset in minutes", both are 720 apart, and nothing about either name hints at the sign. Get it wrong and workouts bucket into the **wrong local day** — a late-evening session shows up tomorrow, or a streak breaks for no visible reason. There is no error, and the number on screen looks entirely reasonable. The only way to catch it is to test the bucketing directly against a known date.

It exists for an ordinary reason: `?tz=` was the original spelling on the Plated routes, chosen to match what the caller already had to hand, and `?tzOffset=` was chosen later for the app's own routes because the sign convention reads more naturally in SQL. By the time the inconsistency was obvious there was an external caller depending on the old one.

**Current state:** the Plated routes now accept **both** names, so a caller can use either. That makes the integration forgiving but does not remove the trap for anyone writing new code against the app's own routes.

**Roughly what fixing it involves:** nothing clever — pick one convention, express the other as a thin alias that converts, and delete the duplicated parsing. The work is small; the reason it hasn't happened is that it touches date handling across a dozen endpoints, and date bugs are the ones least likely to be noticed in review and most likely to corrupt a chart quietly. If it is done, it should be done with a test per endpoint asserting a known timestamp lands on a known local day.

---

## 9. The two integrations

> **In plain terms:** IronLog talks to two sibling apps. **Plated** tracks food, and needs to know how much you trained so it can set calorie targets. **Orbit** is an admin dashboard that watches several of these apps at once. Neither is a person, so neither can type a passcode — they authenticate with keys instead.

### Plated (nutrition) — `routes/plated.js`

Authenticates with a **per-profile API key** (`X-API-Key` or `Authorization: Bearer`), so a key returns exactly one person's data. Mostly reads, plus two writes: body weight can be pushed *into* IronLog, and the profile fields both apps collect (height, birth year, sex, activity level, goal) can be written back so the user enters them once.

Three design points are worth understanding, because each was arrived at by getting it wrong first:

**`contract_version`, reported in every payload Plated actually fetches.** The question a caller needs answered is "what shape does *this server* return?", so it is answered per-response rather than on an index endpoint the caller never requests. A deployment too old to have the field simply omits it, which means `undefined` safely reads as "assume the oldest shape". A caller can then gate its legacy fallbacks on `contract_version >= 3` and delete them everywhere else, with no extra round trip.

> ⚠️ **A caution recorded on purpose.** The comment on that constant used to assert that IronLog is deployed more than once. It isn't known to be. The claim traced back to a single code comment in Plated's repo and was **retracted on 2 October 2026**; nobody had checked production. What *is* verified is narrower and still enough to justify the design: Plated stores an IronLog URL and key per profile, so different profiles *can* point at different deployments. The mechanism is right either way — but the difference between "can" and "does" is exactly the kind of thing that gets copied forward as fact, so it is flagged here and in the code.

**`calories_estimated` / `calories_source`.** A day's figure is either measured per-exercise or fell back to a flat 4 kcal/min. Plated needs to know which, because presenting an estimate as a measurement is how a nutrition target quietly drifts.

**`tdee_includes_workouts`.** At activity levels moderate and above, the TDEE figure *already* prices in a typical training week. Adding today's workout burn on top of that double-counts. This flag exists because that bug is invisible — both numbers are individually correct.

**One-call `GET /summary`** returns profile + calories + recent + bodyweight together, plus a `resolved` block echoing which local date and offset it settled on, so the caller can confirm the two agree rather than re-deriving and hoping.

### Orbit (admin) — `routes/orbit.js` and `lib/orbitReport.js`

Two directions, often confused:

- **Inbound:** `GET /api/orbit` is a read-only cross-profile overview, gated by `ORBIT_API_KEY`. With no key set it allows localhost only, so development works and production fails closed. It never exposes passcodes or per-profile API keys.
- **Outbound:** `lib/orbitReport.js` forwards bug reports *to* Orbit. Best-effort by design — IronLog always keeps its own copy first (`lib/bugReports.js` inserts before calling out), so a failed forward loses nothing permanently; Orbit picks it up on its next reconcile.

The timeout on that outbound call is deliberately generous: Orbit sleeps on Railway, so the first report after a quiet period pays a container cold start. Five seconds with no retry was *shorter than that start*, which meant the reports most worth having — the first one after a quiet night — were the ones most likely to be dropped. It now waits 15 seconds and retries once, but only where a retry can help: the request got no answer at all, or a 502/503/504. A 4xx is a refusal, and repeating it just fails again.

---

## The six things hardest to explain cold

If someone put you on the spot, these are where your understanding is thinnest — ordered by how likely they are to come up *and* how easy it'd be to get caught out.

**1. Why the doubling factor is stored twice — on the exercise *and* on every set.**
It sounds like pointless duplication until you can name the failure it prevents. Reading it from the exercise means the number is interpreted at *chart-drawing* time, so changing the setting silently rewrites years of history. Freezing a copy onto each set at *logging* time makes the past immutable. Be ready for the obvious follow-up — *"then how do you fix a setting that was wrong all along?"* — because the answer (an explicit opt-in retroactive fix, scoped to just your own sets) is what shows you understood the trade-off rather than just dodged it.

**2. Why one badge has to be written in three different places.**
Easy to state, hard to justify. The reason is that the set row is deliberately patched in place rather than redrawn, so the screen doesn't jump under your thumb while you're mid-workout — and that UX decision is paid for in code duplication. Without a UI framework, nothing guarantees the screen matches the data, so each of the three ways a row can update has to be taught about every badge independently. It's the clearest example in the project of an architectural choice with an ongoing tax.

**3. The two overlapping muscle lists, and why "empty" and "not set" mean opposite things.**
`secondary_muscles` is everything an exercise touches; `secondary_major` is the subset worked hard enough to count. On top of that there's a three-state rule: *unset* means "credit everything" (a fallback for old data), *empty* means "credit nothing," and a filled list means exactly what it says. Empty and unset look nearly identical in the database and behave in opposite ways. Answering "what does this exercise contribute to my back training?" requires knowing both columns *and* that rule.

**4. Where the login boundary sits, and the five things deliberately outside it.**
"One line protects every endpoint" is the easy half. The interesting half is *why* five routes sit above that line, each for a different reason — the health check has no login to give, the login endpoint can't require a login, the nutrition app isn't a person and uses a key instead, the admin feed uses a different key again, and bug reporting must work before you've logged in because lock-screen crashes are the ones most worth catching. Explaining why three different authentication mechanisms coexist is what demonstrates you know the file rather than the concept.

**5. That the database setup re-runs on every single restart — and what that causes.**
Most people's mental model is "migrations run once, tracked somewhere." Here they run unconditionally on every boot, made safe only by each one checking its own work first. The non-obvious consequence is that instructions which *modify* data (not just add columns) re-execute forever — which is the entire reason the `classification_customized` flag exists. Connecting "there's no migrations table" to "a user's manual edit can silently revert on an unrelated deploy weeks later" is the thing most likely to catch you out, because those two facts live hundreds of lines apart in the same file.

**6. Why "offline" is three separate problems and not one.**
The easy answer — "there's a service worker" — is the one that was wrong for a week. Reading offline, writing offline, and *getting in* offline each failed for an unrelated reason and each needed its own fix: a cache that survives deploys, a queue keyed by slot rather than by server id, and a remembered profile so the lock screen doesn't demand a round trip you can't make. The thread connecting them is one distinction worth being able to state cleanly: **"I could not ask" is not "I was told no."** Every one of the three bugs was a place where the code collapsed those two into the same branch. The follow-up most likely to catch you out is *"how do you know it works?"* — because the obvious answer (DevTools offline mode) does not test it at all, and believing it did is what let the claim stand for a week.
