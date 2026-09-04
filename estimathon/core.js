/* ============================================================================
 * estimathon.js - shared core for the team page and the admin page.
 *
 * Responsibilities:
 *   1. CONFIG + the question set
 *   2. Store: read/write contest state, notify listeners
 *   3. Scoring: the Estimathon score for a team
 *30
 * STORAGE BACKENDS
 * ----------------
 * By default everything lives in localStorage and syncs between tabs on the
 * same machine via BroadcastChannel. That is enough to run the whole thing off
 * one laptop, and enough to develop against, but it does NOT sync between
 * devices - GitHub Pages serves static files and has nowhere to put shared
 * state.
 *
 * To run a real multi-device event, stand up the Python side as a small HTTP
 * service exposing:
 *      GET  {base}/state    -> the whole state object below
 *      POST {base}/join     -> { name, members }  -> { team }
 *      POST {base}/submit   -> { teamId, questionId, low, high }
 *      POST {base}/config   -> partial config patch (admin)
 * then set  window.ESTIMATHON_API = "https://your-host"  in a <script> before
 * this file loads. Nothing else in the app changes.
 * ==========================================================================*/
(function (global) {
  'use strict';

  var STORAGE_KEY = 'estimathon:v1';
  var CHANNEL_NAME = 'estimathon';
  var POLL_MS = 3000;

  /* --------------------------------------------------------------------- */
  /* Questions                                                              */
  /* --------------------------------------------------------------------- */
  /* `answer` is the truth value used for grading. Leave it null and fill it
     in from the admin page (or from the Python grader's answer key) - the
     scoreboard grades only the questions that have an answer, so you can run
     a provisional scoreboard mid-event and reveal the rest at the end. */
  var DEFAULT_QUESTIONS = [
    { id: 'q1',  text: 'How many traffic lights are in Miami-Dade County?', answer: null},
    { id: 'q2',  text: 'What is the volume of Lake Eerie in cubic miles?', answer: null, unit: 'cubic miles' },
    { id: 'q3',  text: 'What is the probability of getting a four-of-a-kind in a standard 5-card hand? (answer n, where the probability is 1/n', answer: null },
    { id: 'q4',  text: 'What is the largest number of earths that can fit inside of Neptune?', answer: null },
    { id: 'q5',  text: 'How many digits are in the fully written-out number 65 factorial?', answer: null },
    { id: 'q6',  text: 'If you fold a piece of paper 67 times over itself, how tall would it be?', answer: null, unit: 'millions of miles' },
    { id: 'q7',  text: 'How many lines of code is the kernel for linux 6.14, released Spring 2025?', answer: null },
    { id: 'q8',  text: 'How many times does the average human blink in a single year?', answer: null },
    { id: 'q9',  text: 'How many social security numbers are primes?', answer: null },
    { id: 'q10', text: 'How many pizzas are delivered in New York City on a typical Friday Night?', answer: null },
    { id: 'q11', text: 'How many tennis balls would it take to fill an olympic sized swimming pool?', answer: null },
    { id: 'q12', text: 'How many rice grains are consumed in the U.S. per year?', answer: null },
    { id: 'q13', text: 'How many coin flips do you need to do before you expect to flip 10 heads in a row?', answer: null },
    { id: 'q14', text: 'What is the estimated number of legal positions in Chess? (answer n, where the answer is 4.8 * 10^n)', answer: null },
    { id: 'q15', text: 'You have two standard 52-card decks of playing cards. Both are shuffled completely randomly. You flip cards over one by one from both decks simultaneously. What is the percentage chance (expressed as a number from 0 to 100) that you go through all 52 cards without ever getting an exact match? (answer as $n%$)', answer: null },
  ];

  var CONFIG_DEFAULTS = {
    eventName: 'JMU MIMF Estimathon',
    /* Standard rules: 30 submissions total, spread across the 15 questions
       however the team likes. Only a team's most recent interval per question
       counts toward the final score. */
    maxSubmissions: 30,
    /* Scoring constants. These MUST match WIDTH_WEIGHT and UNANSWERED_PENALTY
       in score.py — `py -3 score.py --selftest` fails if they drift. */
    widthWeight: 0.07,
    unansweredPenalty: 10,
    contestOpen: false,
    showLeaderboardToTeams: false,
    /* Until an admin flips this, the team page never shows an answer or a
       graded result. Note the caveat in the README: in browser-local mode the
       answers are still sitting in this file for anyone who opens devtools.
       server.py withholds them properly. */
    answersReleased: false,
    questions: DEFAULT_QUESTIONS
  };

  /* --------------------------------------------------------------------- */
  /* Helpers                                                                */
  /* --------------------------------------------------------------------- */

  function uid(prefix) {
    return (prefix || 'id') + '_' + Math.random().toString(36).slice(2, 10);
  }

  function clone(v) { return JSON.parse(JSON.stringify(v)); }

  /* Accepts what people actually type: 1,200,000 / 1.2e6 / 3.4 million / 5k */
  function parseNumber(raw) {
    if (raw == null) return NaN;
    var s = String(raw).trim().toLowerCase();
    if (!s) return NaN;
    s = s.replace(/,/g, '').replace(/\$/g, '');
    var mult = 1;
    var suffix = s.match(/\s*(k|thousand|m|million|b|billion|t|trillion)$/);
    if (suffix) {
      var word = suffix[1];
      mult = (word === 'k' || word === 'thousand') ? 1e3
           : (word === 'm' || word === 'million')  ? 1e6
           : (word === 'b' || word === 'billion')  ? 1e9
           : 1e12;
      s = s.slice(0, suffix.index).trim();
    }
    if (!/^-?\d*\.?\d+(e-?\d+)?$/.test(s)) return NaN;
    return parseFloat(s) * mult;
  }

  function formatNumber(n) {
    if (n == null || !isFinite(n)) return '—';
    var abs = Math.abs(n);
    if (abs !== 0 && (abs >= 1e12 || abs < 1e-3)) return n.toExponential(3);
    return n.toLocaleString(undefined, { maximumFractionDigits: abs < 100 ? 2 : 0 });
  }

  function formatScore(n) {
    if (n == null || !isFinite(n)) return '—';
    if (n >= 1e6) return n.toExponential(3);
    return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }

  function timeAgo(ts) {
    var s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    return Math.floor(s / 3600) + 'h ago';
  }

  function emptyState() {
    return { config: clone(CONFIG_DEFAULTS), teams: [], submissions: [] };
  }

  /* Fill in anything a saved state predates, so an old tab never crashes. */
  function normalize(state) {
    var s = state && typeof state === 'object' ? state : {};
    s.config = Object.assign({}, CONFIG_DEFAULTS, s.config || {});
    /* With a server, the server's question list is the only one that counts:
       it withholds the text of questions that have not been asked and the
       answers until they are released, and it strips DEFAULT_QUESTIONS out of
       this file on its way to the browser. Never paper over that with a local
       copy. */
    s.config.questions = API
      ? (Array.isArray(s.config.questions) ? s.config.questions : [])
      : reconcileQuestions(s.config.questions);
    s.teams = Array.isArray(s.teams) ? s.teams : [];
    s.submissions = Array.isArray(s.submissions) ? s.submissions : [];
    return s;
  }

  /* Saved state can carry an older question set — someone edited
     DEFAULT_QUESTIONS after a browser had already stored a copy. Without this,
     adding a question to the file would be invisible to anyone who had opened
     the page before.

     Same ids  -> keep the stored answer key (the admin may have corrected it
                  mid-event) but refresh the wording from the file.
     Different -> the file changed; take it wholesale. */
  function reconcileQuestions(saved) {
    if (!Array.isArray(saved) || !saved.length) return clone(DEFAULT_QUESTIONS);

    var savedIds = saved.map(function (q) { return q && q.id; }).join('|');
    var defaultIds = DEFAULT_QUESTIONS.map(function (q) { return q.id; }).join('|');
    if (savedIds !== defaultIds) return clone(DEFAULT_QUESTIONS);

    var byId = {};
    saved.forEach(function (q) { byId[q.id] = q; });
    return DEFAULT_QUESTIONS.map(function (q) {
      var copy = clone(q);
      var prev = byId[q.id];
      if (prev) {
        if (Object.prototype.hasOwnProperty.call(prev, 'answer')) copy.answer = prev.answer;
        copy.status = prev.status || 'pending';
      } else {
        copy.status = 'pending';
      }
      return copy;
    });
  }

  /* Every question starts 'pending' — unseen by teams — and an admin moves it
     to 'open' and then 'closed'. Running all fifteen at once is just opening
     them all, which is one button on the dashboard. */
  function questionStatus(q) {
    return (q && q.status) || 'pending';
  }

  /* --------------------------------------------------------------------- */
  /* Store                                                                  */
  /* --------------------------------------------------------------------- */

  var API = global.ESTIMATHON_API || null;
  var listeners = [];
  var cache = null;
  var channel = null;

  try {
    if (global.BroadcastChannel) channel = new BroadcastChannel(CHANNEL_NAME);
  } catch (e) { channel = null; }

  function readLocal() {
    try {
      var raw = global.localStorage.getItem(STORAGE_KEY);
      return normalize(raw ? JSON.parse(raw) : null);
    } catch (e) {
      return emptyState();
    }
  }

  function writeLocal(state) {
    try {
      global.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      console.warn('Estimathon: could not persist state', e);
    }
  }

  function notify() {
    var state = Store.state();
    listeners.forEach(function (fn) {
      try { fn(state); } catch (e) { console.error(e); }
    });
  }

  function commit(state) {
    cache = state;
    if (!API) {
      writeLocal(state);
      if (channel) { try { channel.postMessage({ type: 'changed' }); } catch (e) {} }
    }
    notify();
  }

  function post(path, body) {
    return fetch(API + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) {
      if (!r.ok) throw new Error(path + ' failed: ' + r.status);
      return r.json();
    });
  }

  var adminKey = null;

  var Store = {
    usingRemote: !!API,

    state: function () {
      if (!cache) cache = API ? emptyState() : readLocal();
      return cache;
    },

    /* The admin page calls this after the passcode is accepted. The server
       blanks the answer key for every request without it, so the organizers
       can see the answers while the teams genuinely cannot. */
    setAdminKey: function (key) {
      adminKey = key || null;
      return Store.refresh();
    },

    /* Ask the server whether a passcode is the organizer one. Resolves false
       in browser-local mode, where there is no server to ask. */
    checkAdminKey: function (key) {
      if (!API) return Promise.resolve(false);
      return fetch(API + '/admin-check?key=' + encodeURIComponent(key))
        .then(function (r) { return r.json(); })
        .then(function (j) { return !!j.ok; })
        .catch(function () { return false; });
    },

    /* Re-read from the backing store and tell everyone. */
    refresh: function () {
      if (!API) { cache = readLocal(); notify(); return Promise.resolve(cache); }
      return fetch(API + '/state' + (adminKey ? '?key=' + encodeURIComponent(adminKey) : ''))
        .then(function (r) { return r.json(); })
        .then(function (s) { cache = normalize(s); notify(); return cache; })
        .catch(function (e) { console.warn('Estimathon: /state failed', e); return cache; });
    },

    subscribe: function (fn) {
      listeners.push(fn);
      fn(Store.state());
      return function () {
        listeners = listeners.filter(function (l) { return l !== fn; });
      };
    },

    /* Local-only mutation helper. With a remote backend the server owns the
       write and we just re-read. */
    update: function (mutator) {
      var next = normalize(clone(Store.state()));
      mutator(next);
      commit(next);
      return next;
    },

    /* ----- actions ----------------------------------------------------- */

    /* Joining with a name that already exists re-attaches you to that team, so
       a refresh or a second device does not orphan anybody. */
    joinTeam: function (name, members) {
      var trimmed = String(name || '').trim();
      if (!trimmed) return Promise.reject(new Error('Team name is required.'));

      if (API) return post('/join', { name: trimmed, members: members || '' })
        .then(function (r) { Store.refresh(); return r; });

      var existing = Store.state().teams.filter(function (t) {
        return t.name.toLowerCase() === trimmed.toLowerCase();
      })[0];
      if (existing) return Promise.resolve({ team: existing, rejoined: true });

      var team = {
        id: uid('team'),
        name: trimmed,
        members: String(members || '').trim(),
        joinedAt: Date.now()
      };
      Store.update(function (s) { s.teams.push(team); });
      return Promise.resolve({ team: team, rejoined: false });
    },

    submit: function (teamId, questionId, low, high) {
      var entry = {
        id: uid('sub'),
        teamId: teamId,
        questionId: questionId,
        low: low,
        high: high,
        at: Date.now()
      };
      if (API) return post('/submit', entry).then(function (r) { Store.refresh(); return r; });
      Store.update(function (s) { s.submissions.push(entry); });
      return Promise.resolve(entry);
    },

    patchConfig: function (patch) {
      if (API) return post('/config', patch).then(Store.refresh);
      Store.update(function (s) { Object.assign(s.config, patch); });
      return Promise.resolve();
    },

    setAnswer: function (questionId, value) {
      if (API) return post('/config', { answer: { questionId: questionId, value: value } })
        .then(Store.refresh);
      Store.update(function (s) {
        s.config.questions.forEach(function (q) {
          if (q.id === questionId) q.answer = value;
        });
      });
      return Promise.resolve();
    },

    /* ----- run of play -------------------------------------------------- */

    /* Move one question. exclusive (the default) closes whatever else was
       open, which is what "one question at a time" means. */
    setQuestionStatus: function (questionId, status, exclusive) {
      var only = exclusive !== false;
      if (API) {
        return post('/question', { questionId: questionId, status: status, exclusive: only })
          .then(Store.refresh);
      }
      Store.update(function (s) {
        s.config.questions.forEach(function (q) {
          if (q.id === questionId) q.status = status;
          else if (only && status === 'open' && q.status === 'open') q.status = 'closed';
        });
      });
      return Promise.resolve();
    },

    /* Close whatever is open, open the next unasked question. */
    nextQuestion: function () {
      if (API) return post('/question', { action: 'next' }).then(Store.refresh);

      var result = { finished: true, opened: null };
      Store.update(function (s) {
        var qs = s.config.questions;
        var currentIndex = -1;
        qs.forEach(function (q, i) {
          if (questionStatus(q) === 'open') { q.status = 'closed'; currentIndex = i; }
        });
        for (var i = currentIndex + 1; i < qs.length; i++) {
          if (questionStatus(qs[i]) === 'pending') {
            qs[i].status = 'open';
            s.config.contestOpen = true;
            result = { finished: false, opened: qs[i].id };
            return;
          }
        }
      });
      return Promise.resolve(result);
    },

    /* Every question at once: the classic format, or a hard stop at the end. */
    setAllQuestions: function (status) {
      if (API) {
        return post('/question', { action: 'all', status: status }).then(Store.refresh);
      }
      Store.update(function (s) {
        s.config.questions.forEach(function (q) { q.status = status; });
        if (status === 'open') s.config.contestOpen = true;
      });
      return Promise.resolve();
    },

    removeTeam: function (teamId) {
      if (API) return post('/team/delete', { teamId: teamId }).then(Store.refresh);
      Store.update(function (s) {
        s.teams = s.teams.filter(function (t) { return t.id !== teamId; });
        s.submissions = s.submissions.filter(function (x) { return x.teamId !== teamId; });
      });
      return Promise.resolve();
    },

    /* Clears teams and submissions and rewinds the run of play. The question
       set and answer key come back from estimathon.js / the server. */
    reset: function () {
      if (API) return post('/reset', {}).then(Store.refresh);
      commit(emptyState());
      return Promise.resolve();
    },

    /* The shape the Python grader should expect. */
    exportJSON: function () {
      var s = Store.state();
      return JSON.stringify({
        exportedAt: new Date().toISOString(),
        config: s.config,
        teams: s.teams,
        submissions: s.submissions,
        scoreboard: Scoring.leaderboard(s).map(function (r) {
          return {
            team: r.team.name, score: r.score, correct: r.correct,
            missed: r.missed, unanswered: r.unanswered, graded: r.graded,
            submissionsUsed: r.used
          };
        })
      }, null, 2);
    },

    importJSON: function (text) {
      commit(normalize(JSON.parse(text)));
    }
  };

  /* Cross-tab + remote polling */
  if (channel) channel.onmessage = function () { cache = readLocal(); notify(); };
  global.addEventListener('storage', function (e) {
    if (e.key === STORAGE_KEY) { cache = readLocal(); notify(); }
  });
  /* Polling budget: every open tab hits the backend on this interval, and
     Cloudflare's free tier allows 100k requests a day. A backgrounded tab is
     nobody's live view, so it stops polling entirely and catches up the moment
     it comes back. 20 teams at 3s is ~24k requests an hour with every tab in
     the foreground, which a whole event fits inside comfortably. */
  if (API) {
    Store.refresh();
    setInterval(function () {
      if (!global.document || !global.document.hidden) Store.refresh();
    }, POLL_MS);

    if (global.document) {
      global.document.addEventListener('visibilitychange', function () {
        if (!global.document.hidden) Store.refresh();
      });
    }
  }

  /* --------------------------------------------------------------------- */
  /* Scoring                                                                */
  /* --------------------------------------------------------------------- */
  /*  Per question, for an interval [a, b] against the true answer n:
   *
   *      e_i  = 0                        if a <= n <= b
   *           = log2(max(a/n, n/b))      otherwise  (how far off, in octaves)
   *
   *      score_i = widthWeight * (b / a) + e_i
   *
   *  A team's score is the sum over all questions; an unanswered question
   *  costs unansweredPenalty. Lower wins.
   *
   *  This mirrors score_i / e_i in score.py. Change both together.
   */
  var Scoring = {
    /* One question. Returns { score, status } with status
       'ok' | 'missed' | 'unanswered' | 'ungraded'. */
    scoreQuestion: function (cfg, sub, answer) {
      if (answer == null || !isFinite(answer)) return { score: 0, status: 'ungraded' };
      if (!sub) return { score: cfg.unansweredPenalty, status: 'unanswered' };

      var a = sub.low, b = sub.high;
      if (!(a > 0) || !(b > 0) || b < a) {
        /* Should be unreachable — the form rejects these — but never let one
           bad row take the whole scoreboard down. */
        return { score: cfg.unansweredPenalty, status: 'unanswered' };
      }

      var width = cfg.widthWeight * (b / a);
      if (a <= answer && answer <= b) return { score: width, status: 'ok' };

      var off = Math.max(Math.abs(a / answer), Math.abs(answer / b));
      return { score: width + Math.log2(off), status: 'missed' };
    },

    latestSubmission: function (state, teamId, questionId) {
      var found = null;
      state.submissions.forEach(function (s) {
        if (s.teamId === teamId && s.questionId === questionId) {
          if (!found || s.at >= found.at) found = s;
        }
      });
      return found;
    },

    submissionCount: function (state, teamId) {
      return state.submissions.filter(function (s) { return s.teamId === teamId; }).length;
    },

    submissionsLeft: function (state, teamId) {
      return Math.max(0, state.config.maxSubmissions - Scoring.submissionCount(state, teamId));
    },

    isCorrect: function (sub, answer) {
      if (!sub || answer == null || !isFinite(answer)) return false;
      return answer >= sub.low && answer <= sub.high;
    },

    scoreTeam: function (state, team) {
      var cfg = state.config;
      var total = 0, correct = 0, missed = 0, unanswered = 0, graded = 0, answered = 0;
      var perQuestion = {};

      cfg.questions.forEach(function (q) {
        var sub = Scoring.latestSubmission(state, team.id, q.id);
        if (sub) answered++;

        var r = Scoring.scoreQuestion(cfg, sub, q.answer);
        perQuestion[q.id] = r;
        if (r.status === 'ungraded') return;

        graded++;
        total += r.score;
        if (r.status === 'ok') correct++;
        else if (r.status === 'missed') missed++;
        else unanswered++;
      });

      return {
        team: team,
        score: graded ? total : null,
        perQuestion: perQuestion,
        correct: correct,
        missed: missed,
        unanswered: unanswered,
        graded: graded,
        answered: answered,
        used: Scoring.submissionCount(state, team.id),
        /* true once every question has an answer-key entry */
        final: graded === cfg.questions.length
      };
    },

    leaderboard: function (state) {
      return state.teams
        .map(function (t) { return Scoring.scoreTeam(state, t); })
        .sort(function (a, b) {
          if (a.score == null && b.score == null) return a.team.name.localeCompare(b.team.name);
          if (a.score == null) return 1;
          if (b.score == null) return -1;
          return a.score - b.score;
        });
    }
  };

  global.Estimathon = {
    Store: Store,
    Scoring: Scoring,
    DEFAULT_QUESTIONS: DEFAULT_QUESTIONS,
    questionStatus: questionStatus,
    parseNumber: parseNumber,
    formatNumber: formatNumber,
    formatScore: formatScore,
    timeAgo: timeAgo,
    STORAGE_KEY: STORAGE_KEY
  };
})(window);
