/* ============================================================================
 * admin.js — the organizer dashboard: who joined, what they submitted,
 * where they stand, and the answer key that drives scoring.
 * ==========================================================================*/
(function () {
  'use strict';

  var Store = Estimathon.Store;
  var Scoring = Estimathon.Scoring;
  var fmt = Estimathon.formatNumber;
  var fmtScore = Estimathon.formatScore;
  var parseNumber = Estimathon.parseNumber;
  var timeAgo = Estimathon.timeAgo;

  var UNLOCK_KEY = 'estimathon:adminUnlocked';

  /* LOCAL-ONLY passcode, used when there is no backend at all. This file is
     public — GitHub Pages serves it verbatim — so treat this string as
     published, not secret.
     In production the Worker's ADMIN_CODE secret is what gates the answer key,
     and it MUST be a different string from this one, or reading this file is
     enough to get in.
     server.py reads this line by its marker comment, so the variable can be
     called anything but the marker has to stay. Declared up here because the
     session-restore check below runs during load. */
  var ignore = 'loverboykeegan'; /* admin-passcode */

  var el = {
    gateView:    document.getElementById('gate-view'),
    gateForm:    document.getElementById('gate-form'),
    gateInput:   document.getElementById('gate-input'),
    gateError:   document.getElementById('gate-error'),
    adminView:   document.getElementById('admin-view'),
    liveDot:     document.getElementById('live-dot'),

    eventName:   document.getElementById('admin-event-name'),
    toggleOpen:  document.getElementById('toggle-open'),
    toggleBoard: document.getElementById('toggle-leaderboard'),
    toggleAnswers: document.getElementById('toggle-answers'),
    exportBtn:   document.getElementById('export-btn'),
    exportCsv:   document.getElementById('export-csv-btn'),
    importBtn:   document.getElementById('import-btn'),
    importFile:  document.getElementById('import-file'),
    resetBtn:    document.getElementById('reset-btn'),

    ropProgress: document.getElementById('rop-progress'),
    ropLabel:    document.getElementById('rop-label'),
    ropText:     document.getElementById('rop-text'),
    ropAnswer:   document.getElementById('rop-answer'),
    ropNext:     document.getElementById('rop-next'),
    ropClose:    document.getElementById('rop-close'),
    ropReopen:   document.getElementById('rop-reopen'),
    ropStrip:    document.getElementById('rop-strip'),
    ropOpenAll:  document.getElementById('rop-open-all'),
    ropCloseAll: document.getElementById('rop-close-all'),

    statTeams:   document.getElementById('stat-teams'),
    statSubs:    document.getElementById('stat-subs'),
    statGraded:  document.getElementById('stat-graded'),
    statStatus:  document.getElementById('stat-status'),

    scoreboard:  document.querySelector('#scoreboard tbody'),
    boardNote:   document.getElementById('scoreboard-note'),
    feed:        document.getElementById('feed'),
    feedCount:   document.getElementById('feed-count'),
    keyBody:     document.querySelector('#answer-key tbody'),
    gridHead:    document.querySelector('#answer-grid thead'),
    gridBody:    document.querySelector('#answer-grid tbody')
  };

  /* -------------------------------------------------------------- the gate */

  var unlocked = false;

  function unlock(code) {
    if (unlocked) return;
    unlocked = true;
    el.gateView.hidden = true;
    el.adminView.hidden = false;
    if (Store.usingRemote) Store.setAdminKey(code);
    Store.subscribe(render);
  }

  /* Server present -> the server decides. Browser-local -> the constant above
     is all there is. */
  function verify(code) {
    if (Store.usingRemote) return Store.checkAdminKey(code);
    return Promise.resolve(code.toLowerCase() === ignore.toLowerCase());
  }

  el.gateForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var code = el.gateInput.value.trim();
    verify(code).then(function (ok) {
      if (!ok) {
        el.gateError.hidden = false;
        el.gateInput.select();
        return;
      }
      try { sessionStorage.setItem(UNLOCK_KEY, code); } catch (e2) {}
      unlock(code);
    });
  });

  /* Restore an unlocked session on refresh. */
  try {
    var saved = sessionStorage.getItem(UNLOCK_KEY);
    if (saved) verify(saved).then(function (ok) { if (ok) unlock(saved); });
  } catch (e) { /* private mode: just show the gate */ }

  /* ------------------------------------------------------------- controls  */

  el.toggleOpen.addEventListener('click', function () {
    Store.patchConfig({ contestOpen: !Store.state().config.contestOpen });
  });

  el.toggleBoard.addEventListener('change', function () {
    Store.patchConfig({ showLeaderboardToTeams: el.toggleBoard.checked });
  });

  /* Releasing answers is one-way in practice — once teams have seen them the
     event is over — so make it deliberate. */
  el.toggleAnswers.addEventListener('change', function () {
    var warning = 'Show every answer, and each team their own results, on the ' +
                  'team page?\n\nDo this only after submissions are closed.';
    if (el.toggleAnswers.checked && !confirm(warning)) {
      el.toggleAnswers.checked = false;
      return;
    }
    Store.patchConfig({ answersReleased: el.toggleAnswers.checked });
  });

  /* ------------------------------------------------------------ run of play */

  function currentQuestion(state) {
    var found = null;
    state.config.questions.forEach(function (q, i) {
      if (Estimathon.questionStatus(q) === 'open' && !found) found = { q: q, n: i + 1 };
    });
    return found;
  }

  function nextPending(state) {
    var found = null;
    state.config.questions.forEach(function (q, i) {
      if (!found && Estimathon.questionStatus(q) === 'pending') found = { q: q, n: i + 1 };
    });
    return found;
  }

  el.ropNext.addEventListener('click', function () {
    var state = Store.state();
    var open = currentQuestion(state);
    if (open && !confirm('Close question ' + open.n + ' and move on?\n\n' +
                         'Teams can no longer change their interval for it.')) return;
    Store.nextQuestion();
  });

  el.ropClose.addEventListener('click', function () {
    var open = currentQuestion(Store.state());
    if (!open) return;
    Store.setQuestionStatus(open.q.id, 'closed');
  });

  /* Escape hatch: closed a question by accident, or gave a team more time. */
  el.ropReopen.addEventListener('click', function () {
    var state = Store.state();
    var last = null;
    state.config.questions.forEach(function (q, i) {
      if (Estimathon.questionStatus(q) === 'closed') last = { q: q, n: i + 1 };
    });
    if (!last) return;
    Store.setQuestionStatus(last.q.id, 'open');
  });

  el.ropOpenAll.addEventListener('click', function () {
    if (!confirm('Show all questions at once?\n\nThis is the classic format — ' +
                 'teams work through every question in one sitting.')) return;
    Store.setAllQuestions('open').then(function () {
      Store.patchConfig({ contestOpen: true });
    });
  });

  el.ropCloseAll.addEventListener('click', function () {
    if (!confirm('Close every question? Teams can no longer submit anything.')) return;
    Store.setAllQuestions('closed');
  });

  function renderRunOfPlay(state) {
    var questions = state.config.questions;
    var open = currentQuestion(state);
    var upNext = nextPending(state);
    var closedCount = questions.filter(function (q) {
      return Estimathon.questionStatus(q) === 'closed';
    }).length;

    el.ropProgress.textContent = open
      ? 'question ' + open.n + ' of ' + questions.length + ' — open'
      : (closedCount ? closedCount + ' of ' + questions.length + ' asked' : 'not started');
    el.ropProgress.className = 'pill ' + (open ? 'pill-open-dark' : 'pill-muted');

    if (open) {
      el.ropLabel.textContent = 'Now asking';
      el.ropText.textContent = open.n + '. ' + open.q.text;
      el.ropAnswer.textContent = open.q.answer != null
        ? 'Answer: ' + fmt(open.q.answer) + (open.q.unit ? ' ' + open.q.unit : '')
        : '';
    } else if (upNext) {
      el.ropLabel.textContent = 'Up next';
      el.ropText.textContent = upNext.n + '. ' + upNext.q.text;
      el.ropAnswer.textContent = '';
    } else {
      el.ropLabel.textContent = 'Done';
      el.ropText.textContent = 'Every question has been asked.';
      el.ropAnswer.textContent = '';
    }

    el.ropNext.disabled = !upNext;
    el.ropNext.textContent = open ? 'Close & next question'
                           : (upNext ? 'Ask question ' + upNext.n : 'No questions left');
    el.ropClose.disabled = !open;
    el.ropReopen.disabled = !closedCount || !!open;

    /* The strip: one chip per question, click to jump. */
    el.ropStrip.textContent = '';
    questions.forEach(function (q, i) {
      var status = Estimathon.questionStatus(q);
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip chip-' + status;
      chip.textContent = i + 1;
      chip.title = (q.text || '(not yet shown to teams)') + ' — ' + status;
      chip.addEventListener('click', function () {
        if (status === 'open') return Store.setQuestionStatus(q.id, 'closed');
        Store.setQuestionStatus(q.id, 'open');
      });
      el.ropStrip.appendChild(chip);
    });
  }

  el.exportBtn.addEventListener('click', function () {
    download('estimathon-' + stamp() + '.json', Store.exportJSON(), 'application/json');
  });

  el.exportCsv.addEventListener('click', function () {
    download('estimathon-submissions-' + stamp() + '.csv', toCSV(Store.state()), 'text/csv');
  });

  el.importBtn.addEventListener('click', function () { el.importFile.click(); });

  el.importFile.addEventListener('change', function () {
    var file = el.importFile.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        Store.importJSON(String(reader.result));
      } catch (err) {
        alert('That file could not be read as an Estimathon export.\n\n' + err.message);
      }
      el.importFile.value = '';
    };
    reader.readAsText(file);
  });

  el.resetBtn.addEventListener('click', function () {
    var teams = Store.state().teams.length;
    var subs = Store.state().submissions.length;
    if (!confirm('Delete all ' + teams + ' teams and ' + subs + ' submissions, and ' +
                 'restore the default questions?\n\nExport first if you want a record. ' +
                 'This cannot be undone.')) return;
    Store.reset();
  });

  /* -------------------------------------------------------------- render   */

  function render(state) {
    var cfg = state.config;
    var board = Scoring.leaderboard(state);
    var keyed = cfg.questions.filter(function (q) {
      return q.answer != null && isFinite(q.answer);
    }).length;

    el.eventName.textContent = cfg.eventName;

    /* Say plainly where the data lives — organizers need to know whether
       other devices can see this. */
    el.liveDot.textContent = Store.usingRemote ? 'Server' : 'This device only';
    el.liveDot.className = 'pill ' + (Store.usingRemote ? 'pill-live' : 'pill-muted');
    el.liveDot.title = Store.usingRemote
      ? 'Reading from the configured Estimathon API.'
      : 'No backend configured: teams must submit from tabs on this machine.';

    el.toggleOpen.textContent = cfg.contestOpen ? 'Close submissions' : 'Open submissions';
    el.toggleOpen.className = 'btn ' + (cfg.contestOpen ? 'btn-danger' : 'btn-primary');
    el.toggleBoard.checked = !!cfg.showLeaderboardToTeams;
    el.toggleAnswers.checked = !!cfg.answersReleased;

    el.statTeams.textContent = state.teams.length;
    el.statSubs.textContent = state.submissions.length;
    el.statGraded.textContent = keyed + ' / ' + cfg.questions.length;
    el.statStatus.textContent = cfg.contestOpen ? 'Open' : 'Closed';

    el.boardNote.textContent = keyed === cfg.questions.length ? 'final' : 'provisional';

    renderRunOfPlay(state);
    renderScoreboard(board);
    renderFeed(state);
    renderAnswerKey(state);
    renderGrid(state);
  }

  function renderScoreboard(board) {
    el.scoreboard.textContent = '';
    if (!board.length) return emptyRow(el.scoreboard, 8, 'No teams have signed in yet.');

    board.forEach(function (r, i) {
      var tr = document.createElement('tr');
      if (i === 0 && r.score != null) tr.className = 'leader';

      cell(tr, i + 1, 'rank');
      cell(tr, r.team.name);
      cell(tr, fmtScore(r.score), 'num');
      cell(tr, r.graded ? r.correct + ' / ' + r.graded : '—', 'num');
      cell(tr, r.graded ? String(r.missed) : '—', 'num');
      cell(tr, r.graded ? String(r.unanswered) : '—', 'num');
      cell(tr, r.used + ' / ' + Store.state().config.maxSubmissions, 'num');

      var td = document.createElement('td');
      var btn = document.createElement('button');
      btn.className = 'btn btn-quiet';
      btn.type = 'button';
      btn.textContent = 'Remove';
      btn.addEventListener('click', function () {
        if (confirm('Remove "' + r.team.name + '" and all of their submissions?')) {
          Store.removeTeam(r.team.id);
        }
      });
      td.appendChild(btn);
      tr.appendChild(td);

      el.scoreboard.appendChild(tr);
    });
  }

  function renderFeed(state) {
    var teamsById = {};
    state.teams.forEach(function (t) { teamsById[t.id] = t; });
    var qById = {};
    state.config.questions.forEach(function (q, i) { qById[q.id] = { q: q, n: i + 1 }; });

    var recent = state.submissions.slice().sort(function (a, b) { return b.at - a.at; }).slice(0, 60);

    el.feedCount.textContent = state.submissions.length;
    el.feed.textContent = '';

    if (!recent.length) {
      var li = document.createElement('li');
      li.innerHTML = '<span class="empty">Nothing submitted yet.</span>';
      el.feed.appendChild(li);
      return;
    }

    recent.forEach(function (s) {
      var team = teamsById[s.teamId];
      var meta = qById[s.questionId];
      var li = document.createElement('li');

      var left = document.createElement('div');
      var who = document.createElement('span');
      who.className = 'who';
      who.textContent = team ? team.name : '(removed team)';
      var what = document.createElement('div');
      what.className = 'what';
      what.textContent = 'Q' + (meta ? meta.n : '?') + '  ' +
                         fmt(s.low) + ' – ' + fmt(s.high) +
                         '  (×' + (s.high / s.low).toFixed(2) + ')';
      left.appendChild(who);
      left.appendChild(what);

      var when = document.createElement('span');
      when.className = 'when';
      when.textContent = timeAgo(s.at);

      li.appendChild(left);
      li.appendChild(when);
      el.feed.appendChild(li);
    });
  }

  function renderAnswerKey(state) {
    /* Don't stomp on a field the organizer is mid-edit. */
    var focused = document.activeElement;
    var focusedQ = focused && focused.classList.contains('key-input') ? focused.dataset.qid : null;
    var focusedValue = focusedQ ? focused.value : null;

    el.keyBody.textContent = '';

    state.config.questions.forEach(function (q, i) {
      var tr = document.createElement('tr');
      cell(tr, i + 1, 'rank');
      cell(tr, q.text + (q.unit ? ' (' + q.unit + ')' : ''), 'q-cell');

      var tdInput = document.createElement('td');
      tdInput.className = 'num';
      var input = document.createElement('input');
      input.type = 'text';
      input.className = 'key-input';
      input.dataset.qid = q.id;
      input.placeholder = 'unset';
      input.value = q.id === focusedQ ? focusedValue
                  : (q.answer != null && isFinite(q.answer) ? String(q.answer) : '');
      input.addEventListener('change', function () {
        var raw = input.value.trim();
        if (!raw) return Store.setAnswer(q.id, null);
        var v = parseNumber(raw);
        if (!isFinite(v)) {
          input.value = q.answer != null ? String(q.answer) : '';
          return alert('"' + raw + '" is not a number I can read.');
        }
        Store.setAnswer(q.id, v);
      });
      tdInput.appendChild(input);
      tr.appendChild(tdInput);

      /* How many teams currently bracket this answer? */
      var bracketed = 0, attempted = 0;
      state.teams.forEach(function (t) {
        var sub = Scoring.latestSubmission(state, t.id, q.id);
        if (!sub) return;
        attempted++;
        if (Scoring.isCorrect(sub, q.answer)) bracketed++;
      });
      var summary = (q.answer == null || !isFinite(q.answer))
        ? attempted + ' answered'
        : bracketed + ' / ' + attempted;
      cell(tr, summary, 'num');

      el.keyBody.appendChild(tr);
    });

    if (focusedQ) {
      var again = el.keyBody.querySelector('.key-input[data-qid="' + focusedQ + '"]');
      if (again) again.focus();
    }
  }

  function renderGrid(state) {
    el.gridHead.textContent = '';
    el.gridBody.textContent = '';

    var headRow = document.createElement('tr');
    var th0 = document.createElement('th');
    th0.textContent = 'Team';
    headRow.appendChild(th0);
    state.config.questions.forEach(function (q, i) {
      var th = document.createElement('th');
      th.className = 'num';
      th.textContent = 'Q' + (i + 1);
      th.title = q.text;
      headRow.appendChild(th);
    });
    el.gridHead.appendChild(headRow);

    if (!state.teams.length) return emptyRow(el.gridBody, state.config.questions.length + 1,
                                             'No teams have signed in yet.');

    state.teams.forEach(function (team) {
      var tr = document.createElement('tr');
      cell(tr, team.name);

      state.config.questions.forEach(function (q) {
        var sub = Scoring.latestSubmission(state, team.id, q.id);
        var td = document.createElement('td');
        td.className = 'num mono';
        if (!sub) {
          td.classList.add('cell-none');
          td.textContent = '—';
        } else {
          td.textContent = fmt(sub.low) + '–' + fmt(sub.high);
          td.title = 'ratio ×' + (sub.high / sub.low).toFixed(2) + ' · ' + timeAgo(sub.at);
          if (q.answer != null && isFinite(q.answer)) {
            td.classList.add(Scoring.isCorrect(sub, q.answer) ? 'cell-good' : 'cell-bad');
          }
        }
        tr.appendChild(td);
      });

      el.gridBody.appendChild(tr);
    });
  }

  /* --------------------------------------------------------------- helpers */

  function cell(tr, text, cls) {
    var td = document.createElement('td');
    if (cls) td.className = cls;
    td.textContent = text;
    tr.appendChild(td);
    return td;
  }

  function emptyRow(tbody, span, text) {
    var tr = document.createElement('tr');
    var td = document.createElement('td');
    td.colSpan = span;
    td.className = 'empty';
    td.textContent = text;
    tr.appendChild(td);
    tbody.appendChild(tr);
  }

  function stamp() {
    return new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  }

  /* One row per submission — the long format the Python grader will want. */
  function toCSV(state) {
    var teamsById = {};
    state.teams.forEach(function (t) { teamsById[t.id] = t; });
    var qIndex = {};
    state.config.questions.forEach(function (q, i) { qIndex[q.id] = i + 1; });

    var rows = [['team', 'team_id', 'question', 'question_id', 'low', 'high',
                 'submitted_at', 'is_latest']];

    state.submissions.forEach(function (s) {
      var latest = Scoring.latestSubmission(state, s.teamId, s.questionId);
      rows.push([
        teamsById[s.teamId] ? teamsById[s.teamId].name : '',
        s.teamId,
        qIndex[s.questionId] || '',
        s.questionId,
        s.low,
        s.high,
        new Date(s.at).toISOString(),
        latest && latest.id === s.id ? 'true' : 'false'
      ]);
    });

    return rows.map(function (r) {
      return r.map(function (v) {
        var str = String(v);
        return /[",\n]/.test(str) ? '"' + str.replace(/"/g, '""') + '"' : str;
      }).join(',');
    }).join('\n');
  }

  function download(filename, text, mime) {
    var blob = new Blob([text], { type: mime + ';charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  /* Keep the "3m ago" stamps honest without a full re-render. */
  setInterval(function () {
    if (!el.adminView.hidden) renderFeed(Store.state());
  }, 15000);
})();
