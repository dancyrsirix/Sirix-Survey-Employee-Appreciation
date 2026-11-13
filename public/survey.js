(function () {
  const app = document.getElementById('app');
  const code = location.pathname.replace(/^\/s\/?/, '').replace(/[^A-Za-z0-9-]/g, '');
  let data = null;
  let reports = null;
  let view = { mode: 'list' }; // or { mode: 'form', groupId, targetId } or { mode: 'reports' }

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v != null && v !== false) el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat(Infinity)) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
    return el;
  }

  async function load() {
    if (!code) { location.href = '/'; return; }
    const r = await fetch('/api/survey/' + encodeURIComponent(code));
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      app.replaceChildren(h('div', { class: 'card' }, h('div', { class: 'alert error' }, j.error || 'Invalid code.'), h('a', { href: '/' }, 'Enter your code again')));
      return;
    }
    data = j;
    document.getElementById('who').textContent = `${j.employee.name} (${j.employee.department})`;
    if (j.groups.some(g => g.status === 'released')) {
      const rr = await fetch('/api/survey/' + encodeURIComponent(code) + '/reports');
      if (rr.ok) reports = await rr.json();
    }
    render();
  }

  function render() {
    window.scrollTo(0, 0);
    if (view.mode === 'form') return renderForm();
    if (view.mode === 'reports') return renderReports();
    const parts = [];
    parts.push(h('div', { class: 'card' },
      h('h2', null, 'Work Appreciation Survey'),
      h('p', { class: 'muted' }, `Hi ${data.employee.name.split(' ')[0]}. Evaluate your colleagues on their day-to-day work: 5 statements and an optional comment per person, about a minute each. Don’t work enough with someone? Skip that person, or tick N/A on the statements you can’t judge. You can come back later with the same code to continue.`),
      h('p', { class: 'muted small' }, 'Your answers are confidential and are never shared with other employees. Results are shared as averages only, and only once a person has received a few evaluations.'),
    ));
    if (reports && reports.reports.length) {
      parts.push(h('div', { class: 'card' },
        h('h2', null, 'Your report is available'),
        h('p', { class: 'muted small' }, 'The survey results have been shared. Open your personal report to see your strengths and what you can work on.'),
        h('div', { class: 'actions' }, h('button', { class: 'accent', onclick: () => { view = { mode: 'reports' }; render(); } }, 'See my report'))));
    }
    for (const g of data.groups) {
      const done = g.targets.filter(t => t.done).length;
      const open = g.status === 'open';
      const card = h('div', { class: 'card' },
        h('h2', null, g.name, ' ', !open ? h('span', { class: 'pill closed' }, 'closed') : null),
        g.description ? h('p', { class: 'muted small' }, g.description) : null,
        h('div', { class: 'progress' }, h('div', { style: `width:${g.targets.length ? (100 * done / g.targets.length) : 0}%` })),
        h('p', { class: 'small muted' }, `${done} of ${g.targets.length} colleagues evaluated. You don’t have to evaluate everyone.`),
      );
      const byDept = {};
      for (const t of g.targets) (byDept[t.department] ||= []).push(t);
      for (const dept of Object.keys(byDept)) {
        card.append(h('div', { class: 'dept-title' }, dept));
        card.append(h('div', { class: 'people' }, byDept[dept].map(t =>
          h('button', { class: 'person' + (t.done ? ' done' : ''), type: 'button', disabled: t.done || !open,
              onclick: () => { if (!t.done && open) { view = { mode: 'form', groupId: g.id, targetId: t.id }; render(); } } },
            h('div', null, h('div', { class: 'name' }, t.name), h('div', { class: 'role' }, t.role || '')),
            h('span', { class: 'pill ' + (t.done ? 'done' : 'todo') }, t.done ? 'Done' : 'Evaluate'))
        )));
      }
      parts.push(card);
    }
    if (!data.groups.length) parts.push(h('div', { class: 'card' }, h('p', null, 'You are not part of any open survey at the moment.')));
    app.replaceChildren(...parts);
  }

  function legend() {
    const items = [['1', 'Strongly disagree'], ['2', 'Somewhat disagree'], ['3', 'Neutral'], ['4', 'Somewhat agree'], ['5', 'Strongly agree'], ['N/A', 'I cannot evaluate']];
    return h('div', { class: 'legend' }, items.map(([v, l]) => h('div', { class: v === 'N/A' ? 'na' : '' }, h('b', null, v), h('br'), l)));
  }

  function renderForm() {
    const g = data.groups.find(x => x.id === view.groupId);
    const t = g.targets.find(x => x.id === view.targetId);
    const answers = {};
    const err = h('div', { class: 'alert error', style: 'display:none' });
    // Some colleagues (e.g. managers in the operations survey) are evaluated with another survey's statements.
    const questions = (g.questionSets && g.questionSets[t.questionSet]) || g.questions;
    const ratingQs = questions.filter(q => q.type === 'rating');
    const textQs = questions.filter(q => q.type === 'text');

    const rows = [];
    ratingQs.forEach((q, i) => {
      if (q.category && (i === 0 || ratingQs[i - 1].category !== q.category)) rows.push(h('tr', { class: 'cat' }, h('td', { colspan: 8 }, q.category)));
      const name = 'q' + i;
      rows.push(h('tr', null,
        h('td', { class: 'num' }, i + 1),
        h('td', { class: 'left' }, q.text),
        [1, 2, 3, 4, 5].map(n => h('td', { class: 'opt' }, h('input', { type: 'radio', name, value: n, 'aria-label': `${n} for statement ${i + 1}`, onchange: () => { answers[q.id] = n; } }))),
        h('td', { class: 'opt' }, h('input', { type: 'radio', name, value: 'na', 'aria-label': `N/A for statement ${i + 1}`, onchange: () => { delete answers[q.id]; } })),
      ));
    });
    const table = h('table', { class: 'form' },
      h('thead', null, h('tr', null, h('th', { class: 'left' }, '#'), h('th', { class: 'left' }, 'Statement'), ['1', '2', '3', '4', '5', 'N/A'].map(x => h('th', null, x)))),
      h('tbody', null, rows));

    const submit = h('button', { type: 'button', onclick: async () => {
      const unanswered = ratingQs.filter((q, i) => !document.querySelector(`input[name=q${i}]:checked`)).length;
      if (unanswered && !confirm(`${unanswered} unanswered statement(s) will count as N/A. Submit anyway?`)) return;
      submit.disabled = true; err.style.display = 'none';
      const r = await fetch('/api/survey/' + encodeURIComponent(code) + '/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ group_id: g.id, target_id: t.id, answers }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { err.textContent = j.error || 'Something went wrong.'; err.style.display = 'block'; submit.disabled = false; return; }
      t.done = true; view = { mode: 'list' }; render();
    } }, 'Submit evaluation');

    app.replaceChildren(h('div', { class: 'card' },
      h('button', { class: 'link', type: 'button', onclick: () => { view = { mode: 'list' }; render(); } }, '← Back to the list (nothing will be saved)'),
      h('h2', { style: 'margin-top:12px' }, 'Work Appreciation Survey'),
      h('p', { class: 'muted small' }, 'Evaluate your colleague on their day-to-day work. No answer is linked to its author. Don’t work enough with this person? Tick ', h('b', null, 'N/A'), '.'),
      h('p', null, h('b', null, 'Person evaluated: '), t.name, h('span', { class: 'muted small' }, ' · ', [t.role, t.department].filter(Boolean).join(' · '))),
      legend(),
      h('div', { class: 'table-wrap' }, table),
      textQs.map(q => [h('label', null, q.text, ' ', h('span', { class: 'muted', style: 'font-weight:400' }, '(optional)')), h('textarea', { placeholder: 'One concrete piece of advice this person can act on', oninput: (e) => { answers[q.id] = e.target.value; } })]),
      err,
      h('div', { class: 'actions' }, submit, h('button', { type: 'button', class: 'secondary', onclick: () => { view = { mode: 'list' }; render(); } }, 'Cancel')),
      h('p', { class: 'muted small', style: 'margin-top:14px' }, 'Once submitted, the evaluation is final. Thank you for taking part. Results are shared as averages only.'),
    ));
  }

  function renderReports() {
    app.replaceChildren(
      h('div', { class: 'card no-print' }, h('button', { class: 'link', type: 'button', onclick: () => { view = { mode: 'list' }; render(); } }, '← Back'), ' ', h('button', { class: 'secondary', style: 'margin-left:12px', onclick: () => window.print() }, 'Print / save as PDF')),
      ...reports.reports.map(r => h('div', { class: 'card' }, window.renderReport(r, { orgName: reports.orgName }))),
    );
  }

  load();
})();
