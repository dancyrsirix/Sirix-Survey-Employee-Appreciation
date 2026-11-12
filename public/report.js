// Shared renderer for the personal appreciation report (used by the employee page and the admin print page).
window.renderReport = function renderReport(r, opts = {}) {
  const h = (tag, attrs, ...children) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') el.className = v; else if (v != null && v !== false) el.setAttribute(k, v);
    }
    for (const c of children.flat(Infinity)) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
    return el;
  };
  const fmt = n => n == null ? '–' : (Math.round(n * 10) / 10).toFixed(1);
  const bar = (v, ref) => h('div', { class: 'bar' + (ref ? ' ref' : ''), title: fmt(v) }, h('div', { style: `width:${v == null ? 0 : (v / 5) * 100}%` }));
  const p = r.person;
  const card = h('div', { class: 'report' });
  card.append(h('div', { class: 'head' },
    h('div', null, h('h2', null, p.name), h('div', { class: 'muted small' }, [p.role, p.department].filter(Boolean).join(' · '))),
    h('div', { class: 'small muted', style: 'text-align:right' }, 'Rapport d’appréciation du travail', h('br'), r.group.name)));

  if (!p.visible) {
    card.append(h('div', { class: 'alert info' }, `${p.responses} évaluation(s) reçue(s). Un rapport est produit seulement à partir de ${r.minResponses} évaluations, afin de préserver l’anonymat des répondants.`));
    return card;
  }

  card.append(h('p', null, h('b', null, `${p.responses} collègues`), ' ont rempli le sondage à ton sujet. Les notes vont de 1 (pas du tout d’accord) à 5 (tout à fait d’accord). Les moyennes du département et de l’entreprise sont indiquées à titre de repère.'));

  const rows = r.categories.map((c, i) => h('tr', null,
    h('td', null, h('b', null, c.category || `Énoncé ${i + 1}`), h('div', { class: 'small muted' }, c.text)),
    h('td', { class: 'num' }, h('b', null, fmt(c.mine && c.mine.avg)), c.mine ? h('span', { class: 'small muted' }, ` (${c.mine.n})`) : null),
    h('td', null, bar(c.mine && c.mine.avg)),
    h('td', { class: 'num' }, fmt(c.department)),
    h('td', { class: 'num' }, fmt(c.company)),
  ));
  rows.push(h('tr', null, h('td', null, h('b', null, 'Moyenne générale')), h('td', { class: 'num' }, h('b', null, fmt(r.overall.mine))), h('td', null, bar(r.overall.mine)), h('td', { class: 'num' }, fmt(r.overall.department)), h('td', { class: 'num' }, fmt(r.overall.company))));
  card.append(h('div', { class: 'table-wrap' }, h('table', { class: 'scores' },
    h('thead', null, h('tr', null, h('th', null, 'Catégorie'), h('th', { class: 'num' }, 'Ta moyenne'), h('th', null, ''), h('th', { class: 'num' }, 'Département'), h('th', { class: 'num' }, 'Entreprise'))),
    h('tbody', null, rows))));

  const rated = r.categories.filter(c => c.mine);
  if (rated.length >= 2) {
    const sorted = [...rated].sort((a, b) => b.mine.avg - a.mine.avg);
    const best = sorted[0], worst = sorted[sorted.length - 1];
    card.append(h('div', { class: 'hl' },
      h('div', { class: 'strong' }, h('b', null, 'Point fort'), `${best.category} (${fmt(best.mine.avg)})`),
      h('div', { class: 'work' }, h('b', null, 'À travailler en priorité'), `${worst.category} (${fmt(worst.mine.avg)})`)));
  }

  const textQs = r.questions.filter(q => q.type === 'text');
  for (const q of textQs) {
    const list = r.comments[q.id] || [];
    card.append(h('h3', null, q.text));
    card.append(list.length ? h('ul', { class: 'comments' }, list.map(c => h('li', null, c))) : h('p', { class: 'muted small' }, 'Aucun commentaire reçu.'));
  }
  card.append(h('div', { class: 'foot' }, h('span', null, 'Résultats anonymes : aucune réponse n’est associée à son auteur.'), h('span', null, opts.orgName || 'Sirix Monitoring')));
  return card;
};
