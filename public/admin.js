(function () {
  const app = document.getElementById('app');
  let ov = null;           // overview data
  let role = 'owner';      // 'owner' sees everything; 'manager' (restricted account) sees averages only
  const isOwner = () => role === 'owner';
  let tab = 'results';
  let resultsGroup = null; // selected group id
  let resultsDept = '';    // department filter
  let expanded = new Set();
  let resultsCache = {};
  let mailPoll = null;     // timer polling the mailing progress
  let notifPoll = null;    // timer polling the activity feed
  let notifLastPoll = '';  // server time of the last poll (to toast new arrivals)
  let notifOpen = false;
  let notifItems = [];
  const SEEN_KEY = 'survey_admin_notif_seen';
  const getSeen = () => { try { return localStorage.getItem(SEEN_KEY) || ''; } catch { return ''; } };
  const setSeen = v => { try { localStorage.setItem(SEEN_KEY, v); } catch {} };

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
    const user = h('input', { type: 'text', autocomplete: 'username', value: setup ? 'admin' : '' });
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

  // One-time setup link (/admin?setup=TOKEN): the person chooses their password, then lands in the admin.
  async function renderSetup(token) {
    document.getElementById('hdr-right').textContent = '';
    let info;
    try { info = await api('GET', '/api/admin/manager-setup/' + encodeURIComponent(token)); }
    catch (ex) {
      return app.replaceChildren(h('div', { class: 'card login' }, h('h2', null, 'Link not valid'), h('p', null, ex.message), h('p', { class: 'small' }, h('a', { href: '/admin' }, 'Go to the login page'))));
    }
    const err = h('div', { class: 'alert error', style: 'display:none' });
    const pass = h('input', { type: 'password', autocomplete: 'new-password' });
    const pass2 = h('input', { type: 'password', autocomplete: 'new-password' });
    const form = h('form', { onsubmit: async (e) => {
      e.preventDefault();
      if (pass.value !== pass2.value) { err.textContent = 'Passwords do not match.'; err.style.display = 'block'; return; }
      try { await api('POST', '/api/admin/manager-setup/' + encodeURIComponent(token), { password: pass.value }); history.replaceState(null, '', '/admin'); await loadOverview(); render(); }
      catch (ex) { err.textContent = ex.message; err.style.display = 'block'; }
    } }, h('label', null, 'Username'), h('input', { type: 'text', value: info.username, readonly: true, autocomplete: 'username' }),
      h('label', null, 'Choose a password (at least 8 characters)'), pass, h('label', null, 'Confirm password'), pass2, err,
      h('div', { class: 'actions' }, h('button', { type: 'submit' }, 'Save and open the results')));
    app.replaceChildren(h('div', { class: 'card login' }, h('h2', null, 'Welcome to the ' + info.orgName + ' survey results'),
      h('p', { class: 'muted small' }, 'Choose the password you will use to log in at ' + location.origin + '/admin. Only a hashed version is stored.'), form));
  }

  async function loadOverview() {
    ov = await api('GET', '/api/admin/overview');
    if (!resultsGroup || !ov.groups.find(g => g.id === resultsGroup)) resultsGroup = ov.groups[0] && ov.groups[0].id;
    role = ov.role === 'manager' ? 'manager' : 'owner';
    document.getElementById('hdr-right').replaceChildren(h('span', { class: 'hdr-row' }, ov.orgName + ' · ', isOwner() ? h('span', { id: 'notif' }) : null, h('button', { class: 'link', style: 'color:#fff', onclick: async () => { stopNotifPoll(); await api('POST', '/api/admin/logout'); renderLogin(); } }, 'Log out')));
    if (isOwner()) startNotifPoll(); else stopNotifPoll();
  }

  // ---------- notifications (top right): latest evaluations submitted ----------
  function ago(iso) {
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    return new Date(iso).toLocaleDateString();
  }
  function drawNotif() {
    const slot = document.getElementById('notif');
    if (!slot) return;
    const seen = getSeen();
    const unseen = notifItems.filter(i => i.at > seen).length;
    const list = notifItems.length ? h('ul', null, notifItems.map(i => h('li', { class: i.at > seen ? 'new' : '', onclick: () => {
      notifOpen = false; tab = 'results'; resultsGroup = i.groupId; resultsDept = ''; expanded = new Set([i.targetId]); delete resultsCache[i.groupId]; render(); drawNotif();
    } }, h('b', null, i.evaluator), ' evaluated ', h('b', null, i.target), h('div', { class: 'small muted' }, (i.groupName || i.groupId) + ' · ' + ago(i.at))))) : h('p', { class: 'muted small', style: 'margin:0' }, 'No evaluations yet.');
    slot.replaceChildren(h('span', { class: 'notif' + (notifOpen ? ' open' : '') },
      h('button', { class: 'bell', title: unseen ? unseen + ' new evaluation(s)' : 'Latest evaluations', onclick: (e) => { e.stopPropagation(); notifOpen = !notifOpen; if (notifOpen && notifItems.length) setSeen(notifItems[0].at); drawNotif(); } },
        '\u{1F514}', unseen ? h('span', { class: 'badge' }, unseen > 99 ? '99+' : unseen) : null),
      notifOpen ? h('div', { class: 'panel', onclick: e => e.stopPropagation() }, h('div', { class: 'panel-head' }, 'Latest evaluations', h('button', { class: 'link small', onclick: () => { notifOpen = false; drawNotif(); } }, 'Close')), list) : null));
  }
  async function pollNotif() {
    try {
      const r = await api('GET', '/api/admin/activity?limit=30' + (notifLastPoll ? '&since=' + encodeURIComponent(notifLastPoll) : ''));
      if (notifLastPoll && r.newSince > 0) {
        toast(r.newSince === 1 ? `New evaluation: ${r.items[0].evaluator} evaluated ${r.items[0].target}` : `${r.newSince} new evaluations submitted`);
        resultsCache = {};
      }
      notifLastPoll = r.now; notifItems = r.items; drawNotif();
    } catch { /* logged out or offline: the next poll will retry */ }
  }
  function startNotifPoll() { stopNotifPoll(); pollNotif(); notifPoll = setInterval(pollNotif, 30000); }
  function stopNotifPoll() { if (notifPoll) { clearInterval(notifPoll); notifPoll = null; } }
  document.addEventListener('click', () => { if (notifOpen) { notifOpen = false; drawNotif(); } });

  // ---------- layout ----------
  function render() {
    const tabs = isOwner()
      ? [['results', 'Results'], ['ranking', 'Ranking'], ['reports', 'Individual reports'], ['employees', 'Employees & links'], ['email', 'Email'], ['questions', 'Surveys & questions'], ['settings', 'Settings & demo data']]
      : [['results', 'Results'], ['reports', 'Individual reports'], ['employees', 'Employees'], ['settings', 'Settings']];
    if (!tabs.some(([id]) => id === tab)) tab = 'results';
    stopMailPoll();
    app.replaceChildren(
      h('div', { class: 'tabs' }, tabs.map(([id, label]) => h('button', { class: id === tab ? 'active' : '', onclick: () => { tab = id; render(); } }, label))),
      h('div', { id: 'tab' }, h('p', { class: 'muted' }, 'Loading...')),
    );
    ({ results: renderResults, ranking: renderRanking, reports: renderReports, employees: renderEmployees, email: renderEmail, questions: renderQuestions, settings: renderSettings })[tab]();
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
      h('a', { class: 'btn', href: '/api/admin/results/' + resultsGroup + '.csv', style: 'flex:0 0 auto;text-decoration:none' }, 'Export averages (CSV)'),
      isOwner() ? h('a', { class: 'btn', href: '/api/admin/evaluations/' + resultsGroup + '.csv', style: 'flex:0 0 auto;text-decoration:none', title: 'One line per evaluation, with the name of the person who wrote it' }, 'Export every evaluation (CSV)') : null,
    );
    const stats = h('div', { class: 'stats' },
      h('div', { class: 'stat' }, h('div', { class: 'v' }, r.totalResponses), h('div', { class: 'l' }, 'Evaluations submitted')),
      h('div', { class: 'stat' }, h('div', { class: 'v' }, `${r.evaluatorsCount} / ${r.evaluatorsTotal}`), h('div', { class: 'l' }, 'People who have participated')),
      h('div', { class: 'stat' }, h('div', { class: 'v' }, r.minResponses), h('div', { class: 'l' }, 'Minimum evaluations to show a person')),
      h('div', { class: 'stat' }, h('div', { class: 'v' }, r.group.status), h('div', { class: 'l' }, 'Survey status')),
    );

    // Department summary
    const deptTable = h('table', null,
      h('thead', null, h('tr', null, h('th', null, 'Department'), h('th', { class: 'num' }, 'Evaluations'), h('th', { class: 'num' }, 'Overall'), ratingQs.map((q, i) => h('th', { class: 'num', title: q.text }, q.category || 'Q' + (i + 1))))),
      h('tbody', null, r.departments.filter(d => !resultsDept || d.name === resultsDept).map(d => h('tr', null,
        h('td', null, d.name), h('td', { class: 'num' }, d.responses),
        h('td', { class: 'num' }, d.visible ? h('span', { class: scoreClass(d.overall) }, fmt(d.overall)) : h('span', { class: 'pill hidden' }, 'not enough data')),
        ratingQs.map(q => h('td', { class: 'num' }, d.visible && d.ratings[q.id] ? h('span', { class: scoreClass(d.ratings[q.id].avg) }, fmt(d.ratings[q.id].avg)) : '')),
      ))));

    // People table
    const rows = [];
    const setName = id => (ov.groups.find(g => g.id === id) || { name: id }).name;
    const otherSets = Object.keys(r.questionSets || {}).filter(id => id !== r.group.id);
    for (const p of people) {
      const ownSet = !p.questionSet || p.questionSet === r.group.id;
      const pRatingQs = ownSet ? ratingQs : (r.questionSets[p.questionSet] || []).filter(q => q.type === 'rating');
      const pTextQs = ownSet ? textQs : (r.questionSets[p.questionSet] || []).filter(q => q.type === 'text');
      rows.push(h('tr', { class: 'clickable', onclick: () => { expanded.has(p.id) ? expanded.delete(p.id) : expanded.add(p.id); renderResults(); } },
        h('td', null, h('b', null, p.name), h('div', { class: 'small muted' }, [p.role, p.department].filter(Boolean).join(' · ')), ownSet ? null : h('div', { class: 'small muted' }, 'Evaluated with the statements of: ' + setName(p.questionSet))),
        h('td', { class: 'num' }, p.responses),
        h('td', { class: 'num' }, p.visible ? h('span', { class: scoreClass(p.overall) }, fmt(p.overall)) : h('span', { class: 'pill hidden' }, `hidden until ${r.minResponses}`)),
        ownSet ? ratingQs.map(q => h('td', { class: 'num' }, p.visible && p.ratings[q.id] ? h('span', { class: scoreClass(p.ratings[q.id].avg) }, fmt(p.ratings[q.id].avg)) : ''))
          : h('td', { colspan: ratingQs.length, class: 'small muted' }, p.visible ? 'Other statements: click the row for the breakdown' : ''),
      ));
      const evals = p.evaluations || [];
      if (expanded.has(p.id) && (p.visible || evals.length)) {
        const evalTable = h('table', null,
          h('thead', null, h('tr', null, h('th', null, 'Written by'), h('th', { class: 'num' }, 'Overall'), pRatingQs.map((q, i) => h('th', { class: 'num', title: q.text }, q.category || 'Q' + (i + 1))), h('th', null, 'Comment'))),
          h('tbody', null, evals.map(ev => h('tr', null,
            h('td', null, ev.attribution === 'recorded' ? h('b', null, ev.evaluator)
              : ev.attribution === 'deduced' ? [h('b', { class: 'deduced' }, ev.evaluator), ' ', h('span', { class: 'pill todo', title: 'Submitted before names were recorded; the author was deduced by elimination (only one person had finished this colleague) and agreed to be named' }, 'deduced')]
              : ev.attribution === 'possible' ? [h('span', { class: 'possible' }, 'One of: ' + ev.candidates.join(', ')), ' ', h('span', { class: 'pill closed', title: 'Submitted before names were recorded; several people had finished this colleague, so it cannot be narrowed down further. All of them agreed to be named.' }, 'uncertain')]
              : h('span', { class: 'muted' }, 'Anonymous (before names were recorded)')),
            h('td', { class: 'num' }, ev.overall == null ? '' : h('span', { class: scoreClass(ev.overall) }, fmt(ev.overall))),
            pRatingQs.map(q => h('td', { class: 'num' }, ev.ratings[q.id] == null ? h('span', { class: 'muted' }, 'N/A') : h('span', { class: scoreClass(ev.ratings[q.id]) }, String(ev.ratings[q.id])))),
            h('td', { class: 'small' }, pTextQs.map(q => ev.comments[q.id] || '').filter(Boolean).join(' | ')),
          ))));
        rows.push(h('tr', null, h('td', { colspan: 3 + ratingQs.length }, h('div', { class: 'detail' },
          !isOwner() ? null : [h('h3', null, `Each evaluation received (${evals.length})`),
          h('p', { class: 'muted small' }, 'Confidential: only you see who wrote what. Employees only ever receive averages and comments in random order. ',
            h('b', null, 'Bold name'), ': recorded when submitted. ', h('span', { class: 'pill todo' }, 'deduced'), ': submitted before names were recorded, author worked out by elimination, person agreed to be named. ',
            h('span', { class: 'pill closed' }, 'uncertain'), ': one of several people who all agreed. ', h('b', null, 'Anonymous'), ': cannot be narrowed down, or a possible author did not agree.'),
          evals.length ? h('div', { class: 'table-wrap' }, evalTable) : h('p', { class: 'muted small' }, 'No evaluations yet.')],
          p.visible ? h('h3', null, 'Averages') : h('p', { class: 'muted small' }, `Averages and the personal report appear once ${r.minResponses} evaluations are in.`),
          !p.visible ? null : pRatingQs.map((q, i) => {
            const s = p.ratings[q.id];
            return h('div', { class: 'small', style: 'margin-bottom:4px' }, h('b', null, (q.category || 'Q' + (i + 1)) + ': '), q.text, ' ',
              s ? [h('span', { class: scoreClass(s.avg) }, fmt(s.avg)), ` (${s.n} answers)`, h('span', { class: 'dist', title: '1 to 5 distribution: ' + s.dist.join(' / ') }, s.dist.map(n => h('span', { style: `height:${4 + n * 4}px` })))] : h('span', { class: 'muted' }, 'no answers'));
          }),
        ))));
      }
    }
    const peopleTable = h('table', null,
      h('thead', null, h('tr', null, h('th', null, 'Person'), h('th', { class: 'num' }, 'Evaluations'), h('th', { class: 'num' }, 'Overall'), ratingQs.map((q, i) => h('th', { class: 'num', title: q.text }, q.category || 'Q' + (i + 1))))),
      h('tbody', null, rows));

    setTab(
      h('div', { class: 'card' }, h('h2', null, r.group.name), controls, h('div', { style: 'height:12px' }), stats),
      h('div', { class: 'card' }, h('h2', null, 'By department'), h('p', { class: 'muted small' }, 'Average score across all evaluations received by people in the department (1 to 5).'), h('div', { class: 'table-wrap' }, deptTable)),
      h('div', { class: 'card' }, h('h2', null, 'By person'), h('p', { class: 'muted small' }, isOwner() ? 'Click a row to see each evaluation received, with the name of the person who wrote it, and the averages. ' : 'Click a row to see the average per statement. ', 'Averages (and the personal report an employee receives) only appear once the minimum number of evaluations is reached, so that no employee can work out who wrote what by elimination.', otherSets.length ? ' Some people are evaluated with the statements of another survey (set per person in the Employees tab); their breakdown is in the row detail and the department columns only cover this survey’s statements.' : ''), h('div', { class: 'table-wrap' }, peopleTable),
        h('h3', null, 'Statements'), h('ol', { class: 'small muted' }, ratingQs.map(q => h('li', null, q.category ? [h('b', null, q.category + ': '), q.text] : q.text)))),
      !isOwner() ? null : h('div', { class: 'card' }, h('h2', null, 'By evaluator'),
        h('p', { class: 'muted small' }, 'Who evaluated whom in this survey, with the overall score they gave. Confidential: only you see this.', r.unattributed ? ` ${r.unattributed} evaluation(s) were submitted before names were recorded and cannot be attributed to one person.` : ''),
        (r.evaluators || []).length ? h('div', { class: 'table-wrap' }, h('table', null,
          h('thead', null, h('tr', null, h('th', null, 'Evaluator'), h('th', { class: 'num' }, 'Evaluations'), h('th', null, 'Evaluated (overall score given)'))),
          h('tbody', null, r.evaluators.map(ev => h('tr', null,
            h('td', null, h('b', null, ev.name)), h('td', { class: 'num' }, ev.targets.length),
            h('td', { class: 'small' }, ev.targets.map((t, i) => [i ? ', ' : '', t.name, t.attribution === 'deduced' ? h('span', { class: 'pill todo', style: 'margin-left:3px;font-size:10px;padding:0 5px' }, 'deduced') : null, t.overall == null ? '' : [' ', h('span', { class: scoreClass(t.overall) }, fmt(t.overall))]]))))))) : h('p', { class: 'muted small' }, 'No named evaluations yet.')),
    );
  }

  // ---------- ranking (owner): people ordered by their average score ----------
  let rankBy = 'overall';
  let rankMin = 3;         // evaluations needed to appear in the ranking (independent of the global minimum)
  async function renderRanking() {
    if (!resultsGroup) return setTab(h('div', { class: 'card' }, 'No surveys configured.'));
    const r = resultsCache[resultsGroup] || (resultsCache[resultsGroup] = await api('GET', '/api/admin/results/' + resultsGroup));
    const ratingQs = r.questions.filter(q => q.type === 'rating');
    if (rankBy !== 'overall' && !ratingQs.some(q => q.id === rankBy)) rankBy = 'overall';
    const depts = [...new Set(r.people.map(p => p.department))].sort();
    const setName = id => (ov.groups.find(g => g.id === id) || { name: id }).name;
    const score = p => rankBy === 'overall' ? p.overall : (p.ratings[rankBy] ? p.ratings[rankBy].avg : null);
    const people = r.people.filter(p => !resultsDept || p.department === resultsDept);
    const need = Math.max(rankMin, r.minResponses);
    const ranked = people.filter(p => p.visible && p.responses >= need && score(p) != null).sort((a, b) => score(b) - score(a) || b.responses - a.responses || a.name.localeCompare(b.name));
    const pending = people.filter(p => !(p.visible && p.responses >= need && score(p) != null)).sort((a, b) => b.responses - a.responses || a.name.localeCompare(b.name));
    const rankLabel = rankBy === 'overall' ? 'overall average' : (ratingQs.find(q => q.id === rankBy) || {}).category || 'this statement';
    const controls = h('div', { class: 'row' },
      h('select', { onchange: (e) => { resultsGroup = e.target.value; resultsDept = ''; renderRanking(); } }, ov.groups.map(g => h('option', { value: g.id, selected: g.id === resultsGroup }, g.name))),
      h('select', { onchange: (e) => { resultsDept = e.target.value; renderRanking(); } }, h('option', { value: '' }, 'All departments'), depts.map(d => h('option', { value: d, selected: d === resultsDept }, d))),
      h('select', { onchange: (e) => { rankBy = e.target.value; renderRanking(); } }, h('option', { value: 'overall', selected: rankBy === 'overall' }, 'Rank by: overall average'), ratingQs.map((q, i) => h('option', { value: q.id, selected: rankBy === q.id }, 'Rank by: ' + (q.category || 'Q' + (i + 1))))),
      h('select', { onchange: (e) => { rankMin = parseInt(e.target.value, 10); renderRanking(); } }, [1, 2, 3, 5, 8, 10].map(n => h('option', { value: n, selected: n === rankMin }, `At least ${n} evaluation${n > 1 ? 's' : ''}`))),
      h('button', { class: 'secondary', onclick: () => { delete resultsCache[resultsGroup]; renderRanking(); } }, 'Refresh'));
    let rank = 0, prev = null, shown = 0;
    const rows = ranked.map(p => {
      shown++; const sc = score(p); if (prev == null || Math.abs(sc - prev) > 1e-9) rank = shown; prev = sc;
      const medal = rank === 1 ? '\u{1F947}' : rank === 2 ? '\u{1F948}' : rank === 3 ? '\u{1F949}' : '';
      const ownSet = !p.questionSet || p.questionSet === r.group.id;
      return h('tr', { class: rank <= 3 ? 'top' : '' },
        h('td', { class: 'num' }, h('b', null, rank), medal ? ' ' + medal : ''),
        h('td', null, h('b', null, p.name), h('div', { class: 'small muted' }, [p.role, p.department].filter(Boolean).join(' · ')), ownSet ? null : h('div', { class: 'small muted' }, 'Evaluated with the statements of: ' + setName(p.questionSet))),
        h('td', { class: 'num' }, p.responses),
        h('td', { class: 'num' }, h('span', { class: scoreClass(sc) }, fmt(sc))),
        ratingQs.map(q => h('td', { class: 'num' + (q.id === rankBy ? ' rank-col' : '') }, p.ratings[q.id] ? h('span', { class: scoreClass(p.ratings[q.id].avg) }, fmt(p.ratings[q.id].avg)) : h('span', { class: 'muted' }, '–'))));
    });
    const table = h('table', null,
      h('thead', null, h('tr', null, h('th', { class: 'num' }, '#'), h('th', null, 'Person'), h('th', { class: 'num' }, 'Evaluations'), h('th', { class: 'num' }, rankBy === 'overall' ? 'Overall' : 'Score'), ratingQs.map((q, i) => h('th', { class: 'num' + (q.id === rankBy ? ' rank-col' : ''), title: q.text }, q.category || 'Q' + (i + 1))))),
      h('tbody', null, rows));
    setTab(
      h('div', { class: 'card' }, h('h2', null, r.group.name + ': ranking'), controls, h('div', { style: 'height:12px' }),
        h('p', { class: 'muted small' }, `People ranked by ${rankLabel} (1 to 5) in this survey. Only people with at least ${need} evaluations are ranked (change it above); the others are listed below until they get there. An average built on a few evaluations moves a lot with each new one, so read the score together with the number of evaluations. Equal scores share the same rank, and among equals the person with more evaluations is listed first.`),
        ranked.length ? h('div', { class: 'table-wrap' }, table) : h('p', { class: 'muted' }, 'Nobody has enough evaluations yet.')),
      pending.length ? h('div', { class: 'card' }, h('h2', null, `Not ranked yet (${pending.length})`),
        h('p', { class: 'muted small' }, `Fewer than ${need} evaluations received${rankBy === 'overall' ? '' : ', or no answer on this statement yet'}.`),
        h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, h('tr', null, h('th', null, 'Person'), h('th', { class: 'num' }, 'Evaluations'))),
          h('tbody', null, pending.map(p => h('tr', null, h('td', null, h('b', null, p.name), h('div', { class: 'small muted' }, [p.role, p.department].filter(Boolean).join(' · '))), h('td', { class: 'num' }, p.responses))))))) : null,
    );
  }

  // ---------- employees & links ----------
  function renderEmployees() {
    const groupName = id => (ov.groups.find(g => g.id === id) || {}).name || id;
    const groupShort = id => id === 'staff' ? 'Staff' : id === 'ops' ? 'Operations' : id;
    if (!isOwner()) {
      return setTab(h('div', { class: 'card' }, h('h2', null, `Employees (${ov.employees.length})`),
        h('div', { class: 'table-wrap' }, h('table', null,
          h('thead', null, h('tr', null, h('th', null, 'Name'), h('th', null, 'Department'), h('th', null, 'Surveys'), h('th', null, 'Emailed'))),
          h('tbody', null, ov.employees.map(e => h('tr', null,
            h('td', null, h('b', null, e.name), h('div', { class: 'small muted' }, [e.role, e.email].filter(Boolean).join(' · '))),
            h('td', null, e.department),
            h('td', null, e.groups.map(g => h('span', { class: 'pill todo', style: 'margin-right:4px', title: groupName(g) }, groupShort(g))), e.question_set ? h('div', { class: 'small muted' }, groupShort(e.question_set) + ' statements') : null),
            h('td', null, e.inviteSentAt ? h('span', { class: 'pill done' }, 'link sent') : h('span', { class: 'pill hidden' }, e.email ? 'not sent' : 'no email'), e.reportSentAt ? [' ', h('span', { class: 'pill released' }, 'report sent')] : null))))))));
    }
    const rows = ov.employees.map(e => h('tr', null,
      h('td', null, h('b', null, e.name), h('div', { class: 'small muted' }, [e.role, e.email].filter(Boolean).join(' · '))),
      h('td', null, e.department),
      h('td', null, e.groups.map(g => h('span', { class: 'pill todo', style: 'margin-right:4px', title: groupName(g) }, groupShort(g))), e.question_set ? h('div', { class: 'small muted', title: 'Evaluated with the statements of ' + groupName(e.question_set) + ' in every survey' }, groupShort(e.question_set) + ' statements') : null),
      h('td', null, h('span', { class: 'pill ' + (e.started ? 'done' : 'hidden') }, e.started ? `${e.evaluated} evaluated` : 'not yet')),
      h('td', null, e.inviteSentAt ? h('span', { class: 'pill done', title: 'Personal link emailed ' + fmtDate(e.inviteSentAt) }, 'link sent') : h('span', { class: 'pill hidden' }, e.email ? 'not sent' : 'no email'), e.reportSentAt ? [' ', h('span', { class: 'pill released', title: 'Report notice emailed ' + fmtDate(e.reportSentAt) }, 'report sent')] : null),
      h('td', null, h('code', null, e.code), ' ', h('button', { class: 'link small', onclick: () => { navigator.clipboard.writeText(`${ov.baseUrl}/s/${e.code.replace('-', '')}`); toast('Link copied'); } }, 'copy link')),
      h('td', null, h('div', { class: 'row', style: 'gap:6px' },
        e.email ? h('button', { class: 'secondary small', style: 'padding:4px 8px', title: 'Email the personal link to this person', onclick: async () => { if (!confirm(`Email the personal link to ${e.name} (${e.email})?`)) return; try { await api('POST', '/api/admin/mail/send', { kind: 'invite', filter: 'ids', ids: [e.id] }); toast('Sending to ' + e.email); setTimeout(async () => { await loadOverview(); if (tab === 'employees') render(); }, 2500); } catch (ex) { toast(ex.message, 'error'); } } }, 'Email link') : null,
        h('button', { class: 'secondary small', style: 'padding:4px 8px', onclick: () => editEmployee(e) }, 'Edit'),
        h('button', { class: 'secondary small', style: 'padding:4px 8px', onclick: async () => { if (!confirm(`Generate a new code for ${e.name}? The old link will stop working.`)) return; await api('POST', `/api/admin/employees/${e.id}/regenerate`); await loadOverview(); render(); } }, 'New code'),
        h('button', { class: 'danger small', style: 'padding:4px 8px', onclick: async () => { if (!confirm(`Remove ${e.name}?`)) return; await api('DELETE', `/api/admin/employees/${e.id}`); await loadOverview(); resultsCache = {}; render(); } }, 'Remove'),
      )),
    ));
    const csv = h('textarea', { placeholder: 'Paste rows copied from Excel or from the Microsoft 365 user list (with the header row), e.g.\nDisplay name\tFirst name\tLast name\tOffice Location\tJob Title\tDepartment\tProfessional Email address\nJane Doe\tJane\tDoe\tLahore\tLead Designer\tMarketing\tjdoe@example.com\n\nor the simple format: Name, Department, Role, Email, Survey', style: 'min-height:140px;font-family:ui-monospace,monospace;font-size:13px' });
    const replace = h('input', { type: 'checkbox' });
    setTab(
      h('div', { class: 'card' },
        h('h2', null, 'Sharing the survey'),
        h('p', null, 'Every employee has a personal access code. Send each person their own link (or the general link plus their code). The code identifies the person: each evaluation is saved with its author, visible to you only, never to other employees.'),
        h('p', null, 'General link: ', h('code', null, ov.baseUrl + '/'), ' · Personal link format: ', h('code', null, ov.baseUrl + '/s/CODE')),
        h('div', { class: 'actions' }, h('button', { class: 'accent', onclick: () => { tab = 'email'; render(); } }, 'Email the personal links to everyone'), h('a', { class: 'btn', href: '/api/admin/links.csv', style: 'text-decoration:none;background:#fff;color:#1a1a1a' }, 'Download all links (CSV)'), h('button', { class: 'secondary', onclick: () => editEmployee(null) }, 'Add one employee')),
      ),
      h('div', { class: 'card' }, h('h2', null, `Employees (${ov.employees.length})`), h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, h('th', null, 'Name'), h('th', null, 'Department'), h('th', null, 'Surveys'), h('th', null, 'Participation'), h('th', null, 'Emailed'), h('th', null, 'Code'), h('th', null, ''))),
        h('tbody', null, rows)))),
      h('div', { class: 'card' },
        h('h2', null, 'Import employees from a list'),
        h('p', { class: 'muted small' }, 'Paste a table with a header row, columns in any order. A directory export (Display name or First name + Last name, Job Title, Department, Email) is recognised automatically: people whose department is "Operators" go to the operations survey, everyone else (including "Operation") to the office staff and management survey. You can also use the simple format Name, Department, Role, Email, Survey where Survey is "staff", "ops" or "staff+ops". Extra columns such as Office Location are ignored. Afterwards you can edit anyone individually, for instance to put a manager in both surveys.'),
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
    const qset = h('select', null,
      h('option', { value: '', selected: !(e && e.question_set) }, 'The statements of the survey being taken (default)'),
      ov.groups.map(g => h('option', { value: g.id, selected: !!(e && e.question_set === g.id) }, 'Always the statements of: ' + g.name)));
    const err = h('div', { class: 'alert error', style: 'display:none' });
    const dialog = h('dialog', { style: 'border:none;border-radius:12px;padding:0;max-width:520px;width:95%' }, h('div', { class: 'card', style: 'margin:0' },
      h('h2', null, e ? 'Edit employee' : 'Add employee'),
      h('label', null, 'Name'), name, h('label', null, 'Department'), dept, h('datalist', { id: 'depts' }, [...new Set(ov.employees.map(x => x.department))].map(d => h('option', { value: d }))),
      h('label', null, 'Role (optional)'), role, h('label', null, 'Email (optional, for sending the link)'), email,
      h('label', null, 'Surveys'), checks.map(({ g, c }) => h('label', { style: 'font-weight:400;margin:4px 0' }, c, ' ', g.name)),
      h('label', null, 'Statements used when this person is evaluated'), qset,
      h('p', { class: 'muted small' }, 'For someone who is not an operator but is evaluated in the operations survey (a manager, a technician), choose the office staff statements so operators rate them on the same things as everyone else.'),
      err,
      h('div', { class: 'actions' }, h('button', { onclick: async () => {
        const body = { name: name.value, department: dept.value, role: role.value, email: email.value, groups: checks.filter(x => x.c.checked).map(x => x.g.id), question_set: qset.value };
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
      const status = h('select', null,
        h('option', { value: 'open', selected: g.status === 'open' }, 'Open (employees can submit)'),
        h('option', { value: 'closed', selected: g.status === 'closed' }, 'Closed (no more submissions, reports not shared yet)'),
        h('option', { value: 'released', selected: g.status === 'released' }, 'Closed and reports released (each employee can see their own report)'));
      const list = h('div');
      const qs = g.questions.map(q => ({ ...q }));
      const draw = () => list.replaceChildren(...qs.map((q, i) => h('div', { class: 'qrow' },
        h('span', { class: 'muted small', style: 'width:22px' }, i + 1),
        h('input', { type: 'text', class: 'cat', placeholder: 'Category (e.g. Reliability and follow-up)', value: q.category || '', oninput: (e) => { q.category = e.target.value; } }),
        h('input', { type: 'text', class: 'txt', placeholder: 'Statement', value: q.text, oninput: (e) => { q.text = e.target.value; } }),
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
        h('p', { class: 'muted small' }, 'Rating statements are answered on a 1 to 5 scale or N/A. The category is shown as a section title on the form and as the row label in reports. Changing wording keeps existing answers; deleting a statement deletes its answers from the results. Keep it short: 5 statements and 1 comment is the sweet spot for participation.'),
        list,
        h('div', { class: 'actions' }, h('button', { class: 'secondary', onclick: () => { qs.push({ text: '', type: 'rating', category: '' }); draw(); } }, 'Add question'),
          h('button', { class: 'secondary', onclick: async () => { if (!confirm('Replace the current questions with the default 5 statements and comment? Answers to removed questions are dropped from the results.')) return; try { await api('POST', `/api/admin/groups/${g.id}/questions/restore`); toast('Default questions restored'); await loadOverview(); resultsCache = {}; render(); } catch (ex) { toast(ex.message, 'error'); } } }, 'Restore default questions'),
          h('button', { onclick: async () => { try { await api('PUT', `/api/admin/groups/${g.id}/questions`, { questions: qs }); toast('Questions saved'); await loadOverview(); resultsCache = {}; render(); } catch (ex) { toast(ex.message, 'error'); } } }, 'Save questions')),
      );
    }));
  }

  // ---------- individual reports ----------
  async function renderReports() {
    if (!resultsGroup) return setTab(h('div', { class: 'card' }, 'No surveys configured.'));
    const g = ov.groups.find(x => x.id === resultsGroup);
    const r = resultsCache[resultsGroup] || (resultsCache[resultsGroup] = await api('GET', '/api/admin/results/' + resultsGroup));
    const people = r.people.filter(p => !resultsDept || p.department === resultsDept);
    const depts = [...new Set(r.people.map(p => p.department))].sort();
    const emp = id => ov.employees.find(e => e.id === id) || {};
    const ready = r.people.filter(p => p.visible).length;
    const setStatus = async (status) => { try { await api('PUT', `/api/admin/groups/${g.id}`, { status }); toast('Survey updated'); await loadOverview(); resultsCache = {}; render(); } catch (ex) { toast(ex.message, 'error'); } };
    const statusCard = h('div', { class: 'card' },
      h('h2', null, isOwner() ? 'Sending reports to employees' : 'Personal reports'),
      h('p', null, 'Each employee gets a personal report: their average per category next to the department and company averages, a "point fort", a priority to work on, and the constructive comments received. A report exists only for people with at least ', h('b', null, r.minResponses), ' evaluations.'),
      h('p', null, 'Current status of this survey: ', h('span', { class: 'pill ' + (g.status === 'released' ? 'released' : g.status === 'closed' ? 'closed' : 'todo') }, g.status), ' · ', h('b', null, ready), ` of ${r.people.length} people have enough evaluations for a report.`),
      !isOwner() ? null : h('ol', { class: 'small' },
        h('li', null, 'When the evaluation period is over, close the survey (nobody can submit anymore). Review the comments below before releasing: they are shown to the person as written.'),
        h('li', null, h('b', null, 'Release the reports.'), ' Each employee then sees their own report (and nobody else’s) when they open their personal link, the same link they used to fill out the survey.'),
        h('li', null, 'Tell everyone the reports are available: the "Email" tab sends the notice to everyone who has a report. Or print the reports to PDF below and email them one by one.')),
      h('div', { class: 'actions' },
        isOwner() && g.status === 'open' ? h('button', { class: 'secondary', onclick: () => { if (confirm('Close the survey? Employees will no longer be able to submit.')) setStatus('closed'); } }, 'Close the survey') : null,
        !isOwner() ? null : g.status !== 'released' ? h('button', { class: 'accent', onclick: () => { if (confirm('Release the reports? Every employee with enough evaluations will be able to see their own report on their personal link.')) setStatus('released'); } }, 'Release reports to employees') : h('button', { class: 'secondary', onclick: () => setStatus('closed') }, 'Hide reports again'),
        isOwner() && g.status === 'released' ? h('button', { onclick: () => { tab = 'email'; render(); } }, 'Email employees that their report is ready') : null,
        h('a', { class: 'btn', href: `/admin/reports?group=${g.id}`, target: '_blank', style: 'text-decoration:none' }, 'Open all reports (print / PDF)'),
        isOwner() ? h('a', { class: 'btn', href: '/api/admin/links.csv', style: 'text-decoration:none;background:#fff;color:#1a1a1a' }, 'Download links CSV') : null));
    const controls = h('div', { class: 'row' },
      h('select', { onchange: (e) => { resultsGroup = e.target.value; resultsDept = ''; renderReports(); } }, ov.groups.map(x => h('option', { value: x.id, selected: x.id === resultsGroup }, x.name))),
      h('select', { onchange: (e) => { resultsDept = e.target.value; renderReports(); } }, h('option', { value: '' }, 'All departments'), depts.map(d => h('option', { value: d, selected: d === resultsDept }, d))));
    const table = h('table', null,
      h('thead', null, h('tr', null, h('th', null, 'Person'), h('th', null, 'Email'), h('th', { class: 'num' }, 'Evaluations'), h('th', null, 'Report'), h('th', null, ''))),
      h('tbody', null, people.map(p => h('tr', null,
        h('td', null, h('b', null, p.name), h('div', { class: 'small muted' }, [p.role, p.department].filter(Boolean).join(' · '))),
        h('td', { class: 'small' }, emp(p.id).email || h('span', { class: 'muted' }, 'no email')),
        h('td', { class: 'num' }, p.responses),
        h('td', null, p.visible ? h('span', { class: 'pill done' }, 'ready') : h('span', { class: 'pill hidden' }, `needs ${r.minResponses}`)),
        h('td', null, p.visible ? h('a', { href: `/admin/reports?group=${g.id}&employee=${p.id}`, target: '_blank' }, 'Preview') : '')))));
    setTab(statusCard, h('div', { class: 'card' }, h('h2', null, 'Reports'), controls, h('div', { style: 'height:10px' }), h('div', { class: 'table-wrap' }, table)));
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
    const passwordCard = h('div', { class: 'card' }, h('h2', null, isOwner() ? 'Change admin password' : 'Change password'),
      h('label', null, 'Current password'), cur, h('label', null, 'New password (at least 8 characters)'), nw,
      h('div', { class: 'actions' }, h('button', { onclick: async () => { try { await api('POST', '/api/admin/password', { current: cur.value, password: nw.value }); toast('Password changed'); cur.value = nw.value = ''; } catch (ex) { toast(ex.message, 'error'); } } }, 'Change password')));
    if (!isOwner()) return setTab(passwordCard);
    setTab(
      h('div', { class: 'card' }, h('h2', null, 'Settings'),
        h('label', null, 'Organization name'), org,
        h('label', null, 'Minimum evaluations before a person\'s results are shown'), min,
        h('p', { class: 'muted small' }, 'This protects evaluators from their colleagues. With a minimum of 3, no employee can work out who wrote a comment in their report by elimination. Lowering it to 1 means a person who was evaluated once could guess their evaluator. You always see every evaluation with its author, whatever the minimum.'),
        h('div', { class: 'actions' }, h('button', { onclick: async () => { try { await api('PUT', '/api/admin/settings', { minResponses: min.value, orgName: org.value }); toast('Saved'); await loadOverview(); resultsCache = {}; } catch (ex) { toast(ex.message, 'error'); } } }, 'Save settings'))),
      passwordCard,
      managersCard(),
      h('div', { class: 'card' }, h('h2', null, 'Sample data (for trying the app)'),
        h('p', { class: 'muted small' }, 'Load a fictional roster and randomly generated evaluations to see how the results look. Replace them with your real employee list when you are ready.'),
        h('div', { class: 'actions' }, demoBtn('Load sample employees and demo responses', 'all'), demoBtn('Load sample employees only (no responses)', 'employees'), demoBtn('Regenerate demo responses for current employees', 'responses'))),
      h('div', { class: 'card' }, h('h2', null, 'Reset'),
        h('div', { class: 'actions' }, resetBtn('Delete all responses (keep employees)', 'responses'), resetBtn('Delete everything (employees and responses)', 'all'))),
      h('div', { class: 'card' }, h('h2', null, 'Maintenance'),
        h('p', { class: 'muted small' }, 'After updating the code on the server (git pull), restart the app to load it. The service comes back by itself within a few seconds.'),
        h('div', { class: 'actions' }, h('button', { class: 'secondary', onclick: async () => { if (!confirm('Restart the app now? It will be unavailable for a few seconds.')) return; try { await api('POST', '/api/admin/restart'); toast('Restarting... reload this page in a few seconds'); } catch (ex) { toast(ex.message, 'error'); } } }, 'Restart the app'))),
      h('div', { class: 'card' }, h('h2', null, 'Who sees what'),
        h('ul', { class: 'small' },
          h('li', null, 'Answers are confidential: never shared with other employees, visible to you, the owner/administrator.'),
          h('li', null, 'Each evaluation is stored with the survey, the colleague being evaluated, the answers and the author. You see it in the Results tab (row detail, "By evaluator" and the evaluations CSV).'),
          h('li', null, 'Evaluations submitted before names were recorded (before 13 November 2026) have no author and can never be attributed.'),
          h('li', null, 'Restricted admin accounts (above) see averages, reports and the employee list only: never who evaluated whom, never individual evaluations or personal links, and they cannot change anything.'),
          h('li', null, 'Employees only ever receive averages and comments in random order, and only once the minimum number of evaluations is reached. A personal report never shows who evaluated them.'))),
    );
  }

  // Owner: restricted admin accounts (averages only).
  function managersCard() {
    const list = h('div', null, h('p', { class: 'muted small' }, 'Loading...'));
    const user = h('input', { type: 'text', autocomplete: 'off', placeholder: 'e.g. jonathan' });
    const pass = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'at least 8 characters' });
    const load = async () => {
      try {
        const r = await api('GET', '/api/admin/managers');
        list.replaceChildren(r.managers.length ? h('table', null, h('tbody', null, r.managers.map(m => h('tr', null, h('td', null, h('b', null, m.username), m.pending ? [' ', h('span', { class: 'pill closed', title: 'No password yet: the setup link has not been used' }, 'link not used yet')] : null, m.linkExpires ? h('div', { class: 'small muted' }, 'Setup link valid until ' + fmtDate(m.linkExpires)) : null),
          h('td', { style: 'text-align:right' }, h('button', { class: 'secondary small', style: 'padding:4px 8px', title: 'Issue a new one-time link on which this person chooses a password', onclick: () => issueLink(m.username) }, 'New link'), ' ',
            h('button', { class: 'secondary small', style: 'padding:4px 8px', onclick: () => { user.value = m.username; pass.value = ''; pass.focus(); toast('Enter a new password and click Save to reset it'); } }, 'Set password'), ' ',
            h('button', { class: 'danger small', style: 'padding:4px 8px', onclick: async () => { if (!confirm(`Remove the account ${m.username}? They will be logged out at once.`)) return; try { await api('DELETE', '/api/admin/managers/' + encodeURIComponent(m.username)); toast('Account removed'); load(); } catch (ex) { toast(ex.message, 'error'); } } }, 'Remove'))))))
          : h('p', { class: 'muted small' }, 'No restricted account yet.'));
      } catch (ex) { list.replaceChildren(h('p', { class: 'alert error' }, ex.message)); }
    };
    const linkBox = h('div', { style: 'display:none' });
    const showLink = (username, r) => {
      const inp = h('input', { type: 'text', readonly: true, value: r.setupLink, onclick: e => e.target.select() });
      linkBox.style.display = '';
      linkBox.replaceChildren(h('div', { class: 'alert info' }, h('b', null, 'Setup link for ' + username), ' (valid until ' + fmtDate(r.setupExpires) + ', one use). Send it to them: they open it, choose their password and land in the results.',
        h('div', { class: 'row', style: 'margin-top:8px' }, inp, h('button', { class: 'secondary', onclick: () => { navigator.clipboard.writeText(r.setupLink); toast('Link copied'); } }, 'Copy'))));
    };
    const issueLink = async (username) => {
      try { const r = await api('POST', '/api/admin/managers', { username }); showLink(username, r); toast(r.replaced ? 'New link issued' : 'Account created'); load(); }
      catch (ex) { toast(ex.message, 'error'); }
    };
    load();
    return h('div', { class: 'card' }, h('h2', null, 'Restricted admin accounts (averages only)'),
      h('p', { class: 'muted small' }, 'These accounts log in on this same page and see the Results (averages by department and by person), the individual reports and the employee list. They never see who evaluated whom, the individual evaluations, the personal links or the notification bell, and they cannot change anything. Each person can change their own password.'),
      list, linkBox,
      h('div', { class: 'row' }, h('div', { style: 'flex:1' }, h('label', null, 'Username'), user), h('div', { style: 'flex:1' }, h('label', null, 'Password (leave empty to send a setup link instead)'), pass)),
      h('div', { class: 'actions' }, h('button', { onclick: async () => {
        if (!pass.value) return issueLink(user.value.trim());
        try { const r = await api('POST', '/api/admin/managers', { username: user.value, password: pass.value }); toast(r.replaced ? 'Password set' : 'Account created'); user.value = pass.value = ''; load(); } catch (ex) { toast(ex.message, 'error'); }
      } }, 'Save account'), h('button', { class: 'secondary', title: 'Creates the account and gives you a one-time link on which the person chooses their own password', onclick: () => issueLink(user.value.trim()) }, 'Create with a setup link')));
  }

  // ---------- email ----------
  function stopMailPoll() { if (mailPoll) { clearInterval(mailPoll); mailPoll = null; } }
  function fmtDate(iso) { return iso ? new Date(iso).toLocaleString() : ''; }
  function drawJob(el, j) {
    if (!j || !j.startedAt) return el.replaceChildren();
    const done = j.sent + j.failed.length;
    const pct = j.total ? Math.round(done / j.total * 100) : 0;
    el.replaceChildren(
      h('h3', null, j.running ? `Sending... ${done} of ${j.total}` : 'Last mailing'),
      h('p', { class: 'small' }, `${j.kind === 'invite' ? 'Personal links' : 'Report notices'} · started ${fmtDate(j.startedAt)}${j.finishedAt ? ', finished ' + fmtDate(j.finishedAt) : ''} · `,
        h('b', null, `${j.sent} sent`), j.failed.length ? [', ', h('b', { style: 'color:var(--bad)' }, `${j.failed.length} failed`)] : null, ` of ${j.total}`),
      h('div', { class: 'progress' }, h('div', { style: `width:${pct}%` })),
      j.failed.length ? h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, h('th', null, 'Person'), h('th', null, 'Email'), h('th', null, 'Error'))),
        h('tbody', null, j.failed.map(f => h('tr', null, h('td', null, f.name), h('td', { class: 'small' }, f.email), h('td', { class: 'small' }, f.error)))))) : null);
  }
  function watchJob(el) {
    stopMailPoll();
    const tick = async () => {
      if (tab !== 'email' || !document.body.contains(el)) return stopMailPoll();
      try {
        const j = await api('GET', '/api/admin/mail/status');
        drawJob(el, j);
        if (!j.running) { stopMailPoll(); await loadOverview(); renderEmail(); }
      } catch { stopMailPoll(); }
    };
    mailPoll = setInterval(tick, 1500);
    tick();
  }
  async function renderEmail() {
    stopMailPoll();
    const m = await api('GET', '/api/admin/mail');
    const s = m.settings, c = m.counts;
    const field = (label, input, help) => [h('label', null, label), input, help ? h('p', { class: 'muted small', style: 'margin:2px 0 8px' }, help) : null];
    const progress = h('div');

    // --- sending ---
    const inviteFilter = h('select', null,
      h('option', { value: 'unsent' }, `People not emailed yet (${c.invite.unsent})`),
      h('option', { value: 'all' }, `Everyone with an email address (${c.invite.all})`),
      h('option', { value: 'notstarted' }, `Reminder: people who have not started (${c.invite.notstarted})`));
    const reportFilter = h('select', null,
      h('option', { value: 'unsent' }, `People not notified yet (${c.report.unsent})`),
      h('option', { value: 'all' }, `Everyone who has a report (${c.report.all})`));
    const startSend = async (kind, filter) => {
      const n = c[kind][filter];
      if (!n) return toast('Nobody to send to with this selection.', 'error');
      if (!confirm(`Send the ${kind === 'invite' ? 'personal link' : 'report notice'} email to ${n} ${n > 1 ? 'people' : 'person'} now?`)) return;
      try { await api('POST', '/api/admin/mail/send', { kind, filter }); watchJob(progress); } catch (ex) { alert(ex.message); }
    };
    const sendCard = h('div', { class: 'card' }, h('h2', null, 'Send emails to employees'),
      h('p', { class: 'muted small' }, `${m.withEmail} of ${m.employees} employees have an email address (edit them in "Employees & links"). Emails go out one by one; you can follow the progress here, and sending continues even if you leave this page. The "Emailed" column in "Employees & links" shows who received what.`),
      !s.configured ? h('div', { class: 'alert error' }, 'Fill in the mail server settings below first, then send yourself a test email.') : null,
      h('h3', null, '1. Personal links (survey invitation)'),
      h('div', { class: 'row' }, inviteFilter, h('button', { disabled: !s.configured, onclick: () => startSend('invite', inviteFilter.value) }, 'Send personal links')),
      h('h3', null, '2. Report notices (after releasing the reports)'),
      c.report.blocked ? h('p', { class: 'muted small' }, c.report.blocked) : h('p', { class: 'muted small' }, 'Only people who have a report (enough evaluations, survey released) are emailed.'),
      h('div', { class: 'row' }, reportFilter, h('button', { disabled: !s.configured || !!c.report.blocked, onclick: () => startSend('report', reportFilter.value) }, 'Send report notices')),
      progress);

    // --- mail server ---
    const dis = s.envLocked;
    const host = h('input', { type: 'text', value: s.host, placeholder: 'mail.example.com', disabled: dis });
    const port = h('input', { type: 'number', min: 1, max: 65535, value: s.port, disabled: dis });
    const sec = h('select', { disabled: dis }, [['tls', 'SSL/TLS (usually port 465)'], ['starttls', 'STARTTLS (usually port 587)'], ['none', 'None (port 25, trusted local server only)']].map(([v, l]) => h('option', { value: v, selected: s.security === v }, l)));
    const user = h('input', { type: 'text', value: s.user, autocomplete: 'off', disabled: dis });
    const pass = h('input', { type: 'password', autocomplete: 'new-password', placeholder: s.hasPassword ? 'saved — leave empty to keep' : '', disabled: dis });
    const from = h('input', { type: 'email', value: s.from, placeholder: 'survey@example.com', disabled: dis });
    const fromName = h('input', { type: 'text', value: s.fromName, disabled: dis });
    const replyTo = h('input', { type: 'email', value: s.replyTo, placeholder: 'hr@example.com', disabled: dis });
    const verify = h('input', { type: 'checkbox', checked: s.verifyTls, disabled: dis });
    const testTo = h('input', { type: 'email', placeholder: 'your@email.com' });
    const settingsCard = h('div', { class: 'card' }, h('h2', null, 'Mail server (SMTP)'),
      dis ? h('div', { class: 'alert info' }, 'These settings come from the SMTP_* environment variables of the server and cannot be edited here.') : null,
      h('p', { class: 'muted small' }, 'Any SMTP mailbox works: one on your web host (cPanel), Microsoft 365, Google Workspace... Use a From address on a domain whose SPF and DKIM records allow this server to send, otherwise the messages land in spam.'),
      h('div', { class: 'row' }, h('div', null, ...field('Server (host name)', host)), h('div', null, ...field('Port', port)), h('div', null, ...field('Security', sec))),
      h('div', { class: 'row' }, h('div', null, ...field('Username', user)), h('div', null, ...field('Password', pass))),
      h('div', { class: 'row' }, h('div', null, ...field('From address', from)), h('div', null, ...field('From name', fromName)), h('div', null, ...field('Reply-To (optional)', replyTo, 'Where replies and questions go, e.g. HR.'))),
      h('label', { class: 'small', style: 'font-weight:400' }, verify, ' Verify the server certificate (untick only if the host name does not match its certificate)'),
      h('div', { class: 'actions' },
        dis ? null : h('button', { onclick: async () => { try { await api('PUT', '/api/admin/mail/settings', { host: host.value, port: port.value, security: sec.value, user: user.value, password: pass.value, from: from.value, fromName: fromName.value, replyTo: replyTo.value, verifyTls: verify.checked }); toast('Mail settings saved'); renderEmail(); } catch (ex) { toast(ex.message, 'error'); } } }, 'Save mail settings'),
        h('div', { class: 'row', style: 'flex:1 1 320px' }, testTo, h('button', { class: 'secondary', onclick: async (ev) => { const b = ev.currentTarget; b.disabled = true; try { await api('POST', '/api/admin/mail/test', { to: testTo.value }); toast('Test email sent to ' + testTo.value); } catch (ex) { alert('Sending failed:\n' + ex.message); } b.disabled = false; } }, 'Send a test email'))));

    // --- templates ---
    const tplCards = ['invite', 'report'].map(kind => {
      const t = m.templates[kind];
      const subj = h('input', { type: 'text', value: t.subject });
      const body = h('textarea', { style: 'min-height:230px;font-family:inherit' }, t.body);
      return h('div', { class: 'card' },
        h('h2', null, kind === 'invite' ? 'Email 1: personal link (survey invitation)' : 'Email 2: report available'),
        h('p', { class: 'muted small' }, 'Placeholders: ', m.placeholders.map(x => h('code', { style: 'margin-right:6px' }, x)), ' · {first_name} is the first word of the name · {link} is required · {signature} is the sender’s signature (plain text here, a styled block in the HTML email). Employees receive a Sirix-style HTML email built from this text (the line with {link} becomes a button, the line with {code} a highlighted box, lines starting with "- " a list), plus a plain-text copy.'),
        ...field('Subject', subj), ...field('Message (plain text)', body),
        h('div', { class: 'actions' },
          h('button', { onclick: async () => { try { await api('PUT', '/api/admin/mail/templates', { [kind]: { subject: subj.value, body: body.value } }); toast('Template saved'); } catch (ex) { toast(ex.message, 'error'); } } }, 'Save template'),
          h('a', { class: 'btn', href: `/api/admin/mail/preview/${kind}`, target: '_blank', style: 'text-decoration:none;background:#fff;color:#1a1a1a', title: 'Shows the saved template as a Sirix-style HTML email' }, 'Preview the email'),
          h('button', { class: 'secondary', onclick: () => { subj.value = m.defaults[kind].subject; body.value = m.defaults[kind].body; } }, 'Reset to the default text')));
    });

    setTab(sendCard, settingsCard, ...tplCards);
    drawJob(progress, m.job);
    if (m.job.running) watchJob(progress);
  }

  // ---------- boot ----------
  (async () => {
    const setupToken = new URLSearchParams(location.search).get('setup');
    if (setupToken) return renderSetup(setupToken);
    try { await loadOverview(); render(); } catch { renderLogin(); }
  })();
})();
