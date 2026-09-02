/* ============================================================================
 * Estimathon API on Cloudflare Workers + D1.
 *
 * The pages stay on GitHub Pages; this is the shared brain behind them. It is
 * a straight port of server.py's API — same endpoints, same request and
 * response shapes, same rules — so the browser code needs no changes beyond
 * pointing config.js at this Worker.
 *
 * What the server decides, not the browser:
 *   - whether submissions are open, and whether THIS question is open
 *   - the per-team submission cap
 *   - bound validation
 *   - who may see the answer key, and the text of questions not yet asked
 *
 * Deploy:  see worker/README.md
 * ==========================================================================*/

const CONFIG_KEYS = [
  'eventName', 'maxSubmissions', 'contestOpen',
  'showLeaderboardToTeams', 'answersReleased',
];
const STATUSES = ['pending', 'open', 'closed'];
const MAX_BODY = 64 * 1024;

/* -------------------------------------------------------------------------- */
/* helpers                                                                    */
/* -------------------------------------------------------------------------- */

class ApiError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOW_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(payload, env, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...corsHeaders(env),
    },
  });
}

function uid(prefix) {
  return prefix + '_' + crypto.randomUUID().replace(/-/g, '').slice(0, 8);
}

async function readJson(request) {
  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > MAX_BODY) throw new ApiError('Request body is too large.', 413);
  const text = await request.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError('Body was not valid JSON.');
  }
}

/* Constant-time-ish compare so the passcode is not guessable by timing. It is
   a club event, not a bank, but this costs nothing. */
