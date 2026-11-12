(function () {
  const app = document.getElementById('app');
  let ov = null;           // overview data
  let tab = 'results';
  let resultsGroup = null; // selected group id
  let resultsDept = '';    // department filter
  let expanded = new Set();
  let resultsCache = {};

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v != null && v !== false) el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
    return el;
  }
  async function api(method, url, body) {
    const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 && !url.endsWith('/login')) { renderLogin(); throw new Error('Please log in.'); }
    if (!r.ok) throw new Error(j.error || 'Request failed');
    return j;
  }
  function toast(msg, kind = 'ok') {
    const el = h('div', { class: 'alert ' + kind, style: 'position:fixed;bottom:16px;left:50%;transform:translateX(-50%);z-index:9;box-shadow:0 4px 16px rgba(0,0,0,.15)' }, msg);
    document.body.append(el); setTimeout(() => el.remove(), 3500);
  }
  const fmt = n => n == null ? '' : (Math.round(n * 100) / 100).toFixed(2);
  const scoreClass = n => n == null ? '' : 'score s' + Math.max(1, Math.min(5, Math.round(n)));

  // ---------- login / first-run setup ----------
  async function renderLogin(message) {
    document.getElementById('hdr-right').textContent = '';
    const status = await fetch('/api/admin/status').then(r => r.json()).catch(() => ({ configured: true }));
    const setup = !status.configured;
    const err = h('div', { class: 'alert error', style: message ? '' : 'display:none' }, message || '');
    const user = h('input', { type: 'text', autocomplete: 'username', value: 'admin' });
    const pass = h('input', { type: 'password', autocomplete: setup ? 'new-password' : 'current-password' });
    const pass2 = setup ? h('input', { type: 'password', autocomplete: 'new-password' }) : null;
    const form = h('form', { onsubmit: async (e) => {
      e.preventDefault();
      if (setup && pass.value !== pass2.value) { err.textContent = 'Passwords do not match.'; err.style.display = 'block'; return; }
      try { await api('POST', setup ? '/api/admin/setup' : '/api/admin/login', { username: user.value, password: pass.value }); await loadOverview(); render(); }
      catch (ex) { err.textContent = ex.message; err.style.display = 'block'; }
    } }, h('label', null, 'Username'), user, h('label', null, 'Password'), pass, setup ? [h('label', null, 'Confirm password'), pass2] : null, err,
      h('div', { class: 'actions' }, h('button', { type: 'submit' }, setup ? 'Create administrator account' : 'Log in')));
    app.replaceChildren(h('div', { class: 'card login' },
      h('h2', null, setup ? 'Welcome! Create the administrator account' : 'Administrator login'),
      setup ? h('p', { class: 'muted small' }, 'This is the first time the admin page is opened. Choose the username and password you will use to see the results. Only a hashed version is stored.') : null,
      form));
  }

  async function loadOverview() {
    ov = await api('GET', '/api/admin/overview');
    if (!resultsGroup || !ov.groups.find(g => g.id === resultsGroup)) resultsGroup = ov.groups[0] && ov.groups[0].id;
    document.getElementById('hdr-right').replaceChildren(ov.orgName + ' · ', h('button', { class: 'link', style: 'color:#fff', onclick: async () => { await api('POST', '/api/admin/logout'); renderLogin(); } }, 'Log out'));
  }

  // ---------- layout ----------
  function render() {
    const tabs = [['results', 'Results'], ['employees', 'Employees & links'], ['questions', 'Surveys & questions'], ['settings', 'Settings & demo data']];
    app.replaceChildren(
      h('div', { class: 'tabs' }, tabs.map(([id, label]) => h('button', { class: id === tab ? 'active' : '', onclick: () => { tab = id; render(); } }, label))),
      h('div', { id: 'tab' }, h('p', { class: 'muted' }, 'Loading...')),
    );
    ({ results: renderResults, employees: renderEmployees, questions: renderQuestions, settings: renderSettings })[tab]();
  }
  const setTab = (...nodes) => document.getElementById('tab').replaceChildren(...nodes);

  // ---------- results ----------
  async function renderResults() {
    if (!resultsGroup) return setTab(h('div', { class: 'card' }, 'No surveys configured.'));
    const r = resultsCache[resultsGroup] || (resultsCache[resultsGroup] = await api('GET', '/api/admin/results/' + resultsGroup));
    const ratingQs = r.questions.filter(q => q.type === 'rating');
    const textQs = r.questions.filter(q => q.type === 'text');
    const depts = [...new Set(r.people.map(p => p.department))].sort();
    const people = r.people.filter(p => !resultsDept || p.department === resultsDept);

    const controls = h('div', { class: 'row' },
      h('select', { onchange: (e) => { resultsGroup = e.target.value; resultsDept = ''; expanded.clear(); renderResults(); } }, ov.groups.map(g => h('option', { value: g.id, selected: g.id === resultsGroup }, g.name))),
      h('select', { onchange: (e) => { resultsDept = e.target.value; renderResults(); } }, h('option', { value: '' }, 'All departments'), depts.map(d => h('option', { value: d, selected: d === resultsDept }, d))),
      h('button', { class: 'secondary', onclick: () => { delete resultsCache[resultsGroup]; renderResults(); } }, 'Refresh'),
      h('a', { class: 'btn', href: '/api/admin/results/' + resultsGroup + '.csv', style: 'flex:0 0 auto;text-decoration:none' }, 'Export CSV'),
    );
    const stats = h('div', { class: 'stats' },
      h('div', { class: 'stat' }, h('div', { class: 'v' }, r.totalResponses), h('div', { class: 'l' }, 'Evaluations submitted')),
      h('div', { class: 'stat' }, h('div', { class: 'v' }, `${r.evaluatorsCount} / ${r.evaluatorsTotal}`), h('div', { class: 'l' }, 'People who have participated')),
      h('div', { class: 'stat' }, h('div', { class: 'v' }, r.minResponses), h('div', { class: 'l' }, 'Minimum evaluations to show a person')),
      h('div', { class: 'stat' }, h('div', { class: 'v' }, r.group.status), h('div', { class: 'l' }, 'Survey status')),
    );

    // Department summary
    const deptTable = h('table', null,
      h('thead', null, h('tr', null, h('th', null, 'Department'), h('th', { class: 'num' }, 'Evaluations'), h('th', { class: 'num' }, 'Overall'), ratingQs.map((q, i) => h('th', { class: 'num', title: q.text }, 'Q' + (i + 1))))),
      h('tbody', null, r.departments.filter(d => !resultsDept || d.name === resultsDept).map(d => h('tr', null,
        h('td', null, d.name), h('td', { class: 'num' }, d.responses),
        h('td', { class: 'num' }, d.visible ? h('span', { class: scoreClass(d.overall) }, fmt(d.overall)) : h('span', { class: 'pill hidden' }, 'not enough data')),
        ratingQs.map(q => h('td', { class: 'num' }, d.visible && d.ratings[q.id] ? h('span', { class: scoreClass(d.ratings[q.id].avg) }, fmt(d.ratings[q.id].avg)) : '')),
      ))));

    // People table
    const rows = [];
    for (const p of people) {
      rows.push(h('tr', { class: 'clickable', onclick: () => { expanded.has(p.id) ? expanded.delete(p.id) : expanded.add(p.id); renderResults(); } },
        h('td', null, h('b', null, p.name), h('div', { class: 'small muted' }, [p.role, p.department].filter(Boolean).join(' · '))),
        h('td', { class: 'num' }, p.responses),
        h('td', { class: 'num' }, p.visible ? h('span', { class: scoreClass(p.overall) }, fmt(p.overall)) : h('span', { class: 'pill hidden' }, `hidden until ${r.minResponses}`)),
        ratingQs.map(q => h('td', { class: 'num' }, p.visible && p.ratings[q.id] ? h('span', { class: scoreClass(p.ratings[q.id].avg) }, fmt(p.ratings[q.id].avg)) : '')),
      ));
      if (expanded.has(p.id) && p.visible) {
        rows.push(h('tr', null, h('td', { colspan: 3 + ratingQs.length }, h('div', { class: 'detail' },
          ratingQs.map((q, i) => {
            const s = p.ratings[q.id];
            return h('div', { class: 'small', style: 'margin-bottom:4px' }, h('b', null, 'Q' + (i + 1) + ': '), q.text, ' ',
              s ? [h('span', { class: scoreClass(s.avg) }, fmt(s.avg)), ` (${s.n} answers)`, h('span', { class: 'dist', title: '1 to 5 distribution: ' + s.dist.join(' / ') }, s.dist.map(n => h('span', { style: `height:${4 + n * 4}px` })))] : h('span', { class: 'muted' }, 'no answers'));
          }),
          textQs.map(q => h('div', null, h('h3', null, q.text), (p.comments[q.id] || []).length ? h('ul', null, p.comments[q.id].map(c => h('li', null, c))) : h('p', { class: 'muted small' }, 'No comments.'))),
        ))));
      }
    }
    const peopleTable = h('table', null,
      h('thead', null, h('tr', null, h('th', null, 'Person'), h('th', { class: 'num' }, 'Evaluations'), h('th', { class: 'num' }, 'Overall'), ratingQs.map((q, i) => h('th', { class: 'num', title: q.text }, 'Q' + (i + 1))))),
      h('tbody', null, rows));

    setTab(
      h('div', { class: 'card' }, h('h2', null, r.group.name), controls, h('div', { style: 'height:12px' }), stats),
      h('div', { class: 'card' }, h('h2', null, 'By department'), h('p', { class: 'muted small' }, 'Average score across all evaluations received by people in the department (1 to 5).'), h('div', { class: 'table-wrap' }, deptTable)),
      h('div', { class: 'card' }, h('h2', null, 'By person'), h('p', { class: 'muted small' }, 'Click a row to see the breakdown and written comments. People with fewer evaluations than the minimum stay hidden to protect anonymity.'), h('div', { class: 'table-wrap' }, peopleTable),
        h('h3', null, 'Questions'), h('ol', { class: 'small muted' }, ratingQs.map(q => h('li', null, q.text)))),
    );
  }

  // ---------- employees & links ----------
  function renderEmployees() {
    const groupName = id => (ov.groups.find(g => g.id === id) || {}).name || id;
    const groupShort = id => id === 'staff' ? 'Staff' : id === 'ops' ? 'Operations' : id;
    const rows = ov.employees.map(e => h('tr', null,
      h('td', null, h('b', null, e.name), h('div', { class: 'small muted' }, [e.role, e.email].filter(Boolean).join(' · '))),
      h('td', null, e.department),
      h('td', null, e.groups.map(g => h('span', { class: 'pill todo', style: 'margin-right:4px', title: groupName(g) }, groupShort(g)))),
      h('td', null, h('span', { class: 'pill ' + (e.started ? 'done' : 'hidden') }, e.started ? 'started' : 'not yet')),
      h('td', null, h('code', null, e.code), ' ', h('button', { class: 'link small', onclick: () => { navigator.clipboard.writeText(`${ov.baseUrl}/s/${e.code.replace('-', '')}`); toast('Link copied'); } }, 'copy link')),
      h('td', null, h('div', { class: 'row', style: 'gap:6px' },
        h('button', { class: 'secondary small', style: 'padding:4px 8px', onclick: () => editEmployee(e) }, 'Edit'),
        h('button', { class: 'secondary small', style: 'padding:4px 8px', onclick: async () => { if (!confirm(`Generate a new code for ${e.name}? The old link will stop working.`)) return; await api('POST', `/api/admin/employees/${e.id}/regenerate`); await loadOverview(); render(); } }, 'New code'),
        h('button', { class: 'danger small', style: 'padding:4px 8px', onclick: async () => { if (!confirm(`Remove ${e.name}?`)) return; await api('DELETE', `/api/admin/employees/${e.id}`); await loadOverview(); resultsCache = {}; render(); } }, 'Remove'),
      )),
    ));
    const csv = h('textarea', { placeholder: 'Name, Department, Role, Email, Survey\nJane Doe, Sales, Account Executive, jane@example.com, staff\nJohn Smith, Operations, Operator, john@example.com, ops\nYannick, Operations, Operations Manager, yannick@example.com, staff+ops', style: 'min-height:120px;font-family:ui-monospace,monospace;font-size:13px' });
    const replace = h('input', { type: 'checkbox' });
    setTab(
      h('div', { class: 'card' },
        h('h2', null, 'Sharing the survey'),
        h('p', null, 'Every employee has a personal access code. Send each person their own link (or the general link plus their code). The code only prevents double evaluations; it is never attached to the answers.'),
        h('p', null, 'General link: ', h('code', null, ov.baseUrl + '/'), ' · Personal link format: ', h('code', null, ov.baseUrl + '/s/CODE')),
        h('div', { class: 'actions' }, h('a', { class: 'btn', href: '/api/admin/links.csv', style: 'text-decoration:none' }, 'Download all links (CSV for mail merge)'), h('button', { class: 'secondary', onclick: () => editEmployee(null) }, 'Add one employee')),
      ),
      h('div', { class: 'card' }, h('h2', null, `Employees (${ov.employees.length})`), h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, h('th', null, 'Name'), h('th', null, 'Department'), h('th', null, 'Surveys'), h('th', null, 'Participation'), h('th', null, 'Code'), h('th', null, ''))),
        h('tbody', null, rows)))),
      h('div', { class: 'card' },
        h('h2', null, 'Import employees from a list'),
        h('p', { class: 'muted small' }, 'Paste one employee per line: Name, Department, Role, Email, Survey. Survey is "staff" (non-operator survey), "ops" (operations survey) or "staff+ops" (both). Copying columns straight from Excel works too.'),
        csv,
        h('label', { class: 'small', style: 'font-weight:400' }, replace, ' Replace the whole list (removes current employees and all responses)'),
        h('div', { class: 'actions' }, h('button', { onclick: async () => {
          if (replace.checked && !confirm('This deletes all current employees and responses. Continue?')) return;
          try { const r = await api('POST', '/api/admin/employees/import', { csv: csv.value, replace: replace.checked }); toast(`${r.added} employees added${r.errors.length ? ', ' + r.errors.length + ' lines skipped' : ''}`); if (r.errors.length) alert(r.errors.join('\n')); await loadOverview(); resultsCache = {}; render(); }
          catch (ex) { toast(ex.message, 'error'); }
        } }, 'Import')),
      ),
    );
  }
  function editEmployee(e) {
    const name = h('input', { type: 'text', value: e ? e.name : '' });
    const dept = h('input', { type: 'text', value: e ? e.department : '', list: 'depts' });
    const role = h('input', { type: 'text', value: e ? e.role : '' });
    const email = h('input', { type: 'email', value: e ? e.email : '' });
    const checks = ov.groups.map(g => { const c = h('input', { type: 'checkbox', checked: e ? e.groups.includes(g.id) : g.id === 'staff' }); return { g, c }; });
    const err = h('div', { class: 'alert error', style: 'display:none' });
    const dialog = h('dialog', { style: 'border:none;border-radius:12px;padding:0;max-width:520px;width:95%' }, h('div', { class: 'card', style: 'margin:0' },
      h('h2', null, e ? 'Edit employee' : 'Add employee'),
      h('label', null, 'Name'), name, h('label', null, 'Department'), dept, h('datalist', { id: 'depts' }, [...new Set(ov.employees.map(x => x.department))].map(d => h('option', { value: d }))),
      h('label', null, 'Role (optional)'), role, h('label', null, 'Email (optional, for sending the link)'), email,
      h('label', null, 'Surveys'), checks.map(({ g, c }) => h('label', { style: 'font-weight:400;margin:4px 0' }, c, ' ', g.name)),
      err,
      h('div', { class: 'actions' }, h('button', { onclick: async () => {
        const body = { name: name.value, department: dept.value, role: role.value, email: email.value, groups: checks.filter(x => x.c.checked).map(x => x.g.id) };
        try { await api(e ? 'PUT' : 'POST', e ? `/api/admin/employees/${e.id}` : '/api/admin/employees', body); dialog.close(); dialog.remove(); await loadOverview(); resultsCache = {}; render(); }
        catch (ex) { err.textContent = ex.message; err.style.display = 'block'; }
      } }, 'Save'), h('button', { class: 'secondary', onclick: () => { dialog.close(); dialog.remove(); } }, 'Cancel')),
    ));
    document.body.append(dialog); dialog.showModal();
  }

  // ---------- surveys & questions ----------
  function renderQuestions() {
    setTab(...ov.groups.map(g => {
      const name = h('input', { type: 'text', value: g.name });
      const desc = h('textarea', { style: 'min-height:60px' }, g.description);
      const status = h('select', null, h('option', { value: 'open', selected: g.status === 'open' }, 'Open (employees can submit)'), h('option', { value: 'closed', selected: g.status === 'closed' }, 'Closed (no more submissions)'));
      const list = h('div');
      const qs = g.questions.map(q => ({ ...q }));
      const draw = () => list.replaceChildren(...qs.map((q, i) => h('div', { class: 'qrow' },
        h('span', { class: 'muted small', style: 'width:22px' }, i + 1),
        h('input', { type: 'text', value: q.text, oninput: (e) => { q.text = e.target.value; } }),
        h('select', { onchange: (e) => { q.type = e.target.value; } }, h('option', { value: 'rating', selected: q.type === 'rating' }, 'Rating 1-5'), h('option', { value: 'text', selected: q.type === 'text' }, 'Free text')),
        h('button', { class: 'secondary', title: 'Move up', disabled: i === 0, onclick: () => { [qs[i - 1], qs[i]] = [qs[i], qs[i - 1]]; draw(); } }, '↑'),
        h('button', { class: 'danger', onclick: () => { qs.splice(i, 1); draw(); } }, '✕'),
      )));
      draw();
      return h('div', { class: 'card' },
        h('h2', null, g.name),
        h('label', null, 'Survey name'), name, h('label', null, 'Introduction shown to employees'), desc, h('label', null, 'Status'), status,
        h('div', { class: 'actions' }, h('button', { onclick: async () => { try { await api('PUT', `/api/admin/groups/${g.id}`, { name: name.value, description: desc.value, status: status.value }); toast('Survey saved'); await loadOverview(); resultsCache = {}; } catch (ex) { toast(ex.message, 'error'); } } }, 'Save survey')),
        h('h3', null, 'Questions'),
        h('p', { class: 'muted small' }, 'Rating questions are answered on a 1 to 5 scale. Every question can be skipped by the employee. Changing wording keeps existing answers; deleting a question deletes its answers from the results.'),
        list,
        h('div', { class: 'actions' }, h('button', { class: 'secondary', onclick: () => { qs.push({ text: '', type: 'rating' }); draw(); } }, 'Add question'),
          h('button', { onclick: async () => { try { await api('PUT', `/api/admin/groups/${g.id}/questions`, { questions: qs }); toast('Questions saved'); await loadOverview(); resultsCache = {}; render(); } catch (ex) { toast(ex.message, 'error'); } } }, 'Save questions')),
      );
    }));
  }

  // ---------- settings & demo ----------
  function renderSettings() {
    const min = h('input', { type: 'number', min: 1, max: 50, value: ov.minResponses });
    const org = h('input', { type: 'text', value: ov.orgName });
    const demoBtn = (label, what, cls = 'secondary') => h('button', { class: cls, onclick: async () => {
      if (!confirm(`${label}?`)) return;
      try { await api('POST', '/api/admin/demo', { what }); toast('Done'); await loadOverview(); resultsCache = {}; render(); } catch (ex) { toast(ex.message, 'error'); }
    } }, label);
    const resetBtn = (label, what) => h('button', { class: 'danger', onclick: async () => {
      if (!confirm(`${label}? This cannot be undone.`)) return;
      try { await api('POST', '/api/admin/reset', { what }); toast('Done'); await loadOverview(); resultsCache = {}; render(); } catch (ex) { toast(ex.message, 'error'); }
    } }, label);
    const cur = h('input', { type: 'password', autocomplete: 'current-password' });
    const nw = h('input', { type: 'password', autocomplete: 'new-password' });
    setTab(
      h('div', { class: 'card' }, h('h2', null, 'Settings'),
        h('label', null, 'Organization name'), org,
        h('label', null, 'Minimum evaluations before a person\'s results are shown'), min,
        h('p', { class: 'muted small' }, 'This protects anonymity. With a minimum of 3, nobody can work out who wrote a comment by elimination. Lowering it to 1 means a person who was evaluated once could guess their evaluator.'),
        h('div', { class: 'actions' }, h('button', { onclick: async () => { try { await api('PUT', '/api/admin/settings', { minResponses: min.value, orgName: org.value }); toast('Saved'); await loadOverview(); resultsCache = {}; } catch (ex) { toast(ex.message, 'error'); } } }, 'Save settings'))),
      h('div', { class: 'card' }, h('h2', null, 'Change admin password'),
        h('label', null, 'Current password'), cur, h('label', null, 'New password (at least 8 characters)'), nw,
        h('div', { class: 'actions' }, h('button', { onclick: async () => { try { await api('POST', '/api/admin/password', { current: cur.value, password: nw.value }); toast('Password changed'); cur.value = nw.value = ''; } catch (ex) { toast(ex.message, 'error'); } } }, 'Change password'))),
      h('div', { class: 'card' }, h('h2', null, 'Sample data (for trying the app)'),
        h('p', { class: 'muted small' }, 'Load a fictional roster and randomly generated evaluations to see how the results look. Replace them with your real employee list when you are ready.'),
        h('div', { class: 'actions' }, demoBtn('Load sample employees and demo responses', 'all'), demoBtn('Load sample employees only (no responses)', 'employees'), demoBtn('Regenerate demo responses for current employees', 'responses'))),
      h('div', { class: 'card' }, h('h2', null, 'Reset'),
        h('div', { class: 'actions' }, resetBtn('Delete all responses (keep employees)', 'responses'), resetBtn('Delete everything (employees and responses)', 'all'))),
      h('div', { class: 'card' }, h('h2', null, 'How anonymity works'),
        h('ul', { class: 'small' },
          h('li', null, 'Each evaluation is stored with only the survey, the colleague being evaluated and the answers. No evaluator, no timestamp, no IP address.'),
          h('li', null, 'A separate list records that an access code has finished a given colleague, so each person can evaluate every colleague once. This list cannot be joined to the answers.'),
          h('li', null, 'Written comments are shown in random order, and results stay hidden until the minimum number of evaluations is reached.'),
          h('li', null, 'The admin only sees whether someone has participated, never whom they evaluated.'))),
    );
  }

  // ---------- boot ----------
  (async () => { try { await loadOverview(); render(); } catch { renderLogin(); } })();
})();
