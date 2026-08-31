# JMU MIMF Estimathon

A two-page web app for running an Estimathon, plus a Python server and grader.

| File | What it is |
| --- | --- |
| `index.html` / `script.js` | Team page: sign in, submit low/high intervals |
| `admin.html` / `admin.js` | Organizer dashboard: arrivals, live feed, answer key, scoreboard |
| `estimathon.js` | Shared core: **the question set**, storage, scoring |
| `style.css` | Shared styles |
| `server.py` | Event server: static pages + SQLite-backed API |
| `score.py` | The scoring formula, and a CLI that grades an event |
| `questions.py` | Reads the question set out of `estimathon.js` |

## Running an event

```
py -3 server.py
```

Team page at <http://localhost:8000/>, dashboard at `/admin.html`. Other devices
on the same wifi use your machine's LAN address (`ipconfig` → IPv4). Everything
lands in `estimathon.db`; stop and restart the server and nothing is lost.

1. Open the dashboard, enter the passcode (`PASSCODE` at the top of `admin.js`).
2. **Open submissions.** Teams sign in and start bracketing.
3. Watch the feed and the interval grid. The scoreboard is live.
4. **Close submissions** when time is up.
5. **Release answers** — now, and only now, teams see the answers and how each
   of their intervals scored.
6. **Export JSON** for the record, or grade the database directly:

```
py -3 score.py                       # leaderboard from estimathon.db
py -3 score.py --out results.csv     # ...and write it to a CSV
py -3 score.py export.json --json    # grade an admin JSON export instead
```

## Two ways to run, and why it matters

**With `server.py` (recommended).** One shared SQLite database, so teams on their
own phones all see the same contest. The server — not the browser — enforces the
submission cap, the open/closed gate, and bound validation, and it **withholds
the answer key** from every request that does not carry the organizer passcode.

**Static only (GitHub Pages).** The same files work with no server: state falls
back to `localStorage`, synced across tabs on one machine via `BroadcastChannel`.
Fine for testing or a single-laptop run. Two caveats:

- It does **not** sync between devices. There is nowhere shared to put the data.
- The answers live in `estimathon.js`, which every visitor downloads. The team
  page will not *show* them before you release them, but anyone who opens
  devtools can read them. **For a real event either run `server.py`, or set every
  `answer` to `null` in `estimathon.js` and type the key into the admin page
  afterward.**

Nothing needs configuring to switch: when `server.py` serves a page it injects
`window.ESTIMATHON_API = "/api"` ahead of `estimathon.js`. No server, no
injection, local storage.

## Questions

`DEFAULT_QUESTIONS` in `estimathon.js` is the single source of truth. Edit it
there and everything follows — the pages, the server (which reseeds on startup),
and the grader. `py -3 questions.py` prints the parsed list, which is the quick
way to check you did not break the array.

Adding or removing a question changes the id set, and any browser holding an
older copy replaces it wholesale on next load. If the ids are unchanged, a
browser keeps the answer key it has, so a correction made from the admin page
during an event survives a refresh.

## Scoring

For an interval `[a, b]` against the true answer `n`:

```
e_i     = 0                      if a <= n <= b
        = log2(max(a/n, n/b))    otherwise      -- how far off, in doublings

score_i = 0.07 * (b / a) + e_i
```

A team's score is the **sum** over all questions. Unanswered questions cost
`10.0` each. **Lowest total wins.**

So a bracketed answer costs only its width: an interval 3× wide costs 0.21, one
100× wide costs 7. Missing adds the miss on top — an answer 8× outside your
range adds 3. Skipping costs 10, which is worse than almost any real guess, so
teams should always answer.

The formula lives in `score_i`/`e_i` in [`score.py`](score.py) and, identically,
in `Scoring.scoreQuestion` in [`estimathon.js`](estimathon.js) so the live board
matches the grader. The two constants are duplicated by necessity; this catches
a drift:

```
py -3 score.py --selftest
```

A question whose `answer` is `null` is skipped entirely, so a partly keyed event
still ranks — the dashboard marks the board *provisional* until every question
has an answer.

## Data model

SQLite (`estimathon.db`): `questions`, `teams`, `submissions`, `config`. Open it
with any SQLite tool mid-event.

`submissions` is append-only — every attempt is kept, with an epoch-millisecond
timestamp. **Only the latest submission per (team, question) counts.** The CSV
export flattens the same data, one row per submission, with an `is_latest`
column.

The admin **Export JSON** button writes:

```json
{
  "exportedAt": "2026-08-31T18:00:00.000Z",
  "config": { "maxSubmissions": 18, "widthWeight": 0.07,
              "unansweredPenalty": 10, "questions": [ ... ] },
  "teams":       [ { "id": "team_a1b2c3", "name": "...", "joinedAt": 0 } ],
  "submissions": [ { "teamId": "team_a1b2c3", "questionId": "q1",
                     "low": 1000, "high": 1500, "at": 0 } ],
  "scoreboard":  [ { "team": "...", "score": 12.4, "correct": 13,
                     "missed": 1, "unanswered": 1 } ]
}
```

`score.py` reads all three: the `.db`, a JSON export, or a CSV export.

## API

Only relevant if you host the backend elsewhere. Set
`window.ESTIMATHON_API = "https://your-host"` before `estimathon.js` in both
HTML files and implement:

| Method + path | Body | Notes |
| --- | --- | --- |
| `GET /state` | — | whole state; `?key=<passcode>` to include answers |
| `GET /admin-check?key=` | — | `{ok: bool}` |
| `POST /join` | `{name, members}` | same name rejoins the same team |
| `POST /submit` | `{teamId, questionId, low, high}` | enforce the cap here |
| `POST /config` | partial config patch | also `{answer: {questionId, value}}` |
| `POST /team/delete` | `{teamId}` | |
| `POST /reset` | `{}` | clears teams and submissions |

The client polls `GET /state` every 2 seconds and refreshes immediately after
any write.

## Notes

- The admin passcode gates the answer key on the server, but the dashboard
  itself is public static HTML. Anyone with the URL can see teams and
  submissions; they just cannot see answers.
- `server.py` and `score.py` are stdlib only. No `pip install`.
- Team names are unique and case-insensitive; entering an existing name rejoins
  that team, which is how a team recovers from a refresh or adds a second device.