function codeMatches(given, expected) {
  if (!expected) return false;
  const a = String(given || '');
  const b = String(expected);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* -------------------------------------------------------------------------- */
/* reads                                                                      */
/* -------------------------------------------------------------------------- */

async function loadConfig(db) {
  const { results } = await db.prepare('SELECT key, value FROM config').all();
  const config = {};
  for (const row of results) {
    try {
      config[row.key] = JSON.parse(row.value);
    } catch {
      config[row.key] = row.value;
    }
  }
  return config;
}

async function getState(db, includeAnswers) {
  const config = await loadConfig(db);
  const reveal = includeAnswers || config.answersReleased === true;

  const [questions, teams, submissions] = await Promise.all([
    db.prepare('SELECT * FROM questions ORDER BY position').all(),
    db.prepare('SELECT * FROM teams ORDER BY joined_at').all(),
    db.prepare('SELECT * FROM submissions ORDER BY at').all(),
  ]);

  config.questions = questions.results.map((r) => {
    /* A question nobody has been shown yet keeps its text to itself, so a
       team cannot read ahead from the network tab. */
    const visible = includeAnswers || r.status !== 'pending';
    return {
      id: r.id,
      text: visible ? r.text : '',
      unit: visible ? r.unit : '',
      answer: reveal ? r.answer : null,
      status: r.status,
    };
  });

  return {
    config,
    teams: teams.results.map((r) => ({
      id: r.id, name: r.name, members: r.members, joinedAt: r.joined_at,
    })),
    submissions: submissions.results.map((r) => ({
      id: r.id, teamId: r.team_id, questionId: r.question_id,
      low: r.low, high: r.high, at: r.at,
    })),
  };
}

/* -------------------------------------------------------------------------- */
/* writes                                                                     */
/* -------------------------------------------------------------------------- */

async function join(db, body) {
  const name = String(body.name || '').trim();
  if (!name) throw new ApiError('Team name is required.');
  if (name.length > 60) throw new ApiError('That team name is too long.');
  const members = String(body.members || '').trim().slice(0, 200);

  const existing = await db.prepare('SELECT * FROM teams WHERE name = ?').bind(name).first();
  if (existing) return { team: shapeTeam(existing), rejoined: true };

  /* INSERT OR IGNORE then re-SELECT: if two devices sign the same team in at
     the same moment, one insert wins and both get the same team back. The
     name column is UNIQUE COLLATE NOCASE, so "Team" and "team" are one team. */
  await db.prepare(
    'INSERT OR IGNORE INTO teams (id, name, members, joined_at) VALUES (?, ?, ?, ?)'
  ).bind(uid('team'), name, members, Date.now()).run();

  const row = await db.prepare('SELECT * FROM teams WHERE name = ?').bind(name).first();
  if (!row) throw new ApiError('Could not sign that team in.', 500);
  return { team: shapeTeam(row), rejoined: false };
}

function shapeTeam(row) {
  return { id: row.id, name: row.name, members: row.members, joinedAt: row.joined_at };
}

async function submit(db, body) {
  const low = Number(body.low);
  const high = Number(body.high);
  if (!Number.isFinite(low) || !Number.isFinite(high)) {
    throw new ApiError('Both bounds must be numbers.');
  }
  if (!(low > 0 && high > 0)) throw new ApiError('Both bounds must be greater than zero.');
  if (high < low) throw new ApiError('The high bound must be at least the low bound.');

  const config = await loadConfig(db);
  if (config.contestOpen !== true) throw new ApiError('Submissions are closed.');

  const team = await db.prepare('SELECT 1 FROM teams WHERE id = ?')
    .bind(body.teamId).first();
  if (!team) {
    throw new ApiError('That team is no longer signed in. Rejoin to keep going.', 404);
  }

  const question = await db.prepare('SELECT status FROM questions WHERE id = ?')
    .bind(body.questionId).first();
  if (!question) throw new ApiError('Unknown question.');
  if (question.status === 'pending') throw new ApiError('That question has not been asked yet.');
  if (question.status === 'closed') {
    throw new ApiError('That question is closed. Answers are locked in.');
  }

  const cap = Number(config.maxSubmissions) || 18;
  const entry = {
    id: uid('sub'),
    teamId: body.teamId,
    questionId: body.questionId,
    low,
    high,
    at: Date.now(),
  };

  /* The cap is enforced inside the INSERT rather than by a read-then-write, so
     two submissions racing each other cannot both slip past number 18. */
  const result = await db.prepare(
    'INSERT INTO submissions (id, team_id, question_id, low, high, at) ' +
    'SELECT ?, ?, ?, ?, ?, ? ' +
    'WHERE (SELECT COUNT(*) FROM submissions WHERE team_id = ?) < ?'
  ).bind(entry.id, entry.teamId, entry.questionId, entry.low, entry.high, entry.at,
         entry.teamId, cap).run();

  if (!result.meta.changes) {
    throw new ApiError('Your team has used all ' + cap + ' submissions.');
  }
  return entry;
}

async function patchConfig(db, body) {
  const statements = [];
  for (const [key, value] of Object.entries(body)) {
    if (key === 'answer') {
      const v = value && value.value;
      statements.push(db.prepare('UPDATE questions SET answer = ? WHERE id = ?')
        .bind(v === null || v === undefined ? null : Number(v), value.questionId));
    } else if (CONFIG_KEYS.includes(key)) {
      statements.push(db.prepare(
        'INSERT INTO config (key, value) VALUES (?, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      ).bind(key, JSON.stringify(value)));
    } else if (key !== 'questions') {
      throw new ApiError('Unknown config key ' + key + '.');
    }
  }
  if (statements.length) await db.batch(statements);
  return { ok: true };
}

async function setQuestionStatus(db, questionId, status, exclusive = true) {
  if (!STATUSES.includes(status)) throw new ApiError('Unknown question status.');
  const exists = await db.prepare('SELECT 1 FROM questions WHERE id = ?')
    .bind(questionId).first();
  if (!exists) throw new ApiError('Unknown question.');

  const statements = [];
  if (status === 'open' && exclusive) {
    statements.push(db.prepare(
      "UPDATE questions SET status = 'closed' WHERE status = 'open' AND id != ?"
    ).bind(questionId));
  }
  statements.push(db.prepare('UPDATE questions SET status = ? WHERE id = ?')
    .bind(status, questionId));
  await db.batch(statements);
  return { ok: true };
}

/* Close whatever is open and open the next question never asked. The one
   button an organizer needs mid-event. */
async function advance(db) {
  const { results } = await db.prepare(
    'SELECT id, position, status FROM questions ORDER BY position'
  ).all();

  const current = results.find((r) => r.status === 'open') || null;
  const from = current ? current.position + 1 : 0;
  const next = results.find((r) => r.position >= from && r.status === 'pending') || null;

  const statements = [];
  if (current) {
    statements.push(db.prepare("UPDATE questions SET status = 'closed' WHERE id = ?")
      .bind(current.id));
  }
  if (next) {
    statements.push(db.prepare("UPDATE questions SET status = 'open' WHERE id = ?")
      .bind(next.id));
    // Advancing implies the contest is running.
    statements.push(db.prepare(
      "INSERT INTO config (key, value) VALUES ('contestOpen', 'true') " +
      "ON CONFLICT(key) DO UPDATE SET value = 'true'"
    ));
  }
  if (statements.length) await db.batch(statements);

  return { ok: true, finished: !next, opened: next ? next.id : null };
}

async function setAllQuestions(db, status) {
  if (!STATUSES.includes(status)) throw new ApiError('Unknown question status.');
  await db.prepare('UPDATE questions SET status = ?').bind(status).run();
  return { ok: true };
}

async function deleteTeam(db, teamId) {
  await db.batch([
    db.prepare('DELETE FROM submissions WHERE team_id = ?').bind(teamId),
    db.prepare('DELETE FROM teams WHERE id = ?').bind(teamId),
  ]);
  return { ok: true };
}

/* Clears teams and submissions and rewinds the run of play. Questions and the
   answer key stay. */
async function reset(db) {
  await db.batch([
    db.prepare('DELETE FROM submissions'),
    db.prepare('DELETE FROM teams'),
    db.prepare("UPDATE questions SET status = 'pending'"),
    db.prepare("UPDATE config SET value = 'false' WHERE key = 'contestOpen'"),
    db.prepare("UPDATE config SET value = 'false' WHERE key = 'answersReleased'"),
    db.prepare("UPDATE config SET value = 'false' WHERE key = 'showLeaderboardToTeams'"),
  ]);
  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/* routing                                                                    */
/* -------------------------------------------------------------------------- */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // Accept both /api/state and /state, so config.js can point at the Worker
    // root or at a /api path without anyone having to think about it.
    const path = url.pathname.replace(/^\/api/, '') || '/';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    if (!env.DB) {
      return json({ error: 'No D1 binding named DB. Check wrangler.toml.' }, env, 500);
    }

    try {
      if (request.method === 'GET') {
        if (path === '/state') {
          const isAdmin = codeMatches(url.searchParams.get('key'), env.ADMIN_CODE);
          return json(await getState(env.DB, isAdmin), env);
        }
        if (path === '/admin-check') {
          return json({ ok: codeMatches(url.searchParams.get('key'), env.ADMIN_CODE) }, env);
        }
        if (path === '/health') {
          const q = await env.DB.prepare('SELECT COUNT(*) AS n FROM questions').first();
          /* "adminCodeSet: false" has three different causes and they need
             different fixes, so say which one it is. `bindings` lists binding
             NAMES only — never a value — which is what tells you whether the
             secret landed on this Worker at all. */
          const code = env.ADMIN_CODE;
          const expected = ['DB', 'ADMIN_CODE', 'ALLOW_ORIGIN'];
          const extra = Object.keys(env).filter((k) => !expected.includes(k));

          /* Binding NAMES are not secret in themselves, but someone setting a
             secret up can easily name one after its own value, so this does
             not enumerate them unless asked. ?verbose=1 lists the unexpected
             ones, which is how you find a secret filed under the wrong name. */
          const verbose = url.searchParams.get('verbose') === '1';

          return json({
            ok: true,
            questions: q.n,
            adminCodeSet: typeof code === 'string' && code.length > 0,
            adminCode:
              code === undefined || code === null ? 'missing (not bound to this Worker)'
              : typeof code !== 'string' ? 'wrong type: ' + typeof code
              : code.length === 0 ? 'bound but empty'
              : code.trim().length !== code.length ? 'set, but has leading/trailing whitespace'
              : 'set',
            expected: Object.fromEntries(expected.map((k) => [k, k in env])),
            unexpectedBindings: verbose ? extra.sort() : extra.length,
          }, env);
        }
        return json({ error: 'No such endpoint.' }, env, 404);
      }

      if (request.method === 'POST') {
        const body = await readJson(request);
        switch (path) {
          case '/join':
            return json(await join(env.DB, body), env);
          case '/submit':
            return json(await submit(env.DB, body), env);
          case '/config':
            return json(await patchConfig(env.DB, body), env);
          case '/question':
            if (body.action === 'next') return json(await advance(env.DB), env);
            if (body.action === 'all') {
              return json(await setAllQuestions(env.DB, body.status), env);
            }
            return json(await setQuestionStatus(
              env.DB, body.questionId, body.status,
              body.exclusive !== false), env);
          case '/team/delete':
            return json(await deleteTeam(env.DB, body.teamId), env);
          case '/reset':
            return json(await reset(env.DB), env);
          default:
            return json({ error: 'No such endpoint.' }, env, 404);
        }
      }

      return json({ error: 'Method not allowed.' }, env, 405);
    } catch (err) {
      if (err instanceof ApiError) return json({ error: err.message }, env, err.status);
      return json({ error: 'Server error: ' + err.message }, env, 500);
    }
  },
};
