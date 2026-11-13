'use strict';
// Database layer. Uses Node's built-in SQLite so the app has no npm dependencies.
//
// Confidentiality design (read before changing):
//   - Answers are confidential: never shared with other employees, visible with their author to the admin.
//   - `completions` records that an evaluator has finished a given colleague and
//     enforces "one evaluation per colleague per person".
//   - `responses` carries the evaluator (`evaluator_id`) since 2026-11-13, so the
//     admin can see who wrote what. Rows submitted before that have a NULL evaluator
//     and can never be attributed. Employees never receive anything but averages and
//     comments in random order, and only once a person has enough evaluations.

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'survey.db');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS groups (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','released')),
  sort        INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS employees (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  department TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT '',
  email      TEXT NOT NULL DEFAULT '',
  code       TEXT NOT NULL UNIQUE,
  sort       INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS memberships (
  group_id    TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, employee_id)
);
CREATE TABLE IF NOT EXISTS questions (
  id       TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  sort     INTEGER NOT NULL,
  text     TEXT NOT NULL,
  type     TEXT NOT NULL CHECK (type IN ('rating','text'))
);
CREATE TABLE IF NOT EXISTS completions (
  evaluator_id TEXT NOT NULL,
  target_id    TEXT NOT NULL,
  group_id     TEXT NOT NULL,
  PRIMARY KEY (evaluator_id, target_id, group_id)
);
CREATE TABLE IF NOT EXISTS responses (
  id        TEXT PRIMARY KEY,
  group_id  TEXT NOT NULL,
  target_id TEXT NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS answers (
  response_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  rating      INTEGER,
  text        TEXT,
  PRIMARY KEY (response_id, question_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_responses_target ON responses(group_id, target_id);
CREATE TABLE IF NOT EXISTS mail_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id TEXT NOT NULL,
  kind        TEXT NOT NULL,
  sent_at     TEXT NOT NULL,
  ok          INTEGER NOT NULL,
  error       TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_mail_log_emp ON mail_log(employee_id, kind);
`);

// Migrations for databases created by earlier versions.
if (!db.prepare('PRAGMA table_info(questions)').all().some(c => c.name === 'category')) {
  db.exec("ALTER TABLE questions ADD COLUMN category TEXT NOT NULL DEFAULT ''");
}
// Which survey's statements are used when this person is evaluated: '' = those of the survey being taken,
// or a survey id (e.g. a manager in the operations survey who is evaluated with the office staff statements).
if (!db.prepare('PRAGMA table_info(employees)').all().some(c => c.name === 'question_set')) {
  db.exec("ALTER TABLE employees ADD COLUMN question_set TEXT NOT NULL DEFAULT ''");
}
// Who wrote each evaluation (confidential to the admin). Rows from before this column have NULL and stay unattributed.
if (!db.prepare('PRAGMA table_info(responses)').all().some(c => c.name === 'evaluator_id')) {
  db.exec('ALTER TABLE responses ADD COLUMN evaluator_id TEXT');
}
// Whether this person agreed that evaluations they submitted before authors were recorded may be shown with their name.
if (!db.prepare('PRAGMA table_info(employees)').all().some(c => c.name === 'names_consent')) {
  db.exec('ALTER TABLE employees ADD COLUMN names_consent INTEGER NOT NULL DEFAULT 0');
}
// When each evaluation was submitted (for the admin's activity feed). Older rows have NULL.
if (!db.prepare('PRAGMA table_info(responses)').all().some(c => c.name === 'created_at')) {
  db.exec('ALTER TABLE responses ADD COLUMN created_at TEXT');
}

// ---------- settings ----------
const getSettingStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const setSettingStmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');

function getSetting(key, fallback) {
  const row = getSettingStmt.get(key);
  return row ? row.value : fallback;
}
function setSetting(key, value) {
  setSettingStmt.run(key, String(value));
}
if (!getSetting('secret')) setSetting('secret', crypto.randomBytes(32).toString('hex'));
if (!getSetting('min_responses')) setSetting('min_responses', '3');
if (!getSetting('org_name')) setSetting('org_name', 'Sirix Monitoring');

// ---------- helpers ----------
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I to avoid confusion
function newCode() {
  const bytes = crypto.randomBytes(10);
  let out = '';
  for (let i = 0; i < 10; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}
function normalizeCode(input) {
  return String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}
function formatCode(code) {
  return code.slice(0, 5) + '-' + code.slice(5);
}
function uid() {
  return crypto.randomUUID();
}

// ---------- groups ----------
function listGroups() {
  return db.prepare('SELECT * FROM groups ORDER BY sort, name').all();
}
function getGroup(id) {
  return db.prepare('SELECT * FROM groups WHERE id = ?').get(id);
}
function upsertGroup(g) {
  db.prepare(`INSERT INTO groups (id, name, description, status, sort) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description, status = excluded.status, sort = excluded.sort`)
    .run(g.id, g.name, g.description || '', g.status || 'open', g.sort || 0);
}
function updateGroup(id, fields) {
  const g = getGroup(id);
  if (!g) return null;
  const next = { ...g, ...fields };
  upsertGroup(next);
  return getGroup(id);
}

// ---------- questions ----------
function listQuestions(groupId) {
  return db.prepare('SELECT * FROM questions WHERE group_id = ? ORDER BY sort').all(groupId);
}
// The statements used when `target` is evaluated in survey `groupId` (see question_set above).
function questionSetFor(groupId, target) {
  const qs = target && target.question_set;
  return qs && qs !== groupId && getGroup(qs) ? qs : groupId;
}
function questionsForTarget(groupId, target) {
  return listQuestions(questionSetFor(groupId, target));
}
function cleanQuestionSet(v) {
  v = String(v || '').trim();
  return v && getGroup(v) ? v : '';
}
function replaceQuestions(groupId, questions) {
  // Keeps ids of existing questions (so past answers stay attached), creates ids for new ones,
  // deletes questions that are no longer in the list.
  const existing = new Set(listQuestions(groupId).map(q => q.id));
  const keep = new Set();
  db.exec('BEGIN');
  try {
    questions.forEach((q, i) => {
      const id = q.id && existing.has(q.id) ? q.id : uid();
      keep.add(id);
      db.prepare(`INSERT INTO questions (id, group_id, sort, text, type, category) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET sort = excluded.sort, text = excluded.text, type = excluded.type, category = excluded.category`)
        .run(id, groupId, i, q.text, q.type, q.category || '');
    });
    for (const id of existing) if (!keep.has(id)) db.prepare('DELETE FROM questions WHERE id = ?').run(id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return listQuestions(groupId);
}

// ---------- employees ----------
function listEmployees() {
  const rows = db.prepare('SELECT * FROM employees ORDER BY department, sort, name').all();
  const memberships = db.prepare('SELECT * FROM memberships').all();
  const byEmp = new Map();
  for (const m of memberships) {
    if (!byEmp.has(m.employee_id)) byEmp.set(m.employee_id, []);
    byEmp.get(m.employee_id).push(m.group_id);
  }
  return rows.map(e => ({ ...e, groups: byEmp.get(e.id) || [] }));
}
function getEmployee(id) {
  const e = db.prepare('SELECT * FROM employees WHERE id = ?').get(id);
  if (!e) return null;
  e.groups = db.prepare('SELECT group_id FROM memberships WHERE employee_id = ?').all(id).map(r => r.group_id);
  return e;
}
function getEmployeeByCode(code) {
  const e = db.prepare('SELECT * FROM employees WHERE code = ?').get(normalizeCode(code));
  if (!e) return null;
  e.groups = db.prepare('SELECT group_id FROM memberships WHERE employee_id = ?').all(e.id).map(r => r.group_id);
  return e;
}
function createEmployee({ name, department, role = '', email = '', groups = [], sort = 0, question_set = '' }) {
  const id = uid();
  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO employees (id, name, department, role, email, code, sort, question_set) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, name.trim(), department.trim(), role.trim(), email.trim(), newCode(), sort, cleanQuestionSet(question_set));
    for (const g of groups) db.prepare('INSERT OR IGNORE INTO memberships (group_id, employee_id) VALUES (?, ?)').run(g, id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return getEmployee(id);
}
function updateEmployee(id, { name, department, role, email, groups, question_set, names_consent }) {
  const e = getEmployee(id);
  if (!e) return null;
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE employees SET name = ?, department = ?, role = ?, email = ?, question_set = ?, names_consent = ? WHERE id = ?')
      .run((name ?? e.name).trim(), (department ?? e.department).trim(), (role ?? e.role).trim(), (email ?? e.email).trim(),
        question_set === undefined ? e.question_set : cleanQuestionSet(question_set),
        names_consent === undefined ? e.names_consent : (names_consent ? 1 : 0), id);
    if (Array.isArray(groups)) {
      db.prepare('DELETE FROM memberships WHERE employee_id = ?').run(id);
      for (const g of groups) db.prepare('INSERT OR IGNORE INTO memberships (group_id, employee_id) VALUES (?, ?)').run(g, id);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return getEmployee(id);
}
function deleteEmployee(id) {
  // Responses about this person are kept; their own completions are removed. Evaluations they wrote keep their id (shown as a former employee).
  db.prepare('DELETE FROM completions WHERE evaluator_id = ?').run(id);
  db.prepare('DELETE FROM mail_log WHERE employee_id = ?').run(id);
  return db.prepare('DELETE FROM employees WHERE id = ?').run(id).changes > 0;
}
function regenerateCode(id) {
  db.prepare('UPDATE employees SET code = ? WHERE id = ?').run(newCode(), id);
  return getEmployee(id);
}

// ---------- survey (evaluator side) ----------
function surveyForEmployee(emp) {
  const groups = [];
  for (const gid of emp.groups) {
    const g = getGroup(gid);
    if (!g) continue;
    const done = new Set(db.prepare('SELECT target_id FROM completions WHERE evaluator_id = ? AND group_id = ?').all(emp.id, gid).map(r => r.target_id));
    const targets = db.prepare(`SELECT e.id, e.name, e.department, e.role, e.question_set FROM employees e
      JOIN memberships m ON m.employee_id = e.id WHERE m.group_id = ? AND e.id != ? ORDER BY e.department, e.sort, e.name`).all(gid, emp.id)
      .map(t => ({ id: t.id, name: t.name, department: t.department, role: t.role, done: done.has(t.id), questionSet: questionSetFor(gid, t) }));
    // Statements per set actually used by these colleagues (the survey's own set is always included).
    const questionSets = {};
    for (const sid of new Set([gid, ...targets.map(t => t.questionSet)])) questionSets[sid] = listQuestions(sid);
    groups.push({ id: g.id, name: g.name, description: g.description, status: g.status, questions: questionSets[gid], questionSets, targets });
  }
  return groups;
}

function submitEvaluation(emp, groupId, targetId, answers) {
  const g = getGroup(groupId);
  if (!g) return { error: 'Unknown survey.' };
  if (g.status !== 'open') return { error: 'This survey is closed.' };
  if (!emp.groups.includes(groupId)) return { error: 'You are not part of this survey.' };
  if (targetId === emp.id) return { error: 'You cannot evaluate yourself.' };
  const isTarget = db.prepare('SELECT 1 FROM memberships WHERE group_id = ? AND employee_id = ?').get(groupId, targetId);
  if (!isTarget) return { error: 'This colleague is not part of this survey.' };
  const questions = questionsForTarget(groupId, db.prepare('SELECT question_set FROM employees WHERE id = ?').get(targetId));
  const qById = new Map(questions.map(q => [q.id, q]));
  const clean = [];
  for (const [qid, raw] of Object.entries(answers || {})) {
    const q = qById.get(qid);
    if (!q) continue;
    if (q.type === 'rating') {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > 5) continue;
      clean.push({ qid, rating: n, text: null });
    } else {
      const t = String(raw ?? '').trim().slice(0, 2000);
      if (!t) continue;
      clean.push({ qid, rating: null, text: t });
    }
  }
  if (clean.length === 0) return { error: 'You ticked N/A everywhere and left no comment: nothing to save. This colleague simply stays unevaluated.' };

  db.exec('BEGIN IMMEDIATE');
  try {
    const already = db.prepare('SELECT 1 FROM completions WHERE evaluator_id = ? AND target_id = ? AND group_id = ?').get(emp.id, targetId, groupId);
    if (already) { db.exec('ROLLBACK'); return { error: 'You have already evaluated this colleague.' }; }
    db.prepare('INSERT INTO completions (evaluator_id, target_id, group_id) VALUES (?, ?, ?)').run(emp.id, targetId, groupId);
    const rid = uid();
    db.prepare('INSERT INTO responses (id, group_id, target_id, evaluator_id, created_at) VALUES (?, ?, ?, ?, ?)').run(rid, groupId, targetId, emp.id, new Date().toISOString());
    const ins = db.prepare('INSERT INTO answers (response_id, question_id, rating, text) VALUES (?, ?, ?, ?)');
    for (const a of clean) ins.run(rid, a.qid, a.rating, a.text);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { ok: true };
}

// ---------- results (admin side) ----------
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function results(groupId) {
  const minResponses = parseInt(getSetting('min_responses', '3'), 10);
  const g = getGroup(groupId);
  if (!g) return null;
  const questions = listQuestions(groupId);
  const employees = listEmployees().filter(e => e.groups.includes(groupId));
  const counts = new Map(db.prepare('SELECT target_id, COUNT(*) AS n FROM responses WHERE group_id = ? GROUP BY target_id').all(groupId).map(r => [r.target_id, r.n]));
  const evaluatorsCount = db.prepare('SELECT COUNT(DISTINCT evaluator_id) AS n FROM completions WHERE group_id = ?').get(groupId).n;
  const totalResponses = db.prepare('SELECT COUNT(*) AS n FROM responses WHERE group_id = ?').get(groupId).n;

  const ratingStmt = db.prepare(`SELECT a.question_id, AVG(a.rating) AS avg, COUNT(a.rating) AS n,
      SUM(a.rating = 1) AS r1, SUM(a.rating = 2) AS r2, SUM(a.rating = 3) AS r3, SUM(a.rating = 4) AS r4, SUM(a.rating = 5) AS r5
    FROM answers a JOIN responses r ON r.id = a.response_id
    WHERE r.group_id = ? AND r.target_id = ? AND a.rating IS NOT NULL GROUP BY a.question_id`);
  const textStmt = db.prepare(`SELECT a.question_id, a.text FROM answers a JOIN responses r ON r.id = a.response_id
    WHERE r.group_id = ? AND r.target_id = ? AND a.text IS NOT NULL`);
  // Individual evaluations with their author (confidential to the admin). Older rows have no evaluator.
  const evalStmt = db.prepare(`SELECT r.id, r.evaluator_id, e.name AS evaluator_name FROM responses r LEFT JOIN employees e ON e.id = r.evaluator_id
    WHERE r.group_id = ? AND r.target_id = ?`);
  const evalAnswers = db.prepare('SELECT question_id, rating, text FROM answers WHERE response_id = ?');
  const evaluatorMap = new Map();
  let unattributed = 0;
  // Evaluations submitted before authors were recorded: the author can sometimes be deduced by elimination from the
  // "finished" list (completions). It is shown only when every possible author agreed to have their earlier evaluations named.
  const consent = new Set(db.prepare('SELECT id FROM employees WHERE names_consent = 1').all().map(r => r.id));
  const nameOf = new Map(db.prepare('SELECT id, name FROM employees').all().map(r => [r.id, r.name]));
  const candidates = new Map();
  for (const c of db.prepare('SELECT evaluator_id, target_id FROM completions WHERE group_id = ?').all(groupId)) {
    (candidates.get(c.target_id) || candidates.set(c.target_id, new Set()).get(c.target_id)).add(c.evaluator_id);
  }
  for (const r of db.prepare('SELECT target_id, evaluator_id FROM responses WHERE group_id = ? AND evaluator_id IS NOT NULL').all(groupId)) {
    const s = candidates.get(r.target_id); if (s) s.delete(r.evaluator_id);
  }

  const questionSets = { [groupId]: questions };
  const people = employees.map(e => {
    const n = counts.get(e.id) || 0;
    const qset = questionSetFor(groupId, e);
    questionSets[qset] ||= listQuestions(qset);
    const person = { id: e.id, name: e.name, department: e.department, role: e.role, responses: n, visible: n >= minResponses, questionSet: qset, ratings: {}, comments: {}, overall: null, evaluations: [] };
    for (const row of evalStmt.all(groupId, e.id)) {
      const ev = { evaluatorId: row.evaluator_id, evaluator: row.evaluator_id ? (row.evaluator_name || 'Former employee') : null, attribution: row.evaluator_id ? 'recorded' : 'anonymous', candidates: [], ratings: {}, comments: {}, overall: null };
      if (!row.evaluator_id) {
        const set = [...(candidates.get(e.id) || [])];
        if (set.length === 1 && consent.has(set[0])) { ev.attribution = 'deduced'; ev.evaluatorId = set[0]; ev.evaluator = nameOf.get(set[0]) || 'Former employee'; }
        else if (set.length > 1 && set.every(id => consent.has(id))) { ev.attribution = 'possible'; ev.candidates = set.map(id => nameOf.get(id) || 'Former employee').sort(); }
      }
      let s = 0, c = 0;
      for (const a of evalAnswers.all(row.id)) {
        if (a.rating != null) { ev.ratings[a.question_id] = a.rating; s += a.rating; c++; }
        if (a.text != null) ev.comments[a.question_id] = a.text;
      }
      ev.overall = c ? s / c : null;
      person.evaluations.push(ev);
      if (!ev.evaluatorId) { unattributed++; continue; }
      const agg = evaluatorMap.get(ev.evaluatorId) || { id: ev.evaluatorId, name: ev.evaluator, targets: [] };
      agg.targets.push({ id: e.id, name: e.name, overall: ev.overall, comment: Object.values(ev.comments).join(' | '), attribution: ev.attribution });
      evaluatorMap.set(ev.evaluatorId, agg);
    }
    person.evaluations.sort((a, b) => (a.evaluator || '\uffff').localeCompare(b.evaluator || '\uffff'));
    if (!person.visible) return person;
    let sum = 0, cnt = 0;
    for (const r of ratingStmt.all(groupId, e.id)) {
      person.ratings[r.question_id] = { avg: r.avg, n: r.n, dist: [r.r1, r.r2, r.r3, r.r4, r.r5] };
      sum += r.avg * r.n; cnt += r.n;
    }
    person.overall = cnt ? sum / cnt : null;
    const byQ = {};
    for (const t of textStmt.all(groupId, e.id)) (byQ[t.question_id] ||= []).push(t.text);
    for (const qid of Object.keys(byQ)) byQ[qid] = shuffle(byQ[qid]);
    person.comments = byQ;
    return person;
  });

  // Department aggregates computed over every response (not only the visible people), shown when the department total meets the threshold.
  const deptRows = db.prepare(`SELECT e.department, a.question_id, AVG(a.rating) AS avg, COUNT(a.rating) AS n
    FROM answers a JOIN responses r ON r.id = a.response_id JOIN employees e ON e.id = r.target_id
    WHERE r.group_id = ? AND a.rating IS NOT NULL GROUP BY e.department, a.question_id`).all(groupId);
  const deptCounts = db.prepare(`SELECT e.department, COUNT(*) AS n FROM responses r JOIN employees e ON e.id = r.target_id
    WHERE r.group_id = ? GROUP BY e.department`).all(groupId);
  const departments = {};
  for (const e of employees) departments[e.department] ||= { name: e.department, responses: 0, visible: false, ratings: {}, overall: null };
  for (const d of deptCounts) if (departments[d.department]) { departments[d.department].responses = d.n; departments[d.department].visible = d.n >= minResponses; }
  for (const r of deptRows) {
    const d = departments[r.department];
    if (!d || !d.visible) continue;
    d.ratings[r.question_id] = { avg: r.avg, n: r.n };
  }
  for (const d of Object.values(departments)) {
    let sum = 0, cnt = 0;
    for (const r of Object.values(d.ratings)) { sum += r.avg * r.n; cnt += r.n; }
    d.overall = cnt ? sum / cnt : null;
  }

  const evaluators = [...evaluatorMap.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const ev of evaluators) ev.targets.sort((a, b) => a.name.localeCompare(b.name));

  return {
    group: g, questions, questionSets, minResponses, totalResponses, evaluatorsCount,
    evaluatorsTotal: employees.length,
    people, departments: Object.values(departments).sort((a, b) => a.name.localeCompare(b.name)),
    evaluators, unattributed,
  };
}

// Personal report for one employee: their averages next to the department and company averages.
function reportFor(groupId, employeeId) {
  const r = results(groupId);
  if (!r) return null;
  const found = r.people.find(p => p.id === employeeId);
  if (!found) return null;
  const { evaluations, ...person } = found; // the employee never sees who evaluated them
  const dept = r.departments.find(d => d.name === person.department) || null;
  const questions = r.questionSets[person.questionSet] || r.questions;
  const ratingQs = questions.filter(q => q.type === 'rating');
  // Company reference: every answer to the same statements, whichever survey they were given in
  // (a manager evaluated with the office statements in the operations survey is compared with all office evaluations).
  const companyRows = ratingQs.length ? db.prepare(`SELECT a.question_id, AVG(a.rating) AS avg, COUNT(a.rating) AS n
    FROM answers a WHERE a.rating IS NOT NULL AND a.question_id IN (${ratingQs.map(() => '?').join(',')}) GROUP BY a.question_id`).all(...ratingQs.map(q => q.id)) : [];
  const company = {};
  for (const row of companyRows) company[row.question_id] = { avg: row.avg, n: row.n };
  let sum = 0, cnt = 0;
  for (const c of Object.values(company)) { sum += c.avg * c.n; cnt += c.n; }
  return {
    group: { id: r.group.id, name: r.group.name, status: r.group.status },
    minResponses: r.minResponses,
    person,
    questions,
    categories: ratingQs.map(q => ({
      id: q.id, category: q.category, text: q.text,
      mine: person.visible && person.ratings[q.id] ? person.ratings[q.id] : null,
      department: dept && dept.visible && dept.ratings[q.id] ? dept.ratings[q.id].avg : null,
      company: company[q.id] ? company[q.id].avg : null,
    })),
    overall: { mine: person.overall, department: dept && dept.visible ? dept.overall : null, company: cnt ? sum / cnt : null },
    comments: person.visible ? person.comments : {},
  };
}
function allReports(groupId) {
  return listEmployees().filter(e => e.groups.includes(groupId)).map(e => reportFor(groupId, e.id));
}

function participation() {
  // Whether each person has started, and how many colleagues they have evaluated so far.
  const counts = new Map(db.prepare('SELECT evaluator_id, COUNT(*) AS n FROM completions GROUP BY evaluator_id').all().map(r => [r.evaluator_id, r.n]));
  return listEmployees().map(e => ({ id: e.id, started: counts.has(e.id), evaluated: counts.get(e.id) || 0 }));
}

// Latest evaluations for the admin's notification feed, newest first, plus how many arrived after `since`.
function recentActivity(limit = 30, since = '') {
  const items = db.prepare(`SELECT r.created_at AS at, r.group_id AS groupId, g.name AS groupName, r.target_id AS targetId, t.name AS target, ev.name AS evaluator
    FROM responses r JOIN employees t ON t.id = r.target_id LEFT JOIN employees ev ON ev.id = r.evaluator_id LEFT JOIN groups g ON g.id = r.group_id
    WHERE r.created_at IS NOT NULL ORDER BY r.created_at DESC LIMIT ?`).all(Math.max(1, Math.min(200, limit | 0)));
  const newSince = since ? db.prepare('SELECT COUNT(*) AS n FROM responses WHERE created_at > ?').get(String(since)).n : items.length;
  return { now: new Date().toISOString(), items: items.map(i => ({ ...i, evaluator: i.evaluator || 'Former employee' })), newSince };
}

function resetResponses() {
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM answers; DELETE FROM responses; DELETE FROM completions;');
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
function resetAll() {
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM answers; DELETE FROM responses; DELETE FROM completions; DELETE FROM memberships; DELETE FROM employees; DELETE FROM mail_log;');
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// ---------- email log (which employee got which mailing; unrelated to the answers) ----------
function logMail(employeeId, kind, ok, error = '') {
  db.prepare('INSERT INTO mail_log (employee_id, kind, sent_at, ok, error) VALUES (?, ?, ?, ?, ?)')
    .run(employeeId, kind, new Date().toISOString(), ok ? 1 : 0, String(error || '').slice(0, 500));
}
function mailStatus() {
  // Map "employeeId:kind" -> date of the last successful send.
  const m = new Map();
  for (const r of db.prepare('SELECT employee_id, kind, MAX(sent_at) AS sent_at FROM mail_log WHERE ok = 1 GROUP BY employee_id, kind').all()) m.set(`${r.employee_id}:${r.kind}`, r.sent_at);
  return m;
}

module.exports = {
  db, DB_PATH, getSetting, setSetting, newCode, normalizeCode, formatCode, uid,
  listGroups, getGroup, upsertGroup, updateGroup,
  listQuestions, replaceQuestions, questionSetFor, questionsForTarget,
  listEmployees, getEmployee, getEmployeeByCode, createEmployee, updateEmployee, deleteEmployee, regenerateCode,
  surveyForEmployee, submitEvaluation,
  results, reportFor, allReports, participation, recentActivity, resetResponses, resetAll,
  logMail, mailStatus,
};
