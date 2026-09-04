/* ============================================================================
 * forms-core.js — form definitions, field rendering, and validation.
 *
 * Shared by forms.html (fill one in) and forms-admin.html (read the replies).
 *
 * FIELD TYPES
 *   short_text     one line
 *   long_text      paragraph
 *   email          one line, checked for an @
 *   number         numeric, optional min/max
 *   single_select  radio buttons        (options, allowOther)
 *   multi_select   checkboxes           (options, allowOther, minChoices, maxChoices)
 *   dropdown       a <select>           (options)
 *   scale          linear 1..N          (min, max, minLabel, maxLabel)
 *   date           a date picker
 *   timeslot       like multi_select, but the dashboard treats the answers as
 *                  availability and draws a heatmap. Set multiple:false to make
 *                  it a single booking instead.
 *
 * Every rule here is enforced again on the server. This copy exists so people
 * get told about a missing answer before they hit submit, not after.
 * ==========================================================================*/
(function (global) {
  'use strict';

  var API = global.ESTIMATHON_API || null;

  var CHOICE_TYPES = ['single_select', 'multi_select', 'dropdown', 'timeslot'];
  var MULTI_TYPES = ['multi_select'];
  var OTHER_VALUE = '__other__';

  function isChoice(field) { return CHOICE_TYPES.indexOf(field.type) !== -1; }

  function isMulti(field) {
    if (field.type === 'timeslot') return field.multiple !== false;
    return MULTI_TYPES.indexOf(field.type) !== -1;
  }

  /* ---------------------------------------------------------------- loading */

  /* With a backend the forms come from it, so an admin can open and close them
     without a redeploy. Without one, fall back to the committed forms.json —
     form questions are public by nature, so there is nothing to hide here. */
  function loadForms() {
    if (API) {
      return fetch(API + '/forms')
        .then(function (r) {
          if (r.status === 404) {
            throw new Error(
              'The backend at ' + API + ' has no /forms endpoint. It is running ' +
              'an older build — redeploy the Worker (wrangler deploy) and load ' +
              'worker/schema.sql and seed.sql.');
          }
          if (!r.ok) throw new Error('The backend answered ' + r.status + '.');
          return r.json();
        })
        .then(function (j) { return j.forms || []; })
        .catch(function (err) {
          if (err instanceof TypeError) {
            /* fetch only throws TypeError when the request never completed:
               blocked by CORS, offline, or the host is unreachable. The real
               reason is only ever in the console, so make sure it lands there. */
            console.error('Estimathon forms: request to ' + API + '/forms failed:', err);
            throw new Error(
              'Could not reach the backend at ' + API + '. If this page is not ' +
              'being served from the deployed site, the Worker will refuse it ' +
              '(CORS). Run it with server.py, or open it from the real URL. ' +
              'The console has the exact error.');
          }
          throw err;
        });
    }

    return fetch('forms.json')
      .then(function (r) {
        if (!r.ok) throw new Error('forms.json could not be loaded (' + r.status + ').');
        return r.json();
      })
      .catch(function (err) {
        if (err instanceof TypeError) {
          throw new Error(
            location.protocol === 'file:'
              ? 'Pages opened straight from disk cannot read forms.json — ' +
                'browsers block file:// fetches. Serve the folder instead: ' +
                'py -3 server.py, then open http://localhost:8000/forms.html'
              : 'Could not read forms.json. Is it next to this page?');
        }
        throw err;
      });
  }

  function submitResponse(formId, answers) {
    if (API) {
      return fetch(API + '/forms/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ formId: formId, answers: answers })
      }).then(function (r) {
        return r.json().then(function (body) {
          if (!r.ok) throw new Error(body.error || 'Submission failed.');
          return body;
        });
      });
    }
    /* No backend: keep it in this browser so the page can still be demoed. */
    return new Promise(function (resolve) {
      var key = 'estimathon:formResponses';
      var all = [];
      try { all = JSON.parse(localStorage.getItem(key) || '[]'); } catch (e) {}
      var entry = {
        id: 'resp_' + Math.random().toString(36).slice(2, 10),
        formId: formId, answers: answers, submittedAt: Date.now()
      };
      all.push(entry);
      try { localStorage.setItem(key, JSON.stringify(all)); } catch (e) {}
      resolve({ response: entry, local: true });
    });
  }

  function localResponses() {
    try { return JSON.parse(localStorage.getItem('estimathon:formResponses') || '[]'); }
    catch (e) { return []; }
  }

  /* ------------------------------------------------------------- validation */

  /* Returns { ok, errors: {fieldId: message}, answers } */
  function validate(form, answers) {
    var errors = {};

    form.fields.forEach(function (field) {
      var value = answers[field.id];
      var empty = value === undefined || value === null || value === '' ||
                  (Array.isArray(value) && !value.length);

      if (field.required && empty) {
        errors[field.id] = 'This one is required.';
        return;
      }
      if (empty) return;

      if (field.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value))) {
        errors[field.id] = 'That does not look like an email address.';
      }

      if (field.type === 'number') {
        var n = Number(value);
        if (!isFinite(n)) {
          errors[field.id] = 'Enter a number.';
        } else if (field.min != null && n < field.min) {
          errors[field.id] = 'Must be at least ' + field.min + '.';
        } else if (field.max != null && n > field.max) {
          errors[field.id] = 'Must be at most ' + field.max + '.';
        }
      }

      if (isMulti(field) && Array.isArray(value)) {
        if (field.minChoices && value.length < field.minChoices) {
          errors[field.id] = 'Pick at least ' + field.minChoices + '.';
        } else if (field.maxChoices && value.length > field.maxChoices) {
          errors[field.id] = 'Pick at most ' + field.maxChoices + '.';
        }
      }

      /* A choice not on the list is only allowed when the field says so. */
      if (isChoice(field)) {
        var allowed = (field.options || []).slice();
        var given = Array.isArray(value) ? value : [value];
        var stray = given.filter(function (v) {
          return allowed.indexOf(v) === -1 && !field.allowOther;
        });
        if (stray.length) errors[field.id] = 'Pick from the options listed.';
      }
    });

    return { ok: !Object.keys(errors).length, errors: errors };
  }

  /* --------------------------------------------------------------- display */

  /* One answer as a single string, for tables and CSV. */
  function answerToText(value) {
    if (value === undefined || value === null || value === '') return '';
    if (Array.isArray(value)) return value.join('; ');
    return String(value);
  }

  /* ------------------------------------------------------------- rendering */

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  /* Builds the control for one field and returns
     { node, read() -> value, focus() } */
  function renderField(field, formId) {
    var wrap = el('div', 'ff');
    wrap.dataset.fieldId = field.id;

    var label = el('label', 'ff-label');
    label.textContent = field.label;
    if (field.required) {
      var star = el('span', 'ff-required', '*');
      star.title = 'Required';
      label.appendChild(star);
    }
    wrap.appendChild(label);

    if (field.help) wrap.appendChild(el('p', 'ff-help', field.help));

    var body = el('div', 'ff-body');
    wrap.appendChild(body);

    var read;
    var focusTarget;
    var name = formId + '_' + field.id;

    switch (field.type) {
      case 'long_text': {
        var area = el('textarea', 'ff-input ff-textarea');
        area.rows = 4;
        area.name = name;
        body.appendChild(area);
        focusTarget = area;
        read = function () { return area.value.trim(); };
        break;
      }

      case 'dropdown': {
        var select = el('select', 'ff-input');
        select.name = name;
        select.appendChild(new Option('Choose…', ''));
        (field.options || []).forEach(function (opt) {
          select.appendChild(new Option(opt, opt));
        });
        body.appendChild(select);
        focusTarget = select;
        read = function () { return select.value; };
        break;
      }

      case 'single_select':
      case 'multi_select':
      case 'timeslot': {
        var multi = isMulti(field);
        var group = el('div', 'ff-choices' +
          (field.type === 'timeslot' ? ' ff-choices-grid' : ''));
        group.setAttribute('role', multi ? 'group' : 'radiogroup');
        group.setAttribute('aria-label', field.label);

        var inputs = [];
        (field.options || []).forEach(function (opt, i) {
          var id = name + '_' + i;
          var row = el('label', 'ff-choice');
          var input = document.createElement('input');
          input.type = multi ? 'checkbox' : 'radio';
          input.name = name;
          input.value = opt;
          input.id = id;
          row.appendChild(input);
          row.appendChild(el('span', 'ff-choice-text', opt));
          group.appendChild(row);
          inputs.push(input);
        });

        var otherInput = null;
        if (field.allowOther) {
          var otherRow = el('label', 'ff-choice ff-choice-other');
          var otherToggle = document.createElement('input');
          otherToggle.type = multi ? 'checkbox' : 'radio';
          otherToggle.name = name;
          otherToggle.value = OTHER_VALUE;
          otherRow.appendChild(otherToggle);
          otherRow.appendChild(el('span', 'ff-choice-text', 'Other:'));
          otherInput = el('input', 'ff-input ff-other-input');
          otherInput.type = 'text';
          otherInput.placeholder = 'your answer';
          otherInput.addEventListener('input', function () {
            if (otherInput.value.trim()) otherToggle.checked = true;
          });
          otherRow.appendChild(otherInput);
          group.appendChild(otherRow);
          inputs.push(otherToggle);
        }

        body.appendChild(group);
        focusTarget = inputs[0];

        read = function () {
          var picked = [];
          inputs.forEach(function (input) {
            if (!input.checked) return;
            if (input.value === OTHER_VALUE) {
              var text = otherInput ? otherInput.value.trim() : '';
              if (text) picked.push(text);
            } else {
              picked.push(input.value);
            }
          });
          return multi ? picked : (picked[0] || '');
        };
        break;
      }

      case 'scale': {
        var min = field.min != null ? field.min : 1;
        var max = field.max != null ? field.max : 5;
        var scale = el('div', 'ff-scale');
        if (field.minLabel) scale.appendChild(el('span', 'ff-scale-end', field.minLabel));

        var scaleInputs = [];
        for (var v = min; v <= max; v++) {
          var stop = el('label', 'ff-scale-stop');
          var radio = document.createElement('input');
          radio.type = 'radio';
          radio.name = name;
          radio.value = String(v);
          stop.appendChild(radio);
          stop.appendChild(el('span', 'ff-scale-num', String(v)));
          scale.appendChild(stop);
          scaleInputs.push(radio);
        }
        if (field.maxLabel) scale.appendChild(el('span', 'ff-scale-end', field.maxLabel));
        body.appendChild(scale);
        focusTarget = scaleInputs[0];
        read = function () {
          var hit = scaleInputs.filter(function (r) { return r.checked; })[0];
          return hit ? hit.value : '';
        };
        break;
      }

      default: {
        /* short_text, email, number, date */
        var input = el('input', 'ff-input');
        input.name = name;
        input.type = field.type === 'number' ? 'number'
                   : field.type === 'date' ? 'date'
                   : field.type === 'email' ? 'email' : 'text';
        if (field.type === 'number') {
          if (field.min != null) input.min = field.min;
          if (field.max != null) input.max = field.max;
        }
        if (field.placeholder) input.placeholder = field.placeholder;
        input.autocomplete = field.type === 'email' ? 'email' : 'off';
        body.appendChild(input);
        focusTarget = input;
        read = function () { return input.value.trim(); };
      }
    }

    var error = el('p', 'ff-error');
    error.hidden = true;
    wrap.appendChild(error);

    return {
      node: wrap,
      field: field,
      read: read,
      focus: function () { if (focusTarget) focusTarget.focus(); },
      setError: function (message) {
        error.textContent = message || '';
        error.hidden = !message;
        wrap.classList.toggle('ff-invalid', !!message);
      }
    };
  }

  global.EstimathonForms = {
    loadForms: loadForms,
    submitResponse: submitResponse,
    localResponses: localResponses,
    validate: validate,
    renderField: renderField,
    answerToText: answerToText,
    isMulti: isMulti,
    isChoice: isChoice,
    usingRemote: !!API
  };
})(window);
