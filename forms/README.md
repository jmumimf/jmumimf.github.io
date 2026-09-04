# Forms

Google-Forms-shaped questionnaires, hosted here instead of on a Google account
nobody can find the password to.

- `/forms/` — the list; people pick one and fill it in
- `/forms/admin.html` — read, filter, and download responses

| File | What it is |
| --- | --- |
| `forms.json` | **The form definitions. This is the file you edit.** |
| `core.js` | Field types, rendering, validation |
| `app.js` | The public page |
| `admin.js` | The dashboard |

`forms.json` is committed on purpose: form questions are public by nature —
people have to read them to answer them. Only the *responses* are protected.

---

## Reading responses

Open `/forms/admin.html`, enter the passcode, pick a form from the dropdown.

- **Search** filters across every answer.
- **CSV** downloads one row per response, one column per question. This is the
  one to open in Excel or import into anything else.
- **JSON** downloads the same data with the form definition attached, which is
  what you want for an archive.
- **Close form** stops new responses without deleting anything. **Reopen form**
  puts it back.
- **Delete** on a row removes one response permanently.

Responses are never edited, only added or deleted.

### Availability, for the interview form

Any form with a `timeslot` field gets an extra panel above the table: a bar per
window showing how many people can make it, sorted with the most available
first and the winner in gold. Hover a bar to see exactly who picked it.

That is the whole point of the interview form — find the slot that works for
the most people without reading twenty rows by hand.

---

## Writing a form

`forms.json` is a list. Each entry:

```json
{
  "id": "interest",
  "title": "Interest Form",
  "description": "Shown under the title.",
  "status": "open",
  "submitLabel": "Send it in",
  "confirmation": "Shown on the thank-you screen.",
  "fields": [ ... ]
}
```

`id` must be unique and stable — it is the database key and the deep link.
`/forms/#interest` opens that form directly, which is the link to put in an
email or on a slide.

### Field types

Every field takes `id`, `label`, optional `help`, and `required`.

| `type` | Renders as | Extra keys |
| --- | --- | --- |
| `short_text` | one-line input | `placeholder` |
| `long_text` | textarea | |
| `email` | input, checked for a real address | |
| `number` | numeric input | `min`, `max` |
| `single_select` | radio buttons | `options`, `allowOther` |
| `multi_select` | checkboxes | `options`, `allowOther`, `minChoices`, `maxChoices` |
| `dropdown` | a `<select>` | `options` |
| `scale` | linear 1–N | `min`, `max`, `minLabel`, `maxLabel` |
| `date` | date picker | |
| `timeslot` | a compact grid of checkboxes | `options`, `multiple`, `minChoices` |

```json
{ "id": "year", "type": "single_select", "label": "Year", "required": true,
  "options": ["First year", "Sophomore", "Junior", "Senior"] }
```

`allowOther` adds an "Other:" row with a write-in box. Without it, an answer
outside the option list is **rejected** — including from a hand-rolled POST, not
just from the page.

`timeslot` is `multi_select` with a grid layout and the availability chart on
the dashboard. Set `"multiple": false` to turn it into a single booking.

### Publishing the change

```
py -3 tools/make_seed.py
cd worker && wrangler d1 execute estimathon --remote --file=./seed.sql
```

then commit and push `forms.json`.

**No `wrangler deploy` needed** — the Worker reads forms from D1, not from its
own code. Re-seeding is safe at any time: it upserts by form id, and leaves each
form's open/closed status and every existing response untouched.

If you skip the push, the deployed site is still correct — but the no-backend
fallback (`forms.json` fetched directly) will be stale, so push anyway.

---

## Closing a form down

**For now:** press **Close form** on the dashboard. The form still appears in
the list, marked closed, and says so if someone follows an old link. Responses
stay readable and downloadable.

**For good:** export CSV and JSON first, then delete the entry from
`forms.json`, reseed, and push. Note that deleting a form from `forms.json`
does **not** delete its responses from D1 — the row stays until you drop it,
which is deliberate so a typo cannot destroy your data. To actually remove
them, delete rows from the dashboard first.

---

## Validation

Every rule is enforced in two places:

- `core.js` in the browser, so people are told before they hit submit;
- `worker/src/index.js` and `tools/server.py` on the server, which is the copy
  that counts.

If you add a rule, add it in both. A form post can come from anywhere.

## Where responses live

One row per submission in the `form_responses` table, with the answers as a
JSON object keyed by field id. Multi-select answers stay arrays.

That shape means adding a new field type never needs a database migration —
which is why the table has stayed the same while the type list has grown.
