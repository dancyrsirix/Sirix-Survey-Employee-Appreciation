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
      app.replaceChildren(h('div', { class: 'card' }, h('div', { class: 'alert error' }, j.error || 'Code invalide.'), h('a', { href: '/' }, 'Entrer ton code à nouveau')));
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
      h('h2', null, 'Sondage d’appréciation du travail'),
      h('p', { class: 'muted' }, `Bonjour ${data.employee.name.split(' ')[0]}. Évalue tes collègues sur leur travail au quotidien : 5 énoncés et un commentaire facultatif par personne, ça prend une minute. Tu ne travailles pas assez avec quelqu’un ? Passe cette personne, ou coche N/A sur les énoncés que tu ne peux pas juger. Tu peux revenir plus tard avec le même code pour continuer.`),
      h('p', { class: 'muted small' }, 'Aucune réponse n’est associée à son auteur : tes réponses sont enregistrées sans ton nom, sans ton code et sans l’heure. Les résultats sont partagés sous forme de moyennes seulement, et uniquement à partir de quelques évaluations par personne.'),
    ));
    if (reports && reports.reports.length) {
      parts.push(h('div', { class: 'card' },
        h('h2', null, 'Ton rapport est disponible'),
        h('p', { class: 'muted small' }, 'Les résultats du sondage ont été partagés. Consulte le rapport qui te concerne pour voir tes points forts et ce que tu peux travailler.'),
        h('div', { class: 'actions' }, h('button', { class: 'accent', onclick: () => { view = { mode: 'reports' }; render(); } }, 'Voir mon rapport'))));
    }
    for (const g of data.groups) {
      const done = g.targets.filter(t => t.done).length;
      const open = g.status === 'open';
      const card = h('div', { class: 'card' },
        h('h2', null, g.name, ' ', !open ? h('span', { class: 'pill closed' }, 'fermé') : null),
        g.description ? h('p', { class: 'muted small' }, g.description) : null,
        h('div', { class: 'progress' }, h('div', { style: `width:${g.targets.length ? (100 * done / g.targets.length) : 0}%` })),
        h('p', { class: 'small muted' }, `${done} de ${g.targets.length} collègues évalués. Tu n’es pas obligé(e) d’évaluer tout le monde.`),
      );
      const byDept = {};
      for (const t of g.targets) (byDept[t.department] ||= []).push(t);
      for (const dept of Object.keys(byDept)) {
        card.append(h('div', { class: 'dept-title' }, dept));
        card.append(h('div', { class: 'people' }, byDept[dept].map(t =>
          h('button', { class: 'person' + (t.done ? ' done' : ''), type: 'button', disabled: t.done || !open,
              onclick: () => { if (!t.done && open) { view = { mode: 'form', groupId: g.id, targetId: t.id }; render(); } } },
            h('div', null, h('div', { class: 'name' }, t.name), h('div', { class: 'role' }, t.role || '')),
            h('span', { class: 'pill ' + (t.done ? 'done' : 'todo') }, t.done ? 'Fait' : 'Évaluer'))
        )));
      }
      parts.push(card);
    }
    if (!data.groups.length) parts.push(h('div', { class: 'card' }, h('p', null, 'Tu ne fais partie d’aucun sondage ouvert pour le moment.')));
    app.replaceChildren(...parts);
  }

  function legend() {
    const items = [['1', 'Pas du tout d’accord'], ['2', 'Plutôt pas d’accord'], ['3', 'Neutre'], ['4', 'Plutôt d’accord'], ['5', 'Tout à fait d’accord'], ['N/A', 'Je ne peux pas évaluer']];
    return h('div', { class: 'legend' }, items.map(([v, l]) => h('div', { class: v === 'N/A' ? 'na' : '' }, h('b', null, v), h('br'), l)));
  }

  function renderForm() {
    const g = data.groups.find(x => x.id === view.groupId);
    const t = g.targets.find(x => x.id === view.targetId);
    const answers = {};
    const err = h('div', { class: 'alert error', style: 'display:none' });
    const ratingQs = g.questions.filter(q => q.type === 'rating');
    const textQs = g.questions.filter(q => q.type === 'text');

    const rows = [];
    ratingQs.forEach((q, i) => {
      if (q.category && (i === 0 || ratingQs[i - 1].category !== q.category)) rows.push(h('tr', { class: 'cat' }, h('td', { colspan: 8 }, q.category)));
      const name = 'q' + i;
      rows.push(h('tr', null,
        h('td', { class: 'num' }, i + 1),
        h('td', { class: 'left' }, q.text),
        [1, 2, 3, 4, 5].map(n => h('td', { class: 'opt' }, h('input', { type: 'radio', name, value: n, 'aria-label': `${n} pour l’énoncé ${i + 1}`, onchange: () => { answers[q.id] = n; } }))),
        h('td', { class: 'opt' }, h('input', { type: 'radio', name, value: 'na', 'aria-label': `N/A pour l’énoncé ${i + 1}`, onchange: () => { delete answers[q.id]; } })),
      ));
    });
    const table = h('table', { class: 'form' },
      h('thead', null, h('tr', null, h('th', { class: 'left' }, '#'), h('th', { class: 'left' }, 'Énoncé'), ['1', '2', '3', '4', '5', 'N/A'].map(x => h('th', null, x)))),
      h('tbody', null, rows));

    const submit = h('button', { type: 'button', onclick: async () => {
      const unanswered = ratingQs.filter((q, i) => !document.querySelector(`input[name=q${i}]:checked`)).length;
      if (unanswered && !confirm(`${unanswered} énoncé(s) sans réponse seront considérés comme N/A. Envoyer quand même ?`)) return;
      submit.disabled = true; err.style.display = 'none';
      const r = await fetch('/api/survey/' + encodeURIComponent(code) + '/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ group_id: g.id, target_id: t.id, answers }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { err.textContent = j.error || 'Une erreur est survenue.'; err.style.display = 'block'; submit.disabled = false; return; }
      t.done = true; view = { mode: 'list' }; render();
    } }, 'Envoyer l’évaluation');

    app.replaceChildren(h('div', { class: 'card' },
      h('button', { class: 'link', type: 'button', onclick: () => { view = { mode: 'list' }; render(); } }, '← Retour à la liste (rien ne sera enregistré)'),
      h('h2', { style: 'margin-top:12px' }, 'Sondage d’appréciation du travail'),
      h('p', { class: 'muted small' }, 'Évalue ton collègue sur son travail au quotidien. Aucune réponse n’est associée à son auteur. Tu ne travailles pas assez avec cette personne ? Coche ', h('b', null, 'N/A'), '.'),
      h('p', null, h('b', null, 'Personne évaluée : '), t.name, h('span', { class: 'muted small' }, ' · ', [t.role, t.department].filter(Boolean).join(' · '))),
      legend(),
      h('div', { class: 'table-wrap' }, table),
      textQs.map(q => [h('label', null, q.text, ' ', h('span', { class: 'muted', style: 'font-weight:400' }, '(facultatif)')), h('textarea', { placeholder: 'Un conseil concret que cette personne pourra appliquer', oninput: (e) => { answers[q.id] = e.target.value; } })]),
      err,
      h('div', { class: 'actions' }, submit, h('button', { type: 'button', class: 'secondary', onclick: () => { view = { mode: 'list' }; render(); } }, 'Annuler')),
      h('p', { class: 'muted small', style: 'margin-top:14px' }, 'Une fois envoyée, l’évaluation est définitive. Merci de ta participation. Les résultats seront partagés sous forme de moyennes seulement.'),
    ));
  }

  function renderReports() {
    app.replaceChildren(
      h('div', { class: 'card no-print' }, h('button', { class: 'link', type: 'button', onclick: () => { view = { mode: 'list' }; render(); } }, '← Retour'), ' ', h('button', { class: 'secondary', style: 'margin-left:12px', onclick: () => window.print() }, 'Imprimer / enregistrer en PDF')),
      ...reports.reports.map(r => h('div', { class: 'card' }, window.renderReport(r, { orgName: reports.orgName }))),
    );
  }

  load();
})();
