/* ============================================================================
 * forms-app.js — the public forms page: pick a form, fill it in, send it.
 * ==========================================================================*/
(function () {
  'use strict';

  var Forms = window.EstimathonForms;

  var el = {
    pickerView:  document.getElementById('picker-view'),
    formList:    document.getElementById('form-list'),

    formView:    document.getElementById('form-view'),
    backBtn:     document.getElementById('back-btn'),
    formTitle:   document.getElementById('form-title'),
    formDesc:    document.getElementById('form-description'),
    formClosed:  document.getElementById('form-closed'),
    requiredNote: document.getElementById('required-note'),
    formBody:    document.getElementById('form-body'),
    fields:      document.getElementById('fields'),
    formError:   document.getElementById('form-error'),
    submitBtn:   document.getElementById('submit-btn'),
    localNote:   document.getElementById('local-note'),

    doneView:    document.getElementById('done-view'),
    doneTitle:   document.getElementById('done-title'),
    doneNote:    document.getElementById('done-note'),
    anotherBtn:  document.getElementById('another-btn')
  };

  var forms = [];
  var current = null;
  var controls = [];

  /* ------------------------------------------------------------------ boot */

  Forms.loadForms()
    .then(function (loaded) {
      forms = loaded || [];
      renderList();
      openFromHash();
    })
    .catch(function (err) {
      el.formList.textContent = '';
      var msg = document.createElement('p');
      msg.className = 'msg msg-error';
      msg.textContent = 'Could not load the forms: ' + err.message;
      el.formList.appendChild(msg);
    });

  /* Deep links: forms.html#interest opens that form directly, which is what
     you want when the link goes in an email or on a slide. */
  window.addEventListener('hashchange', openFromHash);

  function openFromHash() {
    var id = (location.hash || '').replace(/^#/, '');
    if (!id) return showPicker(false);
    var form = forms.filter(function (f) { return f.id === id; })[0];
    if (form) openForm(form, false);
  }

  /* ------------------------------------------------------------- the list */

  function renderList() {
    el.formList.textContent = '';

    var open = forms.filter(function (f) { return f.status !== 'closed'; });
    if (!forms.length) {
      el.formList.appendChild(makeEmpty('No forms are set up yet.'));
      return;
    }
    if (!open.length) {
      el.formList.appendChild(makeEmpty('No forms are open right now. Check back soon.'));
    }

    forms.forEach(function (form) {
      var closed = form.status === 'closed';
      var card = document.createElement(closed ? 'div' : 'a');
      card.className = 'form-card' + (closed ? ' form-card-closed' : '');
      if (!closed) {
        card.href = '#' + form.id;
      }

      var head = document.createElement('div');
      head.className = 'form-card-head';
      var h2 = document.createElement('h2');
      h2.textContent = form.title;
      head.appendChild(h2);

      var pill = document.createElement('span');
      pill.className = 'pill ' + (closed ? 'pill-muted' : 'pill-open');
      pill.textContent = closed ? 'closed' : 'open';
      head.appendChild(pill);
      card.appendChild(head);

      var desc = document.createElement('p');
      desc.className = 'form-card-desc';
      desc.textContent = form.description || '';
      card.appendChild(desc);

      var meta = document.createElement('p');
      meta.className = 'form-card-meta';
      var count = (form.fields || []).length;
      meta.textContent = count + (count === 1 ? ' question' : ' questions');
      card.appendChild(meta);

      el.formList.appendChild(card);
    });
  }

  function makeEmpty(text) {
    var p = document.createElement('p');
    p.className = 'empty';
    p.textContent = text;
    return p;
  }

  /* -------------------------------------------------------------- one form */

  function openForm(form, pushHash) {
    current = form;
    controls = [];

    el.pickerView.hidden = true;
    el.doneView.hidden = true;
    el.formView.hidden = false;

    el.formTitle.textContent = form.title;
    el.formDesc.textContent = form.description || '';
    el.formDesc.hidden = !form.description;

    var closed = form.status === 'closed';
    el.formClosed.hidden = !closed;
    el.formBody.hidden = closed;
    el.requiredNote.hidden = closed;
    el.submitBtn.textContent = form.submitLabel || 'Submit';
    el.localNote.hidden = Forms.usingRemote;

    el.fields.textContent = '';
    el.formError.hidden = true;

    (form.fields || []).forEach(function (field) {
      var control = Forms.renderField(field, form.id);
      controls.push(control);
      el.fields.appendChild(control.node);
    });

    if (pushHash !== false) location.hash = form.id;
    window.scrollTo(0, 0);
  }

  function showPicker(clearHash) {
    current = null;
    el.formView.hidden = true;
    el.doneView.hidden = true;
    el.pickerView.hidden = false;
    if (clearHash !== false && location.hash) {
      history.replaceState(null, '', location.pathname + location.search);
    }
    window.scrollTo(0, 0);
  }

  el.backBtn.addEventListener('click', function () { showPicker(true); });
  el.anotherBtn.addEventListener('click', function () { showPicker(true); });

  /* ------------------------------------------------------------ submitting */

  el.formBody.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!current) return;

    var answers = {};
    controls.forEach(function (control) {
      control.setError('');
      var value = control.read();
      var empty = value === '' || (Array.isArray(value) && !value.length);
      if (!empty) answers[control.field.id] = value;
    });

    var result = Forms.validate(current, answers);
    if (!result.ok) {
      var first = null;
      controls.forEach(function (control) {
        var message = result.errors[control.field.id];
        if (message) {
          control.setError(message);
          if (!first) first = control;
        }
      });
      el.formError.textContent = 'Have another look — a few answers need fixing.';
      el.formError.hidden = false;
      if (first) {
        first.node.scrollIntoView({ behavior: 'smooth', block: 'center' });
        first.focus();
      }
      return;
    }

    el.formError.hidden = true;
    el.submitBtn.disabled = true;
    el.submitBtn.textContent = 'Sending…';

    Forms.submitResponse(current.id, answers)
      .then(function () {
        el.doneTitle.textContent = 'Thanks!';
        el.doneNote.textContent = current.confirmation ||
          'Your response has been recorded.';
        el.formView.hidden = true;
        el.doneView.hidden = false;
        if (location.hash) {
          history.replaceState(null, '', location.pathname + location.search);
        }
        window.scrollTo(0, 0);
      })
      .catch(function (err) {
        el.formError.textContent = err.message || 'Could not send that. Try again.';
        el.formError.hidden = false;
      })
      .then(function () {
        el.submitBtn.disabled = false;
        el.submitBtn.textContent = (current && current.submitLabel) || 'Submit';
      });
  });
})();
