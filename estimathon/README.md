# The Estimathon

Teams bracket the answer to a series of impossible questions. Narrow intervals
are cheap, wide ones cost, and missing costs more. Lowest total wins.

- `/estimathon/` — where teams play
- `/estimathon/admin.html` — where you run it

| File | What it is |
| --- | --- |
| `core.js` | The question list, the shared store, and the scoring formula |
| `app.js` | The team page |
| `admin.js` | The dashboard |
| `../answers.json` | The answer key — gitignored, never committed |

---

## Running an event

Questions are asked **one at a time**. Every question starts *pending*: teams
cannot see it, and in production its text is never even sent to their browsers.

**Before the room fills up**

1. Open `/estimathon/admin.html`, enter the passcode.
2. Check the header says **Server**, not *This device only*. If it says the
   latter, the page is not talking to the backend and nobody else will see
   anything you do.
3. Check the stats row reads `15 / 15` answers keyed.
4. Press **Reset event** if a previous run's teams are still listed. This
   clears teams and submissions and rewinds every question to pending. The
   answer key survives.

**During**

5. **Next question** — asks question 1 and opens submissions.
6. Teams submit intervals and may revise as often as they like while it is open.
7. **Next question** — closes the current one for good, opens the next. Repeat.

**Ending**

8. After the last question, **Close all**.
9. **Release answers.** Only now do teams see the answers and their own
   results. This is deliberate and one-way in spirit — do not press it early.
10. **Export JSON** for the record.

### The other controls

| Control | What it does |
| --- | --- |
| Numbered strip | Jump to any question. Opening one closes whatever was open |
| **Reopen** | Undo an accidental close — reopens the last closed question |
| **Open all at once** | The classic format: every question visible, teams budget their own time |
| **Show standings to teams** | Live leaderboard on the team page. Only meaningful after answers are released |
| **Close submissions** | Master switch. Stops everything regardless of question status |
| Remove (per team) | Deletes a team and all its submissions. For joke entries |

### If something goes wrong mid-event

- **A team cannot get back in.** They re-enter the same team name — names are
  unique and case-insensitive, and re-entering one rejoins that team with its
  submissions intact.
- **You closed a question too early.** Press **Reopen**.
- **An answer in the key is wrong.** Fix it in the Answer key table on the
  dashboard. It updates the scoreboard immediately and beats whatever
  `answers.json` said.
- **The dashboard goes blank.** Refresh. Nothing is held in the page; all state
  is in the database.

---

## Grading

The scoreboard is live and needs nothing from you. To grade offline, or to
double-check:

```
py -3 tools/score.py estimathon-export.json          # an admin JSON export
py -3 tools/score.py --out results.csv               # also write a CSV
py -3 tools/score.py --selftest                      # check the formula itself
```

### The formula

For an interval `[a, b]` against the true answer `n`:

```
e_i     = 0                      if a <= n <= b
        = log2(max(a/n, n/b))    otherwise      -- how far off, in doublings

score_i = 0.07 * (b / a) + e_i
```

A team's score is the **sum** over all questions. An unanswered question costs
`10.0`. Lowest total wins.

So a bracketed answer costs only its width: 3× wide costs 0.21, 100× wide costs
7. Missing adds the miss on top — an answer 8× outside your range adds 3.
Skipping costs 10, worse than almost any real guess, which is the point: teams
should always answer.

It is implemented twice, identically — `score_i`/`e_i` in `tools/score.py`, and
`Scoring.scoreQuestion` in `core.js` so the live board matches the grader.
`--selftest` fails if the two copies of the constants drift.

A question with no answer yet is skipped entirely, so a partly keyed event still
ranks; the dashboard says *provisional* until every answer is in.

---

## Changing the questions

Question text and order live in `DEFAULT_QUESTIONS` at the top of `core.js`:

```js
{ id: 'q16', text: 'How many …?', answer: null, unit: 'number' },
```

Keep `answer: null` there. Answers go in `answers.json` at the repo root:

```json
{ "q16": 12345 }
```

Then:

```
py -3 tools/questions.py    # prints the merged list — check it looks right
py -3 tools/make_seed.py
cd worker && wrangler d1 execute estimathon --remote --file=./seed.sql
```

and commit the `core.js` change.

Adding or removing a question changes the id set; any browser holding an older
copy replaces it wholesale on next load. Re-seeding leaves each question's
pending/open/closed status alone, so you can fix a typo mid-event.

## Keeping the answers secret

Three layers:

1. Answers are not in `core.js` — every entry there is `answer: null`.
2. `GET /state` blanks every answer unless the request carries the organizer
   passcode, or you have pressed **Release answers**.
3. `tools/server.py` strips `DEFAULT_QUESTIONS` out of `core.js` when it serves
   it locally.

**One gap.** GitHub Pages serves `core.js` verbatim, so *question text* is
readable in devtools before a question is asked. The answers are not there, so
this only lets someone read ahead. To close it, move the questions into a
`questions.json` at the repo root — `[{"id","text","unit"}, …]` —
`tools/questions.py` prefers that file when it exists, and it is gitignored, so
only D1 ever holds the text.

## If you lose `answers.json`

It is gitignored, so a fresh clone will not have it. `tools/questions.py` will
report `0 with an answer key` and the scoreboard will sit at *provisional*
forever. Either restore the file from an officer's copy, or type the answers
into the dashboard's Answer key table — those persist in D1 either way.
