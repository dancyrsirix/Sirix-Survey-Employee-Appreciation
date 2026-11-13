'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'survey-test-'));
process.env.DATA_DIR = tmp;
process.env.PORT = '0';
process.env.MAIL_PAUSE_MS = '0';
delete process.env.SMTP_HOST;
delete process.env.ADMIN_PASSWORD;

const { server } = require('../server');
const db = require('../lib/db');
const seed = require('../lib/seed');
const mail = require('../lib/mail');

let base, cookie = '';
const http = async (method, p, body, opts = {}) => {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', Cookie: opts.cookie ?? cookie }, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  return { status: r.status, json, text, headers: r.headers };
};

before(async () => {
  await new Promise(res => server.listen(0, '127.0.0.1', res));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); db.db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('admin endpoints require login', async () => {
  const r = await http('GET', '/api/admin/overview');
  assert.equal(r.status, 401);
});

test('first run: admin account is created once, then login works and wrong password is rejected', async () => {
  let r = await http('GET', '/api/admin/status');
  assert.equal(r.json.configured, false);
  r = await http('POST', '/api/admin/setup', { username: 'admin', password: 'short' });
  assert.equal(r.status, 400);
  r = await http('POST', '/api/admin/setup', { username: 'admin', password: 'test-pass-123' });
  assert.equal(r.status, 200);
  r = await http('POST', '/api/admin/setup', { username: 'admin', password: 'another-pass' });
  assert.equal(r.status, 400);
  assert.equal((await http('GET', '/api/admin/status')).json.configured, true);
  assert.doesNotMatch(db.getSetting('admin_password_hash'), /test-pass-123/);
  r = await http('POST', '/api/admin/login', { username: 'admin', password: 'nope' });
  assert.equal(r.status, 401);
  r = await http('POST', '/api/admin/login', { username: 'admin', password: 'test-pass-123' });
  assert.equal(r.status, 200);
  cookie = r.headers.get('set-cookie').split(';')[0];
  r = await http('GET', '/api/admin/overview');
  assert.equal(r.status, 200);
  assert.equal(r.json.groups.length, 2);
  // change password
  r = await http('POST', '/api/admin/password', { current: 'wrong', password: 'new-pass-123' });
  assert.equal(r.status, 400);
  r = await http('POST', '/api/admin/password', { current: 'test-pass-123', password: 'new-pass-123' });
  assert.equal(r.status, 200);
  assert.equal((await http('POST', '/api/admin/login', { username: 'admin', password: 'new-pass-123' })).status, 200);
});

test('sample employees load, with Yannick in both surveys', async () => {
  const r = await http('POST', '/api/admin/demo', { what: 'employees' });
  assert.equal(r.status, 200);
  const ov = (await http('GET', '/api/admin/overview')).json;
  assert.equal(ov.employees.length, seed.SAMPLE_EMPLOYEES.length);
  const y = ov.employees.find(e => e.name === 'Yannick');
  assert.deepEqual([...y.groups].sort(), ['ops', 'staff']);
  for (const e of ov.employees) assert.match(e.code, /^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
});

test('an employee sees only colleagues from their own survey, never themselves', async () => {
  const emps = db.listEmployees();
  const op = emps.find(e => e.role === 'Operator');
  const r = await http('GET', `/api/survey/${op.code}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.groups.length, 1);
  assert.equal(r.json.groups[0].id, 'ops');
  const ids = r.json.groups[0].targets.map(t => t.id);
  assert.ok(!ids.includes(op.id));
  assert.ok(ids.includes(emps.find(e => e.name === 'Yannick').id));
  assert.ok(!ids.includes(emps.find(e => e.role === 'President').id));
  // code with dashes and lowercase also works
  const r2 = await http('GET', `/api/survey/${db.formatCode(op.code).toLowerCase()}`);
  assert.equal(r2.status, 200);
  const bad = await http('GET', '/api/survey/NOPE-NOPE');
  assert.equal(bad.status, 404);
});

test('submit once per colleague, partial answers allowed, empty rejected, self rejected', async () => {
  const emps = db.listEmployees();
  const alice = emps.find(e => e.role === 'HR Manager');
  const bob = emps.find(e => e.role === 'IT Manager');
  const qs = db.listQuestions('staff');
  const rating = qs.find(q => q.type === 'rating'), text = qs.find(q => q.type === 'text');

  let r = await http('POST', `/api/survey/${alice.code}/submit`, { group_id: 'staff', target_id: bob.id, answers: {} });
  assert.equal(r.status, 400);
  r = await http('POST', `/api/survey/${alice.code}/submit`, { group_id: 'staff', target_id: alice.id, answers: { [rating.id]: 5 } });
  assert.equal(r.status, 400);
  r = await http('POST', `/api/survey/${alice.code}/submit`, { group_id: 'staff', target_id: bob.id, answers: { [rating.id]: 4, [text.id]: 'Great colleague', bogus: 'x' } });
  assert.equal(r.status, 200, r.text);
  r = await http('POST', `/api/survey/${alice.code}/submit`, { group_id: 'staff', target_id: bob.id, answers: { [rating.id]: 1 } });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /already/);
  const sv = (await http('GET', `/api/survey/${alice.code}`)).json;
  assert.equal(sv.groups[0].targets.find(t => t.id === bob.id).done, true);
  // operator cannot submit into the staff survey
  const op = emps.find(e => e.role === 'Operator');
  r = await http('POST', `/api/survey/${op.code}/submit`, { group_id: 'staff', target_id: bob.id, answers: { [rating.id]: 4 } });
  assert.equal(r.status, 400);
});

test('each evaluation is stored with its author, shown to the admin only', async () => {
  const emps = db.listEmployees();
  const alice = emps.find(e => e.role === 'HR Manager');
  const bob = emps.find(e => e.role === 'IT Manager');
  const row = db.db.prepare('SELECT * FROM responses').get();
  assert.match(row.id, /^[0-9a-f-]{36}$/);
  assert.equal(row.evaluator_id, alice.id);
  // admin results: per-person evaluations with the author, and the by-evaluator summary
  const r = (await http('GET', '/api/admin/results/staff')).json;
  const p = r.people.find(x => x.id === bob.id);
  assert.equal(p.visible, false);
  assert.equal(p.evaluations.length, 1);
  assert.equal(p.evaluations[0].evaluator, alice.name);
  assert.deepEqual(Object.values(p.evaluations[0].comments), ['Great colleague']);
  assert.deepEqual(r.evaluators.map(e => [e.name, e.targets.map(t => t.name)]), [[alice.name, [bob.name]]]);
  assert.equal(r.unattributed, 0);
  // an evaluation from before authors were recorded stays unattributed
  const qs = db.listQuestions('staff');
  const carol = emps.find(e => e.groups.includes('staff') && e.id !== alice.id && e.id !== bob.id);
  db.db.prepare('INSERT INTO responses (id, group_id, target_id) VALUES (?, ?, ?)').run('legacy-1', 'staff', carol.id);
  db.db.prepare('INSERT INTO answers (response_id, question_id, rating, text) VALUES (?, ?, 3, NULL)').run('legacy-1', qs.find(q => q.type === 'rating').id);
  const r2 = (await http('GET', '/api/admin/results/staff')).json;
  const pc = r2.people.find(x => x.id === carol.id);
  assert.equal(pc.evaluations.length, 1);
  assert.equal(pc.evaluations[0].evaluator, null);
  assert.equal(r2.unattributed, 1);
  // deducing the author of an earlier evaluation by elimination, only for people who agreed to be named
  const [dave, erin] = emps.filter(e => e.groups.includes('staff') && ![alice.id, bob.id, carol.id].includes(e.id));
  db.db.prepare('INSERT INTO completions (evaluator_id, target_id, group_id) VALUES (?, ?, ?)').run(dave.id, carol.id, 'staff');
  let pc2 = (await http('GET', '/api/admin/results/staff')).json.people.find(x => x.id === carol.id).evaluations[0];
  assert.equal(pc2.attribution, 'anonymous');
  assert.equal(pc2.evaluator, null);
  assert.equal((await http('PUT', `/api/admin/employees/${dave.id}`, { names_consent: true })).status, 200);
  assert.equal(db.getEmployee(dave.id).names_consent, 1);
  const r3 = (await http('GET', '/api/admin/results/staff')).json;
  pc2 = r3.people.find(x => x.id === carol.id).evaluations[0];
  assert.equal(pc2.attribution, 'deduced');
  assert.equal(pc2.evaluator, dave.name);
  assert.equal(r3.evaluators.find(e => e.name === dave.name).targets[0].attribution, 'deduced');
  assert.equal(r3.unattributed, 0);
  db.db.prepare('INSERT INTO completions (evaluator_id, target_id, group_id) VALUES (?, ?, ?)').run(erin.id, carol.id, 'staff');
  pc2 = (await http('GET', '/api/admin/results/staff')).json.people.find(x => x.id === carol.id).evaluations[0];
  assert.equal(pc2.attribution, 'anonymous', 'a possible author who did not agree keeps it anonymous');
  await http('PUT', `/api/admin/employees/${erin.id}`, { names_consent: true });
  pc2 = (await http('GET', '/api/admin/results/staff')).json.people.find(x => x.id === carol.id).evaluations[0];
  assert.equal(pc2.attribution, 'possible');
  assert.deepEqual(pc2.candidates, [dave.name, erin.name].sort());
  assert.equal(pc2.evaluator, null);
  const evCsv = (await http('GET', '/api/admin/evaluations/staff.csv')).text;
  assert.match(evCsv, new RegExp(`One of: .*,possible,"?${carol.name}`));
  await http('PUT', `/api/admin/employees/${dave.id}`, { names_consent: false });
  await http('PUT', `/api/admin/employees/${erin.id}`, { names_consent: false });
  db.db.prepare('DELETE FROM completions WHERE target_id = ? AND evaluator_id IN (?, ?)').run(carol.id, dave.id, erin.id);
  // the employee-facing report never carries attribution either
  assert.equal(JSON.stringify(db.reportFor('staff', carol.id)).includes(dave.name), false);
  // activity feed for the admin's notification bell: newest first, timestamped rows only
  const act = (await http('GET', '/api/admin/activity')).json;
  assert.equal(act.items.length, 1);
  assert.equal(act.items[0].evaluator, alice.name);
  assert.equal(act.items[0].target, bob.name);
  assert.equal(act.items[0].groupId, 'staff');
  assert.match(act.items[0].at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(act.newSince, 1);
  assert.equal((await http('GET', '/api/admin/activity?since=' + encodeURIComponent(act.now))).json.newSince, 0);
  assert.equal((await http('GET', '/api/admin/activity?since=2000-01-01T00:00:00.000Z')).json.newSince, 1);
  // CSV with one line per evaluation
  const csv = await http('GET', '/api/admin/evaluations/staff.csv');
  assert.equal(csv.status, 200);
  assert.match(csv.text, new RegExp(`^"?${alice.name}"?,recorded,"?${bob.name}"?,`, 'm'));
  assert.match(csv.text, /Anonymous \(before names were recorded\)/);
  // the employee-facing report never carries the per-evaluation detail
  const rep = db.reportFor('staff', bob.id);
  assert.equal(rep.person.evaluations, undefined);
  assert.equal(JSON.stringify(rep).includes(alice.name), false);
  db.db.prepare("DELETE FROM answers WHERE response_id = 'legacy-1'").run();
  db.db.prepare("DELETE FROM responses WHERE id = 'legacy-1'").run();
});

test('results hide people under the minimum and show them above it', async () => {
  const emps = db.listEmployees();
  const bob = emps.find(e => e.role === 'IT Manager');
  let r = (await http('GET', '/api/admin/results/staff')).json;
  let p = r.people.find(x => x.id === bob.id);
  assert.equal(p.responses, 1);
  assert.equal(p.visible, false);
  assert.deepEqual(p.comments, {});
  // two more evaluations of Bob
  const qs = db.listQuestions('staff');
  const rating = qs.find(q => q.type === 'rating');
  const others = emps.filter(e => e.groups.includes('staff') && e.id !== bob.id && e.role !== 'HR Manager').slice(0, 2);
  for (const o of others) assert.equal((await http('POST', `/api/survey/${o.code}/submit`, { group_id: 'staff', target_id: bob.id, answers: { [rating.id]: 2 } })).status, 200);
  r = (await http('GET', '/api/admin/results/staff')).json;
  p = r.people.find(x => x.id === bob.id);
  assert.equal(p.visible, true);
  assert.equal(p.responses, 3);
  assert.ok(Math.abs(p.ratings[rating.id].avg - (4 + 2 + 2) / 3) < 1e-9);
  assert.equal(r.evaluatorsCount, 3);
  const csv = await http('GET', '/api/admin/results/staff.csv');
  assert.equal(csv.status, 200);
  assert.match(csv.text, /Liam Patel/);
  const links = await http('GET', '/api/admin/links.csv');
  assert.match(links.text, /\/s\/[A-Z2-9]{10}/);
});

test('default question set is 5 categorized statements plus one comment', () => {
  const qs = db.listQuestions('staff');
  assert.equal(qs.length, 6);
  assert.equal(qs.filter(q => q.type === 'rating').length, 5);
  assert.deepEqual(qs.filter(q => q.type === 'rating').map(q => q.category),
    ['Reliability and follow-up', 'Responsiveness and communication', 'Availability and collaboration', 'People skills', 'Quality of work']);
  assert.equal(qs[5].type, 'text');
});

test('personal reports are only visible to the employee once released, and only with enough evaluations', async () => {
  const emps = db.listEmployees();
  const bob = emps.find(e => e.role === 'IT Manager');      // has 3 evaluations from the previous test
  const alice = emps.find(e => e.role === 'HR Manager');    // has none
  // not released yet: nothing
  let r = await http('GET', `/api/survey/${bob.code}/reports`);
  assert.equal(r.status, 200);
  assert.equal(r.json.reports.length, 0);
  // admin preview works regardless of status
  r = await http('GET', '/api/admin/reports/staff');
  assert.equal(r.status, 200);
  const bobRep = r.json.reports.find(x => x.person.id === bob.id);
  assert.equal(bobRep.person.visible, true);
  assert.equal(bobRep.categories.length, 5);
  assert.ok(bobRep.categories.some(c => c.mine && c.mine.n === 3));
  assert.ok(bobRep.overall.company > 0);
  assert.equal(r.json.reports.find(x => x.person.id === alice.id).person.visible, false);
  // release
  assert.equal((await http('PUT', '/api/admin/groups/staff', { status: 'released' })).status, 200);
  r = await http('GET', `/api/survey/${bob.code}/reports`);
  assert.equal(r.json.reports.length, 1);
  assert.equal(r.json.reports[0].person.name, bob.name);
  assert.equal(r.json.reports[0].person.visible, true);
  r = await http('GET', `/api/survey/${alice.code}/reports`);
  assert.equal(r.json.reports[0].person.visible, false);
  assert.deepEqual(r.json.reports[0].comments, {});
  // released also means closed for submissions
  const rating = db.listQuestions('staff').find(q => q.type === 'rating');
  r = await http('POST', `/api/survey/${alice.code}/submit`, { group_id: 'staff', target_id: bob.id, answers: { [rating.id]: 5 } });
  assert.equal(r.status, 400);
  await http('PUT', '/api/admin/groups/staff', { status: 'open' });
  // the survey page tells the employee which surveys are released
  const page = (await http('GET', `/api/survey/${bob.code}`)).json;
  assert.equal(page.groups[0].status, 'open');
});

test('restore default questions', async () => {
  await http('PUT', '/api/admin/groups/ops/questions', { questions: [{ text: 'Only one', type: 'rating', category: 'X' }] });
  assert.equal(db.listQuestions('ops').length, 1);
  const r = await http('POST', '/api/admin/groups/ops/questions/restore');
  assert.equal(r.status, 200);
  assert.equal(r.json.length, 6);
});

test('closing a survey blocks submissions', async () => {
  const emps = db.listEmployees();
  const a = emps.find(e => e.role === 'Controller'), b = emps.find(e => e.role === 'VP Sales');
  const rating = db.listQuestions('staff').find(q => q.type === 'rating');
  assert.equal((await http('PUT', '/api/admin/groups/staff', { status: 'closed' })).status, 200);
  const r = await http('POST', `/api/survey/${a.code}/submit`, { group_id: 'staff', target_id: b.id, answers: { [rating.id]: 5 } });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /closed/);
  await http('PUT', '/api/admin/groups/staff', { status: 'open' });
});

test('import from pasted CSV and question editing', async () => {
  const csv = 'Name, Department, Role, Email, Survey\nJane Doe, Sales, AE, jane@example.com, staff\nJohn Smith, Operations, Operator, , ops\nBoth Ways, Operations, Manager, , staff+ops\nBad Row, , , , staff\nBad Group, Sales, , , nope';
  const r = await http('POST', '/api/admin/employees/import', { csv });
  assert.equal(r.json.added, 3);
  assert.equal(r.json.errors.length, 2);
  const both = db.listEmployees().find(e => e.name === 'Both Ways');
  assert.deepEqual([...both.groups].sort(), ['ops', 'staff']);

  const qs = db.listQuestions('ops');
  const edited = [{ id: qs[0].id, text: 'Edited first question', type: 'rating' }, { text: 'Brand new', type: 'text' }];
  const q = await http('PUT', '/api/admin/groups/ops/questions', { questions: edited });
  assert.equal(q.status, 200);
  assert.equal(q.json.length, 2);
  assert.equal(q.json[0].id, qs[0].id);
  assert.equal(q.json[0].text, 'Edited first question');
});

test('import from a Microsoft 365 directory export: header-mapped columns, survey chosen from the department', async () => {
  const tsv = [
    'Col\tDisplay name\tFirst name\tLast name\tOffice Location\tJob Title\tDepartment\tProfessional Email address',
    '\tDaniya Danish\tDaniya\tDanish\tLahore\tLead Content Writer\tMarketing\tddanish@example.com',
    '',
    '322\tJannat Mehmood\tJannat\tMehmood\tLahore\tSirix Pro Manager\tOperation\tjmehmood@example.com',
    '\t\tAli\tKhan\tLahore\tOperator\tOperators\takhan@example.com',
    '\tNo Dept\tNo\tDept\tLahore\tIntern\t\tnodept@example.com',
  ].join('\n');
  const r = await http('POST', '/api/admin/employees/import', { csv: tsv });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.added, 3);
  assert.equal(r.json.errors.length, 1);
  const emps = db.listEmployees();
  const d = emps.find(e => e.name === 'Daniya Danish');
  assert.deepEqual(d.groups, ['staff']);
  assert.equal(d.role, 'Lead Content Writer');
  assert.equal(d.email, 'ddanish@example.com');
  assert.equal(d.department, 'Marketing');
  assert.deepEqual(emps.find(e => e.name === 'Jannat Mehmood').groups, ['staff']);   // 'Operation' department is office staff
  assert.deepEqual(emps.find(e => e.name === 'Ali Khan').groups, ['ops']);   // name built from First + Last
  // Excel sheet with its own column order and extra columns, no email, no job title
  const xls = 'Employee ID\tDepartment\tName\tStart date\tManager\n1001\tOperations\tSara Op\t2024-01-02\tX\n1002\tAudit\tBilal Audit\t2023-05-06\tY\n1003\toperators\tOmar Op\t2023-05-06\tY';
  const r2 = await http('POST', '/api/admin/employees/import', { csv: xls });
  assert.equal(r2.json.added, 3, r2.text);
  assert.deepEqual(db.listEmployees().find(e => e.name === 'Omar Op').groups, ['ops']);
  assert.deepEqual(db.listEmployees().find(e => e.name === 'Sara Op').groups, ['staff']);
  assert.equal(db.listEmployees().find(e => e.name === 'Bilal Audit').department, 'Audit');
});

test('demo responses generate and reset clears them', async () => {
  await http('POST', '/api/admin/demo', { what: 'all' });
  let r = (await http('GET', '/api/admin/results/ops')).json;
  assert.ok(r.totalResponses > 20);
  assert.ok(r.people.some(p => p.visible));
  await http('POST', '/api/admin/reset', { what: 'responses' });
  r = (await http('GET', '/api/admin/results/ops')).json;
  assert.equal(r.totalResponses, 0);
  assert.ok(r.people.length > 0);
});

test('email: settings, templates, sending personal links through a fake transport, logging and failures', async () => {
  const sent = [];
  mail.setTransport(async (s, from, to, message) => { sent.push({ s, from, to, message }); });
  let r = await http('POST', '/api/admin/mail/send', { kind: 'invite', filter: 'all' });
  assert.equal(r.status, 400);                                   // not configured yet
  r = await http('PUT', '/api/admin/mail/settings', { host: 'smtp.example.com', port: 465, security: 'tls', user: 'survey@example.com', password: 'secret', from: 'survey@example.com', fromName: 'Sirix Survey', replyTo: 'hr@example.com' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.settings.hasPassword, true);
  assert.equal(r.json.settings.password, undefined);
  assert.equal(r.json.settings.configured, true);
  assert.equal((await http('PUT', '/api/admin/mail/settings', { port: 99999 })).status, 400);
  r = await http('PUT', '/api/admin/mail/templates', { invite: { subject: 'Subject', body: 'No link here' } });
  assert.equal(r.status, 400);
  r = await http('PUT', '/api/admin/mail/templates', { invite: { subject: 'Your link, {first_name} – été', body: 'Hello {name}, here is {link} (code {code}) – {organization}' } });
  assert.equal(r.status, 200, r.text);
  // sample employees have no email: give two of them one
  const emps = db.listEmployees();
  await http('PUT', `/api/admin/employees/${emps[0].id}`, { email: 'a@example.com' });
  await http('PUT', `/api/admin/employees/${emps[1].id}`, { email: 'b@example.com' });
  let info = (await http('GET', '/api/admin/mail')).json;
  assert.equal(info.withEmail, 2);
  assert.equal(info.counts.invite.all, 2);
  assert.equal(info.counts.invite.unsent, 2);
  assert.ok(info.counts.report.blocked);                         // nothing released
  r = await http('POST', '/api/admin/mail/send', { kind: 'invite', filter: 'unsent' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.total, 2);
  const waitJob = async () => { for (let i = 0; i < 100 && (await http('GET', '/api/admin/mail/status')).json.running; i++) await new Promise(res => setTimeout(res, 20)); return (await http('GET', '/api/admin/mail/status')).json; };
  let st = await waitJob();
  assert.equal(st.running, false);
  assert.equal(st.sent, 2);
  assert.deepEqual(st.failed, []);
  assert.equal(sent.length, 2);
  const a = sent.find(x => x.to === 'a@example.com');
  assert.equal(a.from, 'survey@example.com');
  assert.match(a.message, /^From: "Sirix Survey" <survey@example.com>\r\n/);
  assert.match(a.message, /\r\nReply-To: <hr@example.com>\r\n/);
  assert.match(a.message, /\r\nSubject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=/);
  assert.match(a.message, /\r\nContent-Type: multipart\/alternative; boundary="[^"]+"\r\n/);
  const parts = [...a.message.matchAll(/Content-Type: text\/(plain|html); charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n--/g)].map(x => [x[1], Buffer.from(x[2].replace(/\r\n/g, ''), 'base64').toString('utf8')]);
  assert.deepEqual(parts.map(x => x[0]), ['plain', 'html']);
  const body = parts[0][1], html = parts[1][1];
  assert.match(body, new RegExp(`Hello ${emps[0].name}, here is http://127\\.0\\.0\\.1:\\d+/s/${emps[0].code} \\(code [A-Z2-9]{5}-[A-Z2-9]{5}\\) – Sirix Monitoring`));
  assert.match(html, /SIRIX/);
  assert.match(html, new RegExp(`<a href="http://127\\.0\\.0\\.1:\\d+/s/${emps[0].code}"[^>]*>Open my survey`));
  assert.match(html, /Sirix Monitoring/);
  // HTML rendering of the default template: button, code box, bullet list, escaping
  const vars = mail.varsFor({ name: '<Ana> Doe', code: emps[0].code }, 'https://x.test');
  const h = mail.htmlEmail('invite', mail.render(mail.DEFAULT_TEMPLATES.invite.body, vars), vars);
  assert.match(h, /Hi &lt;Ana&gt;,/);
  assert.ok(!/style="[^"]*"[^ >]/.test(h.replace(/style="[^"]*"/g, 'style=""')), 'no stray quotes inside style attributes');
  assert.match(h, /<li[^>]*>Your answers are confidential/);
  assert.match(h, new RegExp(`>${db.formatCode(emps[0].code)}<`));
  assert.ok(!h.includes('{link}'));
  // {signature}: plain text in the text part, styled block in the HTML part
  const txt = mail.render(mail.DEFAULT_TEMPLATES.invite.body, vars);
  assert.ok(txt.includes('Daniel Cyr\nPresident / CEO\n\nSirix - Remote Live Monitoring\nT: 1-866-765-6667 x1012 | dan@sirixmonitoring.com'));
  assert.ok(!txt.includes('{signature}'));
  assert.match(h, /color:#5fd0b0;">Daniel Cyr<\/span>/);
  assert.match(h, /Sirix<\/span> - Remote Live Monitoring/);
  assert.match(h, /<a href="mailto:dan@sirixmonitoring\.com"/);
  assert.match(h, /<a href="https:\/\/www\.sirixmonitoring\.com"/);
  assert.ok(!h.includes('signature\u0000'), 'marker never leaks');
  assert.equal((h.match(/Daniel Cyr/g) || []).length, 1, 'signature rendered once');
  const prev = await http('GET', '/api/admin/mail/preview/report');
  assert.equal(prev.status, 200);
  assert.match(prev.text, /See my report/);
  const ov = (await http('GET', '/api/admin/overview')).json;
  assert.ok(ov.employees.find(e => e.id === emps[0].id).inviteSentAt);
  assert.equal((await http('GET', '/api/admin/mail')).json.counts.invite.unsent, 0);
  // one failure is reported per person and does not stop the others
  mail.setTransport(async (s, from, to) => { if (to === 'b@example.com') throw new Error('mailbox full'); });
  r = await http('POST', '/api/admin/mail/send', { kind: 'invite', filter: 'all' });
  assert.equal(r.status, 200, r.text);
  st = await waitJob();
  assert.equal(st.sent, 1);
  assert.equal(st.failed.length, 1);
  assert.match(st.failed[0].error, /mailbox full/);
  // single person
  r = await http('POST', '/api/admin/mail/send', { kind: 'invite', filter: 'ids', ids: [emps[0].id] });
  assert.equal(r.json.total, 1);
  await waitJob();
  // test email
  assert.equal((await http('POST', '/api/admin/mail/test', { to: 'not-an-email' })).status, 400);
  assert.equal((await http('POST', '/api/admin/mail/test', { to: 'me@example.com' })).status, 200);
  // report notices: refused until a survey is released, then only to people who have a report
  assert.equal((await http('POST', '/api/admin/mail/send', { kind: 'report', filter: 'all' })).status, 400);
  await http('POST', '/api/admin/demo', { what: 'responses' });
  await http('PUT', '/api/admin/groups/staff', { status: 'released' });
  info = (await http('GET', '/api/admin/mail')).json;
  assert.equal(info.counts.report.blocked, null);
  const staffWithEmail = db.listEmployees().filter(e => e.email && e.groups.includes('staff'));
  assert.ok(info.counts.report.all <= staffWithEmail.length);
  await http('PUT', '/api/admin/groups/staff', { status: 'open' });
  mail.setTransport(async () => {});
});

test('email: the SMTP client speaks the protocol (EHLO, AUTH PLAIN, MAIL, RCPT, DATA with dot-stuffing, QUIT)', async () => {
  const net = require('node:net');
  const log = [];
  let data = '';
  const srv = net.createServer(sock => {
    sock.write('220 fake ESMTP\r\n');
    let inData = false;
    sock.on('data', chunk => {
      const text = chunk.toString();
      if (inData) { data += text; if (data.includes('\r\n.\r\n')) { inData = false; sock.write('250 OK queued\r\n'); } return; }
      for (const line of text.split('\r\n').filter(Boolean)) {
        log.push(line);
        if (line.startsWith('EHLO')) sock.write('250-fake\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n');
        else if (line.startsWith('AUTH PLAIN')) sock.write(Buffer.from(line.slice(11), 'base64').toString() === '\0user\0pw' ? '235 ok\r\n' : '535 Incorrect authentication data\r\n');
        else if (line.startsWith('MAIL FROM')) sock.write('250 ok\r\n');
        else if (line.startsWith('RCPT TO')) sock.write(line.includes('bad@') ? '550 no such user\r\n' : '250 ok\r\n');
        else if (line === 'DATA') { inData = true; sock.write('354 go\r\n'); }
        else if (line === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
        else sock.write('500 what\r\n');
      }
    });
  });
  await new Promise(res => srv.listen(0, '127.0.0.1', res));
  const settings = { host: '127.0.0.1', port: srv.address().port, security: 'none', user: 'user', password: 'pw', verifyTls: true };
  await mail.smtpSend(settings, 'from@example.com', 'to@example.com', 'Subject: hi\r\n\r\n.leading dot\r\nbody');
  assert.ok(log.some(l => l.startsWith('EHLO ')));
  assert.ok(log.includes('MAIL FROM:<from@example.com>'));
  assert.ok(log.includes('RCPT TO:<to@example.com>'));
  assert.match(data, /\r\n\.\.leading dot\r\n/);
  await assert.rejects(mail.smtpSend(settings, 'from@example.com', 'bad@example.com', 'x'), /no such user/);
  await assert.rejects(mail.smtpSend({ ...settings, password: 'wrong' }, 'from@example.com', 'to@example.com', 'x'), /AUTH failed: 535/);
  await assert.rejects(mail.smtpSend({ ...settings, port: 1 }, 'from@example.com', 'to@example.com', 'x'), /Cannot connect/);
  srv.close();
});

test('legacy French defaults in an existing database are translated on start', () => {
  db.updateGroup('staff', { name: 'Sondage d’appréciation du travail (employés de bureau et direction)' });
  const qs = db.listQuestions('staff');
  const fr = ['Cette personne respecte ses engagements et fait les suivis nécessaires sans qu’on ait à la relancer.', 'Cette personne répond dans un délai raisonnable et communique de façon claire et précise.', 'Cette personne est disponible quand j’ai besoin d’elle et collabore bien avec les autres.', 'Cette personne est respectueuse, agréable à côtoyer et ouverte aux autres points de vue.', 'Je peux me fier à la qualité du travail de cette personne.', 'Commentaire constructif pour cette personne'];
  seed.restoreDefaultQuestions('staff');
  const ids = db.listQuestions('staff').map(q => q.id);
  db.replaceQuestions('staff', fr.map((text, i) => ({ id: ids[i], text, type: i === 5 ? 'text' : 'rating', category: 'X' })));
  seed.ensureDefaults();
  assert.equal(db.getGroup('staff').name, 'Work Appreciation Survey (office staff and management)');
  const after = db.listQuestions('staff');
  assert.deepEqual(after.map(q => q.id), ids);                     // ids (and answers) kept
  assert.equal(after[0].text, 'This person keeps their commitments and follows up without having to be reminded.');
  assert.equal(after[0].category, 'Reliability and follow-up');
});

test('a person can be evaluated with another survey’s statements (managers in the operations survey)', async () => {
  seed.restoreDefaultQuestions('ops'); seed.restoreDefaultQuestions('staff');
  db.updateGroup('ops', { status: 'open' });
  db.resetResponses();
  const emps = db.listEmployees();
  const ops = emps.filter(e => e.groups.includes('ops') && !e.groups.includes('staff'));
  const manager = ops[0], operator = ops[1], other = ops[2];
  // Admin sets the override through the API
  let r = await http('PUT', `/api/admin/employees/${manager.id}`, { question_set: 'staff' });
  assert.equal(r.status, 200); assert.equal(r.json.question_set, 'staff');
  r = await http('PUT', `/api/admin/employees/${other.id}`, { question_set: 'nope' });
  assert.equal(r.json.question_set, '');                                   // unknown survey -> default
  // The operator's survey payload carries both sets and marks the manager
  r = await http('GET', `/api/survey/${operator.code}`);
  const g = r.json.groups.find(x => x.id === 'ops');
  assert.equal(g.targets.find(t => t.id === manager.id).questionSet, 'staff');
  assert.equal(g.targets.find(t => t.id === other.id).questionSet, 'ops');
  assert.equal(g.questionSets.staff[0].category, 'Reliability and follow-up');
  assert.equal(g.questionSets.ops[0].category, 'Reliability on shift');
  // Answers about the manager are validated against the staff statements; ops statement ids are ignored
  const staffQ = g.questionSets.staff[0], opsQ = g.questionSets.ops[0];
  r = await http('POST', `/api/survey/${operator.code}/submit`, { group_id: 'ops', target_id: manager.id, answers: { [opsQ.id]: 5 } });
  assert.equal(r.status, 400); assert.match(r.json.error, /nothing to save/);   // the ops statement is not asked about the manager
  r = await http('POST', `/api/survey/${operator.code}/submit`, { group_id: 'ops', target_id: manager.id, answers: { [staffQ.id]: 4, [opsQ.id]: 5 } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  for (const ev of ops.slice(2, 4)) assert.ok(!db.submitEvaluation(ev, 'ops', manager.id, { [staffQ.id]: 2 }).error);
  // Results and report use the manager's own set
  const res = db.results('ops');
  const p = res.people.find(x => x.id === manager.id);
  assert.equal(p.questionSet, 'staff');
  assert.equal(p.visible, true);
  assert.ok(p.ratings[staffQ.id] && !p.ratings[opsQ.id]);
  assert.equal(res.questionSets.staff[0].id, staffQ.id);
  const rep = db.reportFor('ops', manager.id);
  assert.equal(rep.categories[0].category, 'Reliability and follow-up');
  assert.ok(Math.abs(rep.categories[0].mine.avg - (4 + 2 + 2) / 3) < 1e-9);
  assert.equal(rep.categories[1].mine, null);
  // CSV export labels the other set's columns
  r = await http('GET', '/api/admin/results/ops.csv');
  assert.match(r.text, /\[Work Appreciation Survey \(office staff and management\)\] This person keeps their commitments/);
  db.resetResponses();
  await http('PUT', `/api/admin/employees/${manager.id}`, { question_set: '' });
});

test('operations survey gets the operator-specific statements; an untouched generic set is upgraded only while unanswered', () => {
  const cats = () => db.listQuestions('ops').filter(q => q.type === 'rating').map(q => q.category);
  seed.restoreDefaultQuestions('ops');
  assert.deepEqual(cats(), ['Reliability on shift', 'Shift communication and handovers', 'Availability and collaboration', 'People skills', 'Event handling']);
  // Database left by an earlier version: generic set on ops, no answers -> upgraded on start
  db.replaceQuestions('ops', seed.FIVE_QUESTIONS);
  assert.equal(cats()[0], 'Reliability and follow-up');
  seed.ensureDefaults();
  assert.equal(cats()[4], 'Event handling');
  // Same, but with an answer already recorded -> left alone
  db.replaceQuestions('ops', seed.FIVE_QUESTIONS);
  const members = db.listEmployees().filter(e => e.groups.includes('ops'));
  const q = db.listQuestions('ops')[0];
  db.updateGroup('ops', { status: 'open' });
  const r = db.submitEvaluation(members[0], 'ops', members[1].id, { [q.id]: 4 });
  assert.ok(!r.error, r.error);
  seed.ensureDefaults();
  assert.equal(cats()[0], 'Reliability and follow-up');
  db.resetResponses();
  seed.restoreDefaultQuestions('ops');
});

test('logout clears the session', async () => {
  await http('POST', '/api/admin/logout');
  const r = await http('GET', '/api/admin/overview', null, { cookie: 'admin_session=garbage.1.2.sig' });
  assert.equal(r.status, 401);
});
