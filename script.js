/* ============================================================================
 * script.js — the team-facing page: sign in, then submit intervals.
 * ==========================================================================*/
(function () {
  'use strict';

  var Store = Estimathon.Store;
  var Scoring = Estimathon.Scoring;
  var parseNumber = Estimathon.parseNumber;
  var fmt = Estimathon.formatNumber;

  var IDENTITY_KEY = 'estimathon:myTeam';

  var el = {
    eventName:    document.getElementById('event-name'),
    status:       document.getElementById('contest-status'),

    joinView:     document.getElementById('join-view'),
    joinForm:     document.getElementById('join-form'),
    teamName:     document.getElementById('team-name'),
    teamMembers:  document.getElementById('team-members'),
    joinError:    document.getElementById('join-error'),
    ruleMaxSubs:  document.getElementById('rule-max-subs'),
    ruleNumQ:     document.getElementById('rule-num-q'),
    ruleWidth:    document.getElementById('rule-width'),
    rulePenalty:  document.getElementById('rule-penalty'),

    contestView:  document.getElementById('contest-view'),
    currentTeam:  document.getElementById('current-team'),
    currentMem:   document.getElementById('current-members'),
    subsLeft:     document.getElementById('subs-left'),
    qsAnswered:   document.getElementById('qs-answered'),
    leaveBtn:     document.getElementById('leave-btn'),
    closedBanner: document.getElementById('closed-banner'),
    waiting:      document.getElementById('waiting'),
    waitingTitle: document.getElementById('waiting-title'),
    waitingNote:  document.getElementById('waiting-note'),
    questions:    document.getElementById('questions'),
    past:         document.getElementById('past'),
    pastCount:    document.getElementById('past-count'),
    pastBody:     document.getElementById('past-body'),
    board:        document.getElementById('team-leaderboard'),
    boardBody:    document.getElementById('team-leaderboard-body')
  };

  /* Who am I? Persisted so a refresh keeps you on your team. */
  var myTeamId = null;
  try { myTeamId = localStorage.getItem(IDENTITY_KEY); } catch (e) {}

  /* Per-question inline message, kept out of state so a re-render can restore
     it without echoing stale errors from other questions. */
  var notes = {};

  /* ------------------------------------------------------------------ join */

  el.joinForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var name = el.teamName.value.trim();
    if (!name) return showJoinError('Give your team a name first.');

    hideJoinError();
    Store.joinTeam(name, el.teamMembers.value)
      .then(function (res) {
        var team = res && res.team ? res.team : res;
        if (!team || !team.id) throw new Error('The server did not return a team.');
        myTeamId = team.id;
        try { localStorage.setItem(IDENTITY_KEY, myTeamId); } catch (e2) {}
        render(Store.state());
      })
      .catch(function (err) { showJoinError(err.message || 'Could not join.'); });
  });

  el.leaveBtn.addEventListener('click', function () {
    myTeamId = null;
    try { localStorage.removeItem(IDENTITY_KEY); } catch (e) {}
    notes = {};
    el.teamName.value = '';
    el.teamMembers.value = '';
    render(Store.state());
  });

  function showJoinError(msg) {
    el.joinError.textContent = msg;
    el.joinError.hidden = false;
  }
  function hideJoinError() { el.joinError.hidden = true; }

  /* ------------------------------------------------------------- submitting */

  function handleSubmit(state, question, lowInput, highInput) {
    var team = findTeam(state, myTeamId);
    if (!team) return;

    if (!state.config.contestOpen) {
      notes[question.id] = { type: 'err', text: 'Submissions are closed.' };
      return render(Store.state());
    }
    if (Estimathon.questionStatus(question) !== 'open') {
      notes[question.id] = { type: 'err', text: 'This question just closed.' };
      return render(Store.state());
    }
    if (Scoring.submissionsLeft(state, team.id) <= 0) {
      notes[question.id] = { type: 'err', text: 'You are out of submissions.' };
      return render(Store.state());
    }

    var low = parseNumber(lowInput.value);
    var high = parseNumber(highInput.value);

    if (!isFinite(low) || !isFinite(high)) {
      notes[question.id] = { type: 'err', text: 'Enter two numbers. "2.5 million" and "2.5e6" both work.' };
      return render(Store.state());
    }
    if (low <= 0 || high <= 0) {
      notes[question.id] = { type: 'err', text: 'Both bounds must be greater than zero.' };
      return render(Store.state());
    }
    if (high < low) {
      notes[question.id] = { type: 'err', text: 'The high bound must be at least the low bound.' };
      return render(Store.state());
    }

    Store.submit(team.id, question.id, low, high)
      .then(function () {
        notes[question.id] = { type: 'ok', text: 'Submitted.' };
        render(Store.state());
      })
      .catch(function (err) {
        notes[question.id] = { type: 'err', text: err.message || 'Submission failed.' };
        render(Store.state());
      });
  }

  /* --------------------------------------------------------------- rendering */

  function findTeam(state, id) {
    return state.teams.filter(function (t) { return t.id === id; })[0] || null;
  }

  function render(state) {
    var cfg = state.config;

    el.eventName.textContent = cfg.eventName;
    el.ruleMaxSubs.textContent = cfg.maxSubmissions;
    el.ruleNumQ.textContent = cfg.questions.length;
    el.ruleWidth.textContent = cfg.widthWeight;
    el.rulePenalty.textContent = cfg.unansweredPenalty;

    el.status.textContent = cfg.contestOpen ? 'Submissions open' : 'Submissions closed';
    el.status.className = 'pill ' + (cfg.contestOpen ? 'pill-open' : 'pill-closed');

    var team = findTeam(state, myTeamId);
    if (!team) {
      /* The team was removed or the event was reset out from under us. */
      if (myTeamId) { myTeamId = null; try { localStorage.removeItem(IDENTITY_KEY); } catch (e) {} }
      el.joinView.hidden = false;
      el.contestView.hidden = true;
      return;
    }

    el.joinView.hidden = true;
    el.contestView.hidden = false;

    el.currentTeam.textContent = team.name;
    el.currentMem.textContent = team.members || '';
    el.subsLeft.textContent = Scoring.submissionsLeft(state, team.id);

    var answered = 0;
    cfg.questions.forEach(function (q) {
      if (Scoring.latestSubmission(state, team.id, q.id)) answered++;
    });
    el.qsAnswered.textContent = answered + ' / ' + cfg.questions.length;

    renderQuestions(state, team);
    renderTeamBoard(state, team);
  }

  function renderQuestions(state, team) {
    var cfg = state.config;
    var outOfSubs = Scoring.submissionsLeft(state, team.id) <= 0;

    /* A pending question is one the organizers have not asked yet — it is not
       rendered at all, and in server mode its text never even reaches us. */
    var open = [], closed = [];
    cfg.questions.forEach(function (q, i) {
      var st = Estimathon.questionStatus(q);
      if (st === 'open') open.push({ q: q, n: i + 1 });
      else if (st === 'closed') closed.push({ q: q, n: i + 1 });
    });

    /* Keep whatever the user is mid-typing across a re-render. */
    var drafts = {};
    Array.prototype.forEach.call(el.questions.querySelectorAll('.q'), function (node) {
      var id = node.dataset.qid;
      drafts[id] = {
        low: node.querySelector('.js-low').value,
        high: node.querySelector('.js-high').value,
        focus: node.contains(document.activeElement) ? document.activeElement.className : null
      };
    });

    el.questions.textContent = '';
    open.forEach(function (item) {
      el.questions.appendChild(buildCard(state, team, item.q, item.n, {
        editable: cfg.contestOpen && !outOfSubs,
        drafts: drafts
      }));
    });

    renderWaiting(state, open.length, closed.length);
    renderPast(state, team, closed);

    /* restore focus so typing across a live update is not interrupted */
    Object.keys(drafts).forEach(function (id) {
      var d = drafts[id];
      if (!d.focus) return;
      var node = el.questions.querySelector('.q[data-qid="' + id + '"]');
      if (!node) return;
      var target = node.querySelector('.' + d.focus.split(' ').join('.'));
      if (target) target.focus();
    });
  }

  /* The "nothing to do right now" panel: between questions, before the first
     one, and after the last. */
  function renderWaiting(state, openCount, closedCount) {
    var cfg = state.config;
    /* The banner is only for the odd case of a question still open while the
       master switch is off; otherwise the waiting panel says everything. */
    el.closedBanner.hidden = cfg.contestOpen || openCount === 0;

    if (openCount > 0) {
      el.waiting.hidden = true;
      return;
    }
    el.waiting.hidden = false;

    var asked = closedCount > 0;
    if (!cfg.contestOpen && asked) {
      el.waitingTitle.textContent = 'That is the whole contest.';
      el.waitingNote.textContent = cfg.answersReleased
        ? 'Your results are below.'
        : 'Hang tight while the organizers finish scoring.';
    } else if (asked) {
      el.waitingTitle.textContent = 'Waiting for the next question…';
      el.waitingNote.textContent = 'Keep this page open. The next question appears here automatically.';
    } else {
      el.waitingTitle.textContent = 'You are signed in. The contest has not started.';
      el.waitingNote.textContent = 'Question 1 will appear here the moment the organizers open it.';
    }
  }

  function renderPast(state, team, closed) {
    if (!closed.length) {
      el.past.hidden = true;
      return;
    }
    el.past.hidden = false;
    el.pastCount.textContent = closed.length;
    el.pastBody.textContent = '';
    closed.forEach(function (item) {
      el.pastBody.appendChild(buildCard(state, team, item.q, item.n, { editable: false }));
    });
  }

  function buildCard(state, team, q, number, opts) {
      var cfg = state.config;
      var i = number - 1;
      var editable = !!opts.editable;
      var drafts = opts.drafts || {};
      var sub = Scoring.latestSubmission(state, team.id, q.id);
      /* Teams see answers only once an admin releases them — never merely
         because submissions happen to be closed. */
      var revealed = !!cfg.answersReleased && q.answer != null && isFinite(q.answer);
      var correct = revealed && Scoring.isCorrect(sub, q.answer);

      var card = document.createElement('div');
      card.className = 'q' + (sub ? ' answered' : '') + (editable ? ' live' : '') +
                       (revealed ? (correct ? ' correct' : ' wrong') : '');
      card.dataset.qid = q.id;

      var head = document.createElement('div');
      head.className = 'q-head';
      var num = document.createElement('span');
      num.className = 'q-num';
      num.textContent = i + 1;
      var text = document.createElement('div');
      text.className = 'q-text';
      text.textContent = q.text;
      if (q.unit) {
        var unit = document.createElement('span');
        unit.className = 'q-unit';
        unit.textContent = 'Answer in ' + q.unit + '.';
        text.appendChild(unit);
      }
      head.appendChild(num);
      head.appendChild(text);
      if (!editable) {
        var lock = document.createElement('span');
        lock.className = 'tag tag-locked';
        lock.textContent = 'closed';
        head.appendChild(lock);
      }
      card.appendChild(head);

      /* A closed question keeps its card but loses its form: there is nothing
         left to change. */
      if (editable) {
        var form = document.createElement('form');
        form.className = 'q-form';

        var lowField = numberField('Low bound', 'js-low', drafts[q.id] ? drafts[q.id].low : '');
        var highField = numberField('High bound', 'js-high', drafts[q.id] ? drafts[q.id].high : '');
        var btn = document.createElement('button');
        btn.type = 'submit';
        btn.className = 'btn btn-primary';
        btn.textContent = sub ? 'Replace' : 'Submit';

        form.appendChild(lowField.wrap);
        form.appendChild(highField.wrap);
        form.appendChild(btn);

        form.addEventListener('submit', function (e) {
          e.preventDefault();
          handleSubmit(Store.state(), q, lowField.input, highField.input);
        });
        card.appendChild(form);
      }

      /* status line: current interval, ratio, and any inline note */
      var status = document.createElement('p');
      status.className = 'q-status';
      if (sub) {
        status.appendChild(document.createTextNode(
          'Current: ' + fmt(sub.low) + ' – ' + fmt(sub.high) + '  '));
        var ratio = document.createElement('span');
        ratio.className = 'ratio';
        /* Before the answers are out, the only part of the score a team can
           see is what the width of their own interval costs them. */
        var widthCost = cfg.widthWeight * (sub.high / sub.low);
        ratio.textContent = revealed
          ? '(×' + (sub.high / sub.low).toFixed(2) + ')'
          : '(×' + (sub.high / sub.low).toFixed(2) + ', width costs ' + widthCost.toFixed(2) + ')';
        status.appendChild(ratio);

        if (revealed) {
          var result = Scoring.scoreQuestion(cfg, sub, q.answer);
          var tag = document.createElement('span');
          tag.className = 'tag ' + (correct ? 'tag-good' : 'tag-bad');
          tag.textContent = (correct ? 'bracketed' : 'missed, answer ' + fmt(q.answer)) +
                            ' · ' + result.score.toFixed(2) + ' pts';
          status.appendChild(tag);
        }
      } else if (revealed) {
        status.textContent = 'Not answered — ' + cfg.unansweredPenalty + ' pts. ' +
                             'The answer was ' + fmt(q.answer) + '.';
      } else {
        status.textContent = editable ? 'No answer yet.' : 'No answer submitted.';
      }
      card.appendChild(status);

      var note = notes[q.id];
      if (note && editable) {
        var noteEl = document.createElement('p');
        noteEl.className = 'q-status' + (note.type === 'err' ? ' err' : '');
        noteEl.textContent = note.text;
        card.appendChild(noteEl);
      }

      return card;
  }

  function numberField(label, cls, value) {
    var wrap = document.createElement('label');
    wrap.className = 'field q-input';
    var span = document.createElement('span');
    span.className = 'field-label';
    span.textContent = label;
    var input = document.createElement('input');
    input.type = 'text';
    input.className = cls;
    input.autocomplete = 'off';
    input.inputMode = 'decimal';
    input.placeholder = '0';
    input.value = value || '';
    wrap.appendChild(span);
    wrap.appendChild(input);
    return { wrap: wrap, input: input };
  }

  function renderTeamBoard(state, team) {
    if (!state.config.showLeaderboardToTeams) {
      el.board.hidden = true;
      return;
    }
    el.board.hidden = false;
    var rows = Scoring.leaderboard(state);
    el.boardBody.textContent = '';

    if (!rows.length) {
      el.boardBody.innerHTML = '<p class="empty">No teams yet.</p>';
      return;
    }

    var table = document.createElement('table');
    table.className = 'table';
    table.innerHTML =
      '<thead><tr><th>#</th><th>Team</th><th class="num">Score</th>' +
      '<th class="num">Correct</th></tr></thead>';
    var tbody = document.createElement('tbody');

    rows.forEach(function (r, i) {
      var tr = document.createElement('tr');
      if (r.team.id === team.id) tr.className = 'leader';
      tr.innerHTML =
        '<td class="rank">' + (i + 1) + '</td>' +
        '<td></td>' +
        '<td class="num">' + Estimathon.formatScore(r.score) + '</td>' +
        '<td class="num">' + r.correct + ' / ' + r.graded + '</td>';
      tr.children[1].textContent = r.team.name;
      tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    el.boardBody.appendChild(table);
  }

  /* Re-render on any change from this tab, another tab, or the backend. */
  Store.subscribe(render);
})();
