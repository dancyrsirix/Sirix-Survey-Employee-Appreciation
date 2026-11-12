(function () {
  const app = document.getElementById('app');
  const code = location.pathname.replace(/^\/s\/?/, '').replace(/[^A-Za-z0-9-]/g, '');
  let data = null;
  let view = { mode: 'list' }; // or { mode: 'form', groupId, targetId }

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v != null) el.setAttribute(k, v);
    }
    for (const c of children.flat()) if (c != null) el.append(c.nodeType ? c : document.createTextNode(String(c)));
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
    render();
  }

  function render() {
    window.scrollTo(0, 0);
    if (view.mode === 'form') return renderForm();
    const parts = [];
    parts.push(h('div', { class: 'card' },
      h('h2', null, `Hello ${data.employee.name.split(' ')[0]}`),
      h('p', { class: 'muted' }, 'Pick a colleague below to give them feedback. Only evaluate people you actually work with; skip the others. You can answer as many or as few questions as you want, and you can come back later with the same code to continue.'),
      h('p', { class: 'muted small' }, 'Your answers are anonymous. They are stored without your name, your code or the time of submission, so nobody, including management, can see who wrote what. Results are only shown for a colleague once at least a few people have evaluated them.'),
    ));
    for (const g of data.groups) {
      const done = g.targets.filter(t => t.done).length;
      const card = h('div', { class: 'card' },
        h('h2', null, g.name, ' ', g.status !== 'open' ? h('span', { class: 'pill closed' }, 'closed') : null),
        g.description ? h('p', { class: 'muted small' }, g.description) : null,
        h('div', { class: 'progress' }, h('div', { style: `width:${g.targets.length ? (100 * done / g.targets.length) : 0}%` })),
        h('p', { class: 'small muted' }, `${done} of ${g.targets.length} colleagues evaluated. You do not have to evaluate everyone.`),
      );
      const byDept = {};
      for (const t of g.targets) (byDept[t.department] ||= []).push(t);
      for (const dept of Object.keys(byDept)) {
        card.append(h('div', { class: 'dept-title' }, dept));
        card.append(h('div', { class: 'people' }, byDept[dept].map(t =>
          h('button', { class: 'person' + (t.done ? ' done' : ''), type: 'button', disabled: t.done || g.status !== 'open' ? 'disabled' : null,
              onclick: () => { if (!t.done && g.status === 'open') { view = { mode: 'form', groupId: g.id, targetId: t.id }; render(); } } },
            h('div', null, h('div', { class: 'name' }, t.name), h('div', { class: 'role' }, t.role || '')),
            h('span', { class: 'pill ' + (t.done ? 'done' : 'todo') }, t.done ? 'Done' : 'Evaluate'))
        )));
      }
      parts.push(card);
    }
    if (!data.groups.length) parts.push(h('div', { class: 'card' }, h('p', null, 'You are not part of any open survey right now.')));
    app.replaceChildren(...parts);
  }

  function renderForm() {
    const g = data.groups.find(x => x.id === view.groupId);
    const t = g.targets.find(x => x.id === view.targetId);
    const answers = {};
    const err = h('div', { class: 'alert error', style: 'display:none' });
    const questions = g.questions.map(q => {
      if (q.type === 'rating') {
        const btns = [1, 2, 3, 4, 5].map(n => h('button', { type: 'button', onclick: (e) => {
          answers[q.id] = n;
          for (const b of e.currentTarget.parentElement.querySelectorAll('button')) b.classList.toggle('selected', Number(b.textContent) === n);
        } }, n));
        const clear = h('button', { type: 'button', class: 'clear', onclick: (e) => { delete answers[q.id]; for (const b of e.currentTarget.parentElement.querySelectorAll('button')) b.classList.remove('selected'); } }, 'clear');
        return h('div', { class: 'question' }, h('div', { class: 'qtext' }, q.text), h('div', { class: 'scale' }, btns, clear, h('span', { class: 'hint' }, '1 = strongly disagree, 5 = strongly agree')));
      }
      return h('div', { class: 'question' }, h('div', { class: 'qtext' }, q.text), h('textarea', { placeholder: 'Optional', oninput: (e) => { answers[q.id] = e.target.value; } }));
    });
    const submit = h('button', { type: 'button', onclick: async () => {
      submit.disabled = true; err.style.display = 'none';
      const r = await fetch('/api/survey/' + encodeURIComponent(code) + '/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ group_id: g.id, target_id: t.id, answers }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { err.textContent = j.error || 'Something went wrong.'; err.style.display = 'block'; submit.disabled = false; return; }
      t.done = true; view = { mode: 'list' }; render();
    } }, 'Submit evaluation');
    app.replaceChildren(h('div', { class: 'card' },
      h('button', { class: 'link', type: 'button', onclick: () => { view = { mode: 'list' }; render(); } }, '← Back to the list (nothing will be saved)'),
      h('h2', { style: 'margin-top:12px' }, t.name),
      h('p', { class: 'muted small' }, [t.role, t.department].filter(Boolean).join(' · ')),
      h('div', { class: 'alert info small' }, 'Answer only what you can judge. Leave a question blank to skip it. Once submitted, this evaluation is final and cannot be changed. ', h('b', null, 'Your answers are anonymous.')),
      ...questions,
      err,
      h('div', { class: 'actions' }, submit, h('button', { type: 'button', class: 'secondary', onclick: () => { view = { mode: 'list' }; render(); } }, 'Cancel')),
    ));
  }

  load();
})();
