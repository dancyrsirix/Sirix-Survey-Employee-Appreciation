'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'survey-test-'));
process.env.DATA_DIR = tmp;
process.env.PORT = '0';
delete process.env.ADMIN_PASSWORD;

const { server } = require('../server');
const db = require('../lib/db');
const seed = require('../lib/seed');

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
  assert.match(r.json.error, /déjà/);
  const sv = (await http('GET', `/api/survey/${alice.code}`)).json;
  assert.equal(sv.groups[0].targets.find(t => t.id === bob.id).done, true);
  // operator cannot submit into the staff survey
  const op = emps.find(e => e.role === 'Operator');
  r = await http('POST', `/api/survey/${op.code}/submit`, { group_id: 'staff', target_id: bob.id, answers: { [rating.id]: 4 } });
  assert.equal(r.status, 400);
});

test('stored answers carry no evaluator identity', () => {
  const cols = db.db.prepare('PRAGMA table_info(responses)').all().map(c => c.name);
  assert.deepEqual(cols.sort(), ['group_id', 'id', 'target_id']);
  const acols = db.db.prepare('PRAGMA table_info(answers)').all().map(c => c.name);
  assert.deepEqual(acols.sort(), ['question_id', 'rating', 'response_id', 'text']);
  const row = db.db.prepare('SELECT * FROM responses').get();
  assert.match(row.id, /^[0-9a-f-]{36}$/);
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
    ['Fiabilité et suivis', 'Réactivité et communication', 'Disponibilité et collaboration', 'Côté humain', 'Qualité du travail']);
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
  assert.match(r.json.error, /fermé/);
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

test('logout clears the session', async () => {
  await http('POST', '/api/admin/logout');
  const r = await http('GET', '/api/admin/overview', null, { cookie: 'admin_session=garbage.1.2.sig' });
  assert.equal(r.status, 401);
});
