# tools/

Python, standard library only. Nothing to install — if `py -3` runs, these run.

Run them **from the repository root**, not from in here:

```
py -3 tools/server.py
```

They locate the site by going one level up from their own file, so they work
regardless of your working directory, but the paths in every doc assume root.

---

## `server.py` — the local site and API

```
py -3 tools/server.py                    # http://localhost:8000
py -3 tools/server.py --port 9000
py -3 tools/server.py --db saturday.db   # a scratch database
py -3 tools/server.py --tunnel           # + a temporary public URL
py -3 tools/server.py --reseed           # force answers.json over the database
```

Serves the pages *and* implements the whole API against a local SQLite file
(`estimathon.db` by default). It is a faithful mirror of the Cloudflare Worker —
same endpoints, same rules, same validation — so anything that works here works
deployed.

Two things it does to the files on the way out:

- **Injects `window.ESTIMATHON_API = "/api"`** immediately after `config.js` in
  every page, so local pages use this server rather than production. Any new
  page that talks to the API must load `config.js` or it will miss this.
- **Strips `DEFAULT_QUESTIONS`** out of `estimathon/core.js`, so a browser
  pointed at this server never receives the question text or the answer key.

It refuses to serve `tools/`, `worker/`, `answers.json`, and any `.py` or `.db`
file.

`--tunnel` needs `cloudflared` on PATH (`winget install --id Cloudflare.cloudflared`)
and gives a public `trycloudflare.com` URL that lives until you stop the server.
Useful for testing on a phone; not how you run a real event — that is what the
deployed Worker is for.

## `score.py` — the Estimathon grader

```
py -3 tools/score.py                          # grade the local estimathon.db
py -3 tools/score.py export.json              # grade an admin JSON export
py -3 tools/score.py responses.csv            # or a CSV export
py -3 tools/score.py --out results.csv        # also write the leaderboard
py -3 tools/score.py --json                   # full per-question breakdown
py -3 tools/score.py --selftest               # check the formula
```

`--selftest` checks the formula against hand-worked cases **and** that the
constants in `estimathon/core.js` still match this file. Run it after touching
either. The formula itself is documented in `estimathon/README.md`.

## `questions.py` — the question list

```
py -3 tools/questions.py
```

Prints the merged question list: text and order from `DEFAULT_QUESTIONS` in
`estimathon/core.js` (or from `questions.json` at the root if that exists),
answers from `answers.json`. The fastest way to check you have not broken the
array after editing it.

It contains a small parser for the JavaScript array literal, because
`DEFAULT_QUESTIONS` is authored as JS rather than JSON. If it complains, you
have almost certainly got an unbalanced bracket or quote in `core.js`.

## `make_seed.py` — build the D1 seed

```
py -3 tools/make_seed.py
```

Writes `worker/seed.sql` from three sources: questions from
`estimathon/core.js`, answers from `answers.json`, and form definitions from
`forms/forms.json`. Load it with:

```
cd worker && wrangler d1 execute estimathon --remote --file=./seed.sql
```

The generated file contains the answer key, so it is gitignored. Regenerate it
whenever you change a question, an answer, or a form.

The SQL it writes upserts by id and never touches question status, form status,
responses, teams, or submissions — so it is safe to run against a live event.

---

## Adding a tool

Keep them stdlib-only and keep the root anchor:

```python
HERE = Path(__file__).resolve().parent
ROOT = HERE.parent          # the repo root, which is what GitHub Pages serves
```

If your tool needs to reach the API, prefer running it against
`http://localhost:8000/api` with `server.py` up rather than talking to
production.
