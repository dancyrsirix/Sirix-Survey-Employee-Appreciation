'use strict';
// Database layer. Uses Node's built-in SQLite so the app has no npm dependencies.
//
// Anonymity design (important, read before changing):
//   - `completions` records that an evaluator has finished a given colleague.
//     It exists only to enforce "one evaluation per colleague per person".
//   - `responses` / `answers` hold what was said. They carry NO evaluator id,
//     NO timestamp and a random primary key (WITHOUT ROWID), so there is no
//     insertion order to correlate against the completions table.
//   - Never add a column to `responses` or `answers` that could identify
//     the evaluator, directly or by correlation (time, IP, user agent...).

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
function createEmployee({ name, department, role = '', email = '', groups = [], sort = 0 }) {
  const id = uid();
  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO employees (id, name, department, role, email, code, sort) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, name.trim(), department.trim(), role.trim(), email.trim(), newCode(), sort);
    for (const g of groups) db.prepare('INSERT OR IGNORE INTO memberships (group_id, employee_id) VALUES (?, ?)').run(g, id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return getEmployee(id);
}
function updateEmployee(id, { name, department, role, email, groups }) {
  const e = getEmployee(id);
  if (!e) return null;
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE employees SET name = ?, department = ?, role = ?, email = ? WHERE id = ?')
      .run((name ?? e.name).trim(), (department ?? e.department).trim(), (role ?? e.role).trim(), (email ?? e.email).trim(), id);
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
  // Responses about this person are kept (they are anonymous aggregates); their own completions are removed.
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
    const targets = db.prepare(`SELECT e.id, e.name, e.department, e.role FROM employees e
      JOIN memberships m ON m.employee_id = e.id WHERE m.group_id = ? AND e.id != ? ORDER BY e.department, e.sort, e.name`).all(gid, emp.id)
      .map(t => ({ ...t, done: done.has(t.id) }));
    groups.push({ id: g.id, name: g.name, description: g.description, status: g.status, questions: listQuestions(gid), targets });
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
  const questions = listQuestions(groupId);
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
    db.prepare('INSERT INTO responses (id, group_id, target_id) VALUES (?, ?, ?)').run(rid, groupId, targetId);
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

  const people = employees.map(e => {
    const n = counts.get(e.id) || 0;
    const person = { id: e.id, name: e.name, department: e.department, role: e.role, responses: n, visible: n >= minResponses, ratings: {}, comments: {}, overall: null };
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

  return {
    group: g, questions, minResponses, totalResponses, evaluatorsCount,
    evaluatorsTotal: employees.length,
    people, departments: Object.values(departments).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

// Personal report for one employee: their averages next to the department and company averages.
function reportFor(groupId, employeeId) {
  const r = results(groupId);
  if (!r) return null;
  const person = r.people.find(p => p.id === employeeId);
  if (!person) return null;
  const dept = r.departments.find(d => d.name === person.department) || null;
  const ratingQs = r.questions.filter(q => q.type === 'rating');
  const companyRows = db.prepare(`SELECT a.question_id, AVG(a.rating) AS avg, COUNT(a.rating) AS n
    FROM answers a JOIN responses r ON r.id = a.response_id WHERE r.group_id = ? AND a.rating IS NOT NULL GROUP BY a.question_id`).all(groupId);
  const company = {};
  for (const row of companyRows) company[row.question_id] = { avg: row.avg, n: row.n };
  let sum = 0, cnt = 0;
  for (const c of Object.values(company)) { sum += c.avg * c.n; cnt += c.n; }
  return {
    group: { id: r.group.id, name: r.group.name, status: r.group.status },
    minResponses: r.minResponses,
    person,
    questions: r.questions,
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
  // Only whether each person has started, never whom they evaluated.
  const started = new Set(db.prepare('SELECT DISTINCT evaluator_id FROM completions').all().map(r => r.evaluator_id));
  return listEmployees().map(e => ({ id: e.id, started: started.has(e.id) }));
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
  listQuestions, replaceQuestions,
  listEmployees, getEmployee, getEmployeeByCode, createEmployee, updateEmployee, deleteEmployee, regenerateCode,
  surveyForEmployee, submitEvaluation,
  results, reportFor, allReports, participation, resetResponses, resetAll,
  logMail, mailStatus,
};
