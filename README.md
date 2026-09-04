# JMU MIMF

The club website: <https://jmumimf.github.io>

One home page, with each feature as its own tab. Today that's the **Estimathon**
contest and a **forms** system for sign-ups and interview scheduling. Both share
one backend, one stylesheet, and one organizer passcode.

## Layout

```
index.html            the home page — the only page at the root
config.js             THE FILE YOU EDIT TO DEPLOY (backend URL + local passcode)
answers.json          the Estimathon answer key — gitignored, never commit

assets/               shared by every page
  style.css
  admin-gate.js       the passcode screen both dashboards use

estimathon/           /estimathon/
  index.html          teams play here
  admin.html          organizers run the event here
  core.js             questions, storage, scoring
  app.js  admin.js    one file per page
  README.md           how to run an Estimathon

forms/                /forms/
  index.html          pick a form and fill it in
  admin.html          read and download responses
  forms.json          THE FORM DEFINITIONS — edit this to change a form
  core.js             field types, rendering, validation
  app.js  admin.js
  README.md           how to write a form and read the replies

tools/                Python. Stdlib only, no pip install
  server.py           local dev server + the same API, on SQLite
  score.py            the Estimathon scoring formula and grading CLI
  questions.py        reads the questions and the answer key
  make_seed.py        builds worker/seed.sql
  README.md

worker/               the production backend: Cloudflare Worker + D1
  src/index.js        the whole API
  schema.sql          tables
  wrangler.toml       config

docs/
  SETUP.md            first-time setup, updating, and shutting down
  ADDING-A-PAGE.md    how to add a third tab
```

Each folder is one thing. A page and everything only that page uses live
together; anything two pages share is in `assets/`.

## Quick start

**Work on it locally.** Nothing to install:

```
py -3 tools/server.py
```

Then <http://localhost:8000>. The admin passcode locally is `local-dev`
(`ADMIN_PASSCODE` in `config.js`). This runs the real API against a local
SQLite file, so it behaves exactly like production without touching it.

**Publish a change.** Commit and push. GitHub Pages redeploys in a minute or
two. Only edits under `worker/` need anything more — see below.

## Where the pieces live

| I want to… | Go to |
| --- | --- |
| Change the home page | `index.html` |
| Change a form's questions | `forms/forms.json`, then reseed |
| Read form responses | `/forms/admin.html` |
| Change Estimathon questions | `estimathon/core.js`, then reseed |
| Change Estimathon answers | `answers.json`, then reseed |
| Run an Estimathon | `/estimathon/admin.html` — see `estimathon/README.md` |
| Change the look of anything | `assets/style.css` |
| Point the site at a backend | `config.js` |
| Add a whole new tab | `docs/ADDING-A-PAGE.md` |
| Set up from scratch, or shut down | `docs/SETUP.md` |

## How the backend works

GitHub Pages serves files and nothing else — it cannot run code or store data.
So the pages are static, and everything shared lives in a Cloudflare Worker
backed by D1 (which is SQLite). `tools/server.py` implements the same API
locally for development.

`config.js` decides which one a page talks to, and it picks by origin: on
`localhost` or `file://` it defaults to **no backend**, so the pages fall back
to `forms.json` and `localStorage`. `tools/server.py` overrides that with
`/api` on a line it injects into each page. Only the real deployed origin
reaches the real Worker. This is why a page opened from disk, or from Live
Server, will not see production data — that is deliberate, and it is also what
stops you from testing against live submissions by accident.

Full setup, update, and shutdown instructions: **[docs/SETUP.md](docs/SETUP.md)**.

## Testing your changes

There is no test runner in the repo; the checks live outside it. What you can
run here:

```
py -3 tools/score.py --selftest    # scoring formula + JS/Python constants agree
py -3 tools/questions.py           # print the parsed question list
py -3 tools/make_seed.py           # rebuild the D1 seed, printing what it found
```

After any change, load every page under `tools/server.py` and click through
once. The four pages are `/`, `/estimathon/`, `/forms/`, and the two
`admin.html` dashboards.

## Conventions worth keeping

- **Public vs. secret.** Everything in this repo is world-readable — it is
  published. The Estimathon answer key is the only secret, and it lives in
  `answers.json` (gitignored) and in D1. The passcode in `config.js` is a
  local-development convenience; the real one is the Worker's `ADMIN_CODE`.
- **Validate twice.** Anything a form or a submission enforces in the browser is
  enforced again in `worker/src/index.js` and `tools/server.py`. The browser
  copy is for fast feedback; the server copy is the one that counts.
- **Data lives in D1, definitions live in files.** Questions, answers, and form
  definitions are authored in files and seeded into the database. Responses and
  submissions only ever live in the database.
