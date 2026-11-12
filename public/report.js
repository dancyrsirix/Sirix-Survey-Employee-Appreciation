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
    h('div', { class: 'small muted', style: 'text-align:right' }, 'Work appreciation report', h('br'), r.group.name)));

  if (!p.visible) {
    card.append(h('div', { class: 'alert info' }, `${p.responses} evaluation(s) received. A report is only produced from ${r.minResponses} evaluations, to protect the anonymity of the respondents.`));
    return card;
  }

  card.append(h('p', null, h('b', null, `${p.responses} colleagues`), ' filled out the survey about you. Scores go from 1 (strongly disagree) to 5 (strongly agree). The department and company averages are shown as a reference.'));

  const rows = r.categories.map((c, i) => h('tr', null,
    h('td', null, h('b', null, c.category || `Statement ${i + 1}`), h('div', { class: 'small muted' }, c.text)),
    h('td', { class: 'num' }, h('b', null, fmt(c.mine && c.mine.avg)), c.mine ? h('span', { class: 'small muted' }, ` (${c.mine.n})`) : null),
    h('td', null, bar(c.mine && c.mine.avg)),
    h('td', { class: 'num' }, fmt(c.department)),
    h('td', { class: 'num' }, fmt(c.company)),
  ));
  rows.push(h('tr', null, h('td', null, h('b', null, 'Overall average')), h('td', { class: 'num' }, h('b', null, fmt(r.overall.mine))), h('td', null, bar(r.overall.mine)), h('td', { class: 'num' }, fmt(r.overall.department)), h('td', { class: 'num' }, fmt(r.overall.company))));
  card.append(h('div', { class: 'table-wrap' }, h('table', { class: 'scores' },
    h('thead', null, h('tr', null, h('th', null, 'Category'), h('th', { class: 'num' }, 'Your average'), h('th', null, ''), h('th', { class: 'num' }, 'Department'), h('th', { class: 'num' }, 'Company'))),
    h('tbody', null, rows))));

  const rated = r.categories.filter(c => c.mine);
  if (rated.length >= 2) {
    const sorted = [...rated].sort((a, b) => b.mine.avg - a.mine.avg);
    const best = sorted[0], worst = sorted[sorted.length - 1];
    card.append(h('div', { class: 'hl' },
      h('div', { class: 'strong' }, h('b', null, 'Strength'), `${best.category} (${fmt(best.mine.avg)})`),
      h('div', { class: 'work' }, h('b', null, 'Priority to work on'), `${worst.category} (${fmt(worst.mine.avg)})`)));
  }

  const textQs = r.questions.filter(q => q.type === 'text');
  for (const q of textQs) {
    const list = r.comments[q.id] || [];
    card.append(h('h3', null, q.text));
    card.append(list.length ? h('ul', { class: 'comments' }, list.map(c => h('li', null, c))) : h('p', { class: 'muted small' }, 'No comments received.'));
  }
  card.append(h('div', { class: 'foot' }, h('span', null, 'Anonymous results: no answer is linked to its author.'), h('span', null, opts.orgName || 'Sirix Monitoring')));
  return card;
};
