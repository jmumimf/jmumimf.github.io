/* ============================================================================
 * forms-admin.js — read, filter, and download form responses.
 *
 * The one thing here that is more than a table: a form with a `timeslot` field
 * gets an availability chart, sorted by how many people can make each window.
 * That is the whole point of the interview form — finding the slot that works
 * for the most people, without reading twenty rows by hand.
 * ==========================================================================*/
(function () {
  'use strict';

  var Forms = window.EstimathonForms;
  var API = window.ESTIMATHON_API || null;

  var el = {
    gateView:   document.getElementById('gate-view'),
    gateForm:   document.getElementById('gate-form'),
    gateInput:  document.getElementById('gate-input'),
    gateError:  document.getElementById('gate-error'),
    adminView:  document.getElementById('admin-view'),
    liveDot:    document.getElementById('live-dot'),

    picker:     document.getElementById('form-picker'),
    toggleBtn:  document.getElementById('toggle-status'),
    exportCsv:  document.getElementById('export-csv'),
    exportJson: document.getElementById('export-json'),
    refreshBtn: document.getElementById('refresh-btn'),

    statResponses: document.getElementById('stat-responses'),
    statToday:     document.getElementById('stat-today'),
    statFields:    document.getElementById('stat-fields'),
    statStatus:    document.getElementById('stat-status'),

    slotsCard:  document.getElementById('slots-card'),
    slotsTitle: document.getElementById('slots-title'),
    slotsBody:  document.getElementById('slots-body'),

    search:     document.getElementById('search'),
    head:       document.querySelector('#responses thead'),
    body:       document.querySelector('#responses tbody')
  };

  var adminKey = null;
  var forms = [];
  var responses = [];
  var currentId = null;
  var filter = '';

  /* ------------------------------------------------------------------ gate */

  AdminGate.mount({
    gate: el.gateView,
    form: el.gateForm,
    input: el.gateInput,
    error: el.gateError,
    view: el.adminView,
    onUnlock: function (code) {
      adminKey = code;
      el.liveDot.textContent = API ? 'Server' : 'This device only';
      el.liveDot.className = 'pill ' + (API ? 'pill-live' : 'pill-muted');
      el.liveDot.title = API
        ? 'Reading responses from the configured backend.'
        : 'No backend configured: only replies made in this browser are visible.';
      load();
    }
  });

  /* ------------------------------------------------------------------ data */

  function load() {
    Promise.all([Forms.loadForms(), loadResponses()])
      .then(function (both) {
        forms = both[0] || [];
        responses = both[1] || [];
        if (!currentId && forms.length) currentId = forms[0].id;
        renderPicker();
        render();
      })
      .catch(function (err) {
        el.body.textContent = '';
        emptyRow(1, 'Could not load responses: ' + err.message);
      });
  }

  function loadResponses() {
    if (!API) return Promise.resolve(Forms.localResponses());
    return fetch(API + '/forms/responses?key=' + encodeURIComponent(adminKey || ''))
      .then(function (r) {
        return r.json().then(function (body) {
          if (!r.ok) throw new Error(body.error || 'Request failed.');
          return body.responses || [];
        });
      });
  }

  el.refreshBtn.addEventListener('click', load);

  el.picker.addEventListener('change', function () {
    currentId = el.picker.value;
    render();
  });

  el.search.addEventListener('input', function () {
    filter = el.search.value.trim().toLowerCase();
    renderTable();
  });

  el.toggleBtn.addEventListener('click', function () {
    var form = currentForm();
    if (!form) return;
    if (!API) {
      alert('Opening and closing forms needs the backend. Without it, edit ' +
            '"status" in forms.json.');
      return;
    }
    var next = form.status === 'closed' ? 'open' : 'closed';
    fetch(API + '/forms/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ formId: form.id, status: next, key: adminKey })
    }).then(function (r) {
      return r.json().then(function (body) {
        if (!r.ok) throw new Error(body.error || 'Could not change the status.');
        load();
      });
    }).catch(function (err) { alert(err.message); });
  });

  /* --------------------------------------------------------------- helpers */

  function currentForm() {
    return forms.filter(function (f) { return f.id === currentId; })[0] || null;
  }

  function currentResponses() {
    return responses
      .filter(function (r) { return r.formId === currentId; })
      .sort(function (a, b) { return b.submittedAt - a.submittedAt; });
  }

  function matchesFilter(response, form) {
    if (!filter) return true;
    return form.fields.some(function (field) {
      return Forms.answerToText(response.answers[field.id]).toLowerCase().indexOf(filter) !== -1;
    });
  }

  function when(ts) {
    var d = new Date(ts);
    return d.toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
    });
  }

  /* -------------------------------------------------------------- render */

  function renderPicker() {
    el.picker.textContent = '';
    forms.forEach(function (form) {
      var count = responses.filter(function (r) { return r.formId === form.id; }).length;
      var option = new Option(form.title + '  (' + count + ')', form.id);
      el.picker.appendChild(option);
    });
    if (currentId) el.picker.value = currentId;
  }

  function render() {
    var form = currentForm();
    if (!form) {
      el.statResponses.textContent = '0';
      emptyRow(1, 'No forms are set up yet.');
      return;
    }

    var rows = currentResponses();
    var dayAgo = Date.now() - 24 * 60 * 60 * 1000;

    el.statResponses.textContent = rows.length;
    el.statToday.textContent = rows.filter(function (r) { return r.submittedAt >= dayAgo; }).length;
    el.statFields.textContent = form.fields.length;
    el.statStatus.textContent = form.status === 'closed' ? 'Closed' : 'Open';

    el.toggleBtn.textContent = form.status === 'closed' ? 'Reopen form' : 'Close form';
    el.toggleBtn.className = 'btn ' + (form.status === 'closed' ? 'btn-primary' : 'btn-danger');

    renderSlots(form, rows);
    renderTable();
  }

  /* Availability: how many people can make each window. */
  function renderSlots(form, rows) {
    var slotFields = form.fields.filter(function (f) { return f.type === 'timeslot'; });
    if (!slotFields.length || !rows.length) {
      el.slotsCard.hidden = true;
      return;
    }
    el.slotsCard.hidden = false;

    var field = slotFields[0];
    el.slotsTitle.textContent = field.label;

    /* Count picks per slot, remembering who picked each one. */
    var counts = {};
    (field.options || []).forEach(function (opt) { counts[opt] = []; });

    var nameField = form.fields.filter(function (f) {
      return f.type === 'short_text' && /name/i.test(f.id + ' ' + f.label);
    })[0];

    rows.forEach(function (response) {
      var picked = response.answers[field.id];
      if (!Array.isArray(picked)) picked = picked ? [picked] : [];
      var who = nameField ? Forms.answerToText(response.answers[nameField.id]) : '';
      picked.forEach(function (slot) {
        if (!counts[slot]) counts[slot] = [];
        counts[slot].push(who || 'anonymous');
      });
    });

    var entries = Object.keys(counts).map(function (slot) {
      return { slot: slot, people: counts[slot] };
    });
    var max = entries.reduce(function (m, e) { return Math.max(m, e.people.length); }, 0);

    entries.sort(function (a, b) {
      if (b.people.length !== a.people.length) return b.people.length - a.people.length;
      return (field.options || []).indexOf(a.slot) - (field.options || []).indexOf(b.slot);
    });

    el.slotsBody.textContent = '';
    entries.forEach(function (entry) {
      var count = entry.people.length;
      var row = document.createElement('div');
      row.className = 'slot' + (count === max && max > 0 ? ' slot-best' : '');
      row.title = count ? entry.people.join(', ') : 'nobody yet';

      var label = document.createElement('span');
      label.className = 'slot-label';
      label.textContent = entry.slot;

      var track = document.createElement('span');
      track.className = 'slot-track';
      var bar = document.createElement('span');
      bar.className = 'slot-bar';
      bar.style.width = (max ? (count / max) * 100 : 0) + '%';
      track.appendChild(bar);

      var num = document.createElement('span');
      num.className = 'slot-count';
      num.textContent = count + ' / ' + rows.length;

      row.appendChild(label);
      row.appendChild(track);
      row.appendChild(num);
      el.slotsBody.appendChild(row);
    });
  }

  function renderTable() {
    var form = currentForm();
    if (!form) return;

    el.head.textContent = '';
    el.body.textContent = '';

    var headRow = document.createElement('tr');
    headRow.appendChild(th('Submitted'));
    form.fields.forEach(function (field) { headRow.appendChild(th(field.label)); });
    headRow.appendChild(th(''));
    el.head.appendChild(headRow);

    var rows = currentResponses().filter(function (r) { return matchesFilter(r, form); });
    if (!rows.length) {
      emptyRow(form.fields.length + 2,
               filter ? 'Nothing matches that filter.' : 'No responses yet.');
      return;
    }

    rows.forEach(function (response) {
      var tr = document.createElement('tr');
      tr.appendChild(td(when(response.submittedAt), 'when-cell'));

      form.fields.forEach(function (field) {
        var text = Forms.answerToText(response.answers[field.id]);
        var cell = td(text, field.type === 'long_text' || field.type === 'timeslot'
          ? 'wrap-cell' : '');
        if (!text) cell.className += ' cell-none';
        if (!text) cell.textContent = '—';
        tr.appendChild(cell);
      });

      var actions = document.createElement('td');
      if (API) {
        var del = document.createElement('button');
        del.className = 'btn btn-quiet';
        del.type = 'button';
        del.textContent = 'Delete';
        del.addEventListener('click', function () {
          if (!confirm('Delete this response? It cannot be undone.')) return;
          fetch(API + '/forms/response/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ responseId: response.id, key: adminKey })
          }).then(function (r) {
            return r.json().then(function (body) {
              if (!r.ok) throw new Error(body.error || 'Could not delete it.');
              load();
            });
          }).catch(function (err) { alert(err.message); });
        });
        actions.appendChild(del);
      }
      tr.appendChild(actions);

      el.body.appendChild(tr);
    });
  }

  function th(text) {
    var node = document.createElement('th');
    node.textContent = text;
    return node;
  }

  function td(text, className) {
    var node = document.createElement('td');
    if (className) node.className = className;
    node.textContent = text;
    return node;
  }

  function emptyRow(span, text) {
    el.body.textContent = '';
    var tr = document.createElement('tr');
    var cell = document.createElement('td');
    cell.colSpan = span;
    cell.className = 'empty';
    cell.textContent = text;
    tr.appendChild(cell);
    el.body.appendChild(tr);
  }

  /* --------------------------------------------------------------- export */

  el.exportCsv.addEventListener('click', function () {
    var form = currentForm();
    if (!form) return;

    var header = ['submitted_at'].concat(form.fields.map(function (f) { return f.label; }));
    var rows = [header];

    currentResponses().forEach(function (response) {
      rows.push([new Date(response.submittedAt).toISOString()].concat(
        form.fields.map(function (field) {
          return Forms.answerToText(response.answers[field.id]);
        })
      ));
    });

    var csv = rows.map(function (row) {
      return row.map(function (value) {
        var str = String(value);
        return /[",\n]/.test(str) ? '"' + str.replace(/"/g, '""') + '"' : str;
      }).join(',');
    }).join('\n');

    download(form.id + '-responses-' + stamp() + '.csv', csv, 'text/csv');
  });

  el.exportJson.addEventListener('click', function () {
    var form = currentForm();
    if (!form) return;
    download(form.id + '-responses-' + stamp() + '.json', JSON.stringify({
      form: form,
      exportedAt: new Date().toISOString(),
      responses: currentResponses()
    }, null, 2), 'application/json');
  });

  function stamp() {
    return new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
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
})();
