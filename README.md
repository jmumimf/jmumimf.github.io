# JMU MIMF Estimathon

Teams sign in at <https://jmumimf.github.io> and answer one question at a time.
Organizers drive the run of play and watch the scoreboard from `/admin.html`.

| File | What it is |
| --- | --- |
| `index.html` / `script.js` | Team page: sign in, submit low/high intervals |
| `admin.html` / `admin.js` | Dashboard: run of play, arrivals, live feed, scoreboard |
| `estimathon.js` | Shared core: question list, storage, scoring |
| `config.js` | **The one line that points the site at its backend** |
| `style.css` | Shared styles |
| `worker/` | The production API: Cloudflare Worker + D1. See `worker/README.md` |
| `server.py` | The same API for local use: static pages + SQLite |
| `score.py` | The scoring formula, and a CLI that grades an event |
| `questions.py` / `make_seed.py` | Read the questions and answers; build the D1 seed |
| `answers.json` | **The answer key. Gitignored — never commit it.** |

## Making jmumimf.github.io playable

GitHub Pages serves files and nothing else — it cannot run code or store
submissions. So the pages live on Pages and the shared state lives in a
Cloudflare Worker backed by D1: free, always on, no laptop involved.

**Setup is a one-time job: follow [`worker/README.md`](worker/README.md).**
The short version:

1. Install Node, then `npm install -g wrangler`, then `wrangler login`.
2. `wrangler d1 create estimathon`, paste the id into `worker/wrangler.toml`.
3. Load `schema.sql`, then `py -3 make_seed.py` and load `seed.sql`.
4. `wrangler secret put ADMIN_CODE` — the organizer passcode.
5. `wrangler deploy`, then put the printed URL in `config.js` and push.

After that there is nothing to run. Open the dashboard and start the event.

## Local development

```
py -3 server.py            # http://localhost:8000
py -3 server.py --tunnel   # ...plus a temporary public URL, needs cloudflared
```

`server.py` implements the same API against a local SQLite file and serves the
pages itself, overriding `config.js` with its own `/api`. So local work never
touches production, and the browser code is identical either way.

With `config.js` empty and no server at all, the pages fall back to
`localStorage` — one browser only, no sharing. Useful for poking at the UI.

## The run of play

Every question starts **pending**: teams cannot see it, and its text is never
sent to their browsers. The dashboard's *Run of play* panel drives the event.

1. Open `/admin.html` and enter the organizer passcode.
2. **Next question** — asks question 1 and opens submissions.
3. Teams submit intervals, revising as often as they like while it is open.
4. **Next question** — closes question 1 for good, opens question 2. Repeat.
5. After the last one, **Close all**.
6. **Release answers** — now, and only now, teams see the answers and how each
   of their intervals scored.
7. **Export JSON** for the record.

The numbered strip jumps to any question (opening one closes whatever was
open); **Reopen** undoes an accidental close; **Open all at once** switches to
the classic format where teams see everything and budget their own time.

## Scoring

For an interval `[a, b]` against the true answer `n`:

```
e_i     = 0                      if a <= n <= b
        = log2(max(a/n, n/b))    otherwise      -- how far off, in doublings

score_i = 0.07 * (b / a) + e_i
```

A team's score is the **sum** over all questions; an unanswered question costs
`10.0`. **Lowest total wins.**

A bracketed answer costs only its width: 3× wide costs 0.21, 100× wide costs 7.
Missing adds the miss on top — an answer 8× outside your range adds 3. Skipping
costs 10, worse than almost any real guess, so teams should always answer.

```
py -3 score.py export.json           # grade an admin JSON export
py -3 score.py                       # or the local estimathon.db
py -3 score.py --out results.csv
py -3 score.py --selftest            # checks the formula and the JS/Python constants
```

The formula lives in `score_i`/`e_i` in `score.py` and, identically, in
`Scoring.scoreQuestion` in `estimathon.js`, so the live board matches the
grader. `--selftest` fails if the two copies of the constants drift.

A question with no answer yet is skipped, so a partly keyed event still ranks —
the dashboard says *provisional* until every answer is in.

## Questions and answers

- **Question text and order**: `DEFAULT_QUESTIONS` in `estimathon.js`.
- **Answers**: `answers.json`, which is gitignored and never served.
- `py -3 questions.py` prints the merged list — the quick way to check you did
  not break the array.
- After editing either, `py -3 make_seed.py` and re-run the D1 execute. No
  redeploy needed; the Worker reads questions from D1, not from its code.

Three layers keep the answer key away from teams:

1. It is not in `estimathon.js` (`answer: null` for every question there).
2. `GET /state` blanks every answer unless the request carries the organizer
   passcode, or you have pressed **Release answers**.
3. `server.py` additionally strips `DEFAULT_QUESTIONS` out of `estimathon.js`
   when it serves it.

**One gap to know about.** GitHub Pages serves `estimathon.js` verbatim, so the
*question text* is readable in devtools before a question is asked. The answers
are not there, so this only lets someone read ahead. If that bothers you, move
the questions into a `questions.json` file in the repo root (same shape:
`[{"id","text","unit"}, …]`) — `questions.py` prefers it when it exists, and it
is gitignored, so nothing but D1 ever has the text. Everything else keeps
working.

## Data model

SQLite in both places — D1 in production, a local file for `server.py`:
`questions` (with a `status` of pending/open/closed), `teams`, `submissions`,
`config`.

`submissions` is append-only; every attempt is kept with an epoch-millisecond
timestamp. **Only the latest submission per (team, question) counts.** The CSV
export flattens it one row per submission with an `is_latest` column.

## API

Same contract in the Worker and `server.py`. The client polls `GET /state` every
3 seconds, pauses while the tab is backgrounded, and refreshes after every write.

| Method + path | Body | Notes |
| --- | --- | --- |
| `GET /state` | — | `?key=<passcode>` to include answers and pending text |
| `GET /admin-check?key=` | — | `{ok: bool}` |
| `GET /health` | — | sanity check after deploying |
| `POST /join` | `{name, members}` | same name (any case) rejoins the same team |
| `POST /submit` | `{teamId, questionId, low, high}` | cap, gate and bounds enforced here |
| `POST /question` | `{questionId, status}`, `{action:"next"}`, `{action:"all", status}` | run of play |
| `POST /config` | partial patch | also `{answer: {questionId, value}}` |
| `POST /team/delete` | `{teamId}` | |
| `POST /reset` | `{}` | clears teams and submissions, rewinds to all-pending |

## Notes

- `server.py`, `score.py` and `questions.py` are stdlib only. No `pip install`.
- The dashboard URL is not secret. Anyone who has it can see teams and
  submissions; the passcode is what gates the answer key.
- Team names are unique and case-insensitive, which is how a team recovers from
  a refresh or adds a second device.
