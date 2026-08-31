# JMU MIMF Estimathon

A two-page web app for running an Estimathon, plus a Python event server and
grader. Questions are asked one at a time, under organizer control.

| File | What it is |
| --- | --- |
| `index.html` / `script.js` | Team page: sign in, submit low/high intervals |
| `admin.html` / `admin.js` | Dashboard: run of play, arrivals, live feed, scoreboard |
| `estimathon.js` | Shared core: the question list, storage, scoring |
| `style.css` | Shared styles |
| `server.py` | Event server: static pages + SQLite-backed API |
| `score.py` | The scoring formula, and a CLI that grades an event |
| `questions.py` | Reads the questions from `estimathon.js`, answers from `answers.json` |
| `answers.json` | **The answer key. Gitignored — never commit it.** |

## Running an event

```
py -3 server.py --tunnel
```

That prints a public `https://….trycloudflare.com` URL. Teams open it on their
phones from anywhere; the dashboard is that URL + `/admin.html`. The URL lives
until you stop the server, so start it before the event and leave it running.
Without `--tunnel` you get localhost and your LAN address only.

`--tunnel` needs `cloudflared` on PATH — `winget install --id Cloudflare.cloudflared`.
No Cloudflare account, no configuration. If it is missing, the server says so
and keeps serving locally.

Everything lands in `estimathon.db`. Stop and restart and nothing is lost.

### The run of play

Every question starts **pending**: teams cannot see it, and its text is never
sent to their browsers. The dashboard's *Run of play* panel drives the event.

1. Open the dashboard and enter the organizer passcode.
2. **Next question** — asks question 1 and opens submissions.
3. Teams submit intervals, and may revise as often as they like while it is open.
4. **Next question** — closes question 1 for good, opens question 2. Repeat.
5. After the last one, **Close all**.
6. **Release answers** — now, and only now, teams see the answers and how each
   of their intervals scored.
7. **Export JSON** for the record, or grade the database directly.

Other controls: the numbered strip jumps straight to any question (opening one
closes whatever was open); **Reopen** undoes an accidental close; **Open all at
once** switches to the classic format where teams see all fifteen and budget
their own time.

```
py -3 score.py                       # leaderboard from estimathon.db
py -3 score.py --out results.csv     # ...and write it to a CSV
py -3 score.py export.json --json    # grade an admin JSON export instead
py -3 score.py --selftest            # check the formula and the JS/Python constants
```

## Where the answers live

`answers.json`, which **`server.py` refuses to serve** and `.gitignore` keeps out
of the repo. That matters: this repo publishes to `jmumimf.github.io`, so
anything committed is public, and anything a browser downloads is readable in
devtools.

Three layers keep the key away from teams:

1. It is not in `estimathon.js` (`answer: null` for every question there).
2. When `server.py` serves `estimathon.js` it strips `DEFAULT_QUESTIONS`
   entirely, so the client learns questions only from the API.
3. `GET /api/state` blanks every answer unless the request carries the organizer
   passcode, or you have pressed **Release answers**.

You can delete `answers.json` and type the answers into the dashboard instead —
they persist in `estimathon.db` either way. On restart the server keeps answers
already in the database; `--reseed` forces `answers.json` back over them.

The organizer passcode lives in `admin.js`, on the line marked
`/* admin-passcode */`. `server.py` reads that line, so changing it changes both.
Or pass `--admin-code`.

## Two ways to run

**With `server.py` (what you want).** One shared SQLite database. The server —
not the browser — enforces the submission cap, the open/closed gate, per-question
status, and bound validation.

**Static only (GitHub Pages, no server).** The same files work with state in
`localStorage`, synced across tabs on one machine via `BroadcastChannel`. Fine
for testing. It does **not** sync between devices, and with no server there is
nothing to withhold answers — so put the key in `answers.json`, not in
`estimathon.js`, and keep it that way.

Nothing needs configuring to switch: when `server.py` serves a page it injects
`window.ESTIMATHON_API = "/api"` ahead of `estimathon.js`.

## Questions

`DEFAULT_QUESTIONS` in `estimathon.js` is the source of truth for question text
and order; `answers.json` supplies the key. `py -3 questions.py` prints the
merged list, which is the quick way to check you did not break the array.

Adding or removing a question changes the id set; the server inserts new ones as
pending on startup, and any browser holding an older copy replaces it wholesale.

## Scoring

For an interval `[a, b]` against the true answer `n`:

```
e_i     = 0                      if a <= n <= b
        = log2(max(a/n, n/b))    otherwise      -- how far off, in doublings

score_i = 0.07 * (b / a) + e_i
```

A team's score is the **sum** over all questions. Unanswered questions cost
`10.0` each. **Lowest total wins.**

A bracketed answer costs only its width: 3× wide costs 0.21, 100× wide costs 7.
Missing adds the miss on top — an answer 8× outside your range adds 3. Skipping
costs 10, worse than almost any real guess, so teams should always answer.

The formula lives in `score_i`/`e_i` in `score.py` and, identically, in
`Scoring.scoreQuestion` in `estimathon.js`. The two constants are duplicated by
necessity; `py -3 score.py --selftest` fails if they drift.

A question whose answer is unset is skipped, so a partly keyed event still
ranks — the dashboard marks the board *provisional* until every answer is in.

## Data model

SQLite (`estimathon.db`): `questions` (with a `status` of pending/open/closed),
`teams`, `submissions`, `config`. Open it with any SQLite tool mid-event.

`submissions` is append-only — every attempt is kept, with an epoch-millisecond
timestamp. **Only the latest submission per (team, question) counts.** The CSV
export flattens it one row per submission with an `is_latest` column.

## API

| Method + path | Body | Notes |
| --- | --- | --- |
| `GET /state` | — | whole state; `?key=<passcode>` to include answers and pending text |
| `GET /admin-check?key=` | — | `{ok: bool}` |
| `POST /join` | `{name, members}` | same name (any case) rejoins the same team |
| `POST /submit` | `{teamId, questionId, low, high}` | cap, gate and bounds enforced here |
| `POST /question` | `{questionId, status}`, `{action:"next"}`, `{action:"all", status}` | run of play |
| `POST /config` | partial patch | also `{answer: {questionId, value}}` |
| `POST /team/delete` | `{teamId}` | |
| `POST /reset` | `{}` | clears teams and submissions, rewinds to all-pending |

The client polls `GET /state` every 2 seconds and refreshes after every write.

## Notes

- `server.py` and `score.py` are stdlib only. No `pip install`.
- The dashboard URL is not secret. Anyone who has it can see teams and
  submissions; the passcode is what gates the answer key.
- Team names are unique and case-insensitive, which is how a team recovers from
  a refresh or adds a second device.
