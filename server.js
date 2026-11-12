'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const db = require('./lib/db');
const seed = require('./lib/seed');
const mail = require('./lib/mail');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
// Admin credentials: either set ADMIN_USER / ADMIN_PASSWORD in the environment, or leave them unset and
// create the account on the first visit to /admin. In that case only a salted hash is stored in the database.
const ENV_ADMIN_USER = process.env.ADMIN_USER || '';
const ENV_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SESSION_HOURS = 12;
const PUBLIC_DIR = path.join(__dirname, 'public');

seed.ensureDefaults();
if (process.env.SEED_SAMPLE === '1' && db.listEmployees().length === 0) {
  seed.loadSampleEmployees();
  seed.loadDemoResponses();
}

// ---------- small helpers ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}
function json(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; if (data.length > 1e6) { reject(new Error('Body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}
function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function isHttps(req) {
  return req.socket.encrypted || (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}
function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
}
function safeEqual(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function baseUrl(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`;
  return (isHttps(req) ? 'https' : 'http') + '://' + host;
}

// ---------- rate limiting (in memory, per IP) ----------
const buckets = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now > b.reset) { b = { count: 0, reset: now + windowMs }; buckets.set(key, b); }
  b.count++;
  return b.count > max;
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (now > b.reset) buckets.delete(k); }, 60_000).unref();

// ---------- admin credentials ----------
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return salt + ':' + crypto.scryptSync(password, salt, 32).toString('hex');
}
function adminConfigured() {
  return !!(ENV_ADMIN_PASSWORD || db.getSetting('admin_password_hash'));
}
function checkCredentials(username, password) {
  if (ENV_ADMIN_PASSWORD) return safeEqual(username, ENV_ADMIN_USER || 'admin') && safeEqual(password, ENV_ADMIN_PASSWORD);
  const stored = db.getSetting('admin_password_hash');
  if (!stored) return false;
  const [salt] = stored.split(':');
  return safeEqual(username, db.getSetting('admin_user', 'admin')) && safeEqual(hashPassword(password, salt), stored);
}

// ---------- admin sessions (signed cookie) ----------
function sign(payload) {
  return crypto.createHmac('sha256', db.getSetting('secret')).update(payload).digest('base64url');
}
function makeSession() {
  const exp = Date.now() + SESSION_HOURS * 3600_000;
  const payload = `admin.${exp}.${crypto.randomBytes(8).toString('hex')}`;
  return `${payload}.${sign(payload)}`;
}
function isAdmin(req) {
  const token = cookies(req).admin_session;
  if (!token) return false;
  const i = token.lastIndexOf('.');
  if (i < 0) return false;
  const payload = token.slice(0, i), sig = token.slice(i + 1);
  if (!safeEqual(sig, sign(payload))) return false;
  const exp = parseInt(payload.split('.')[1], 10);
  return Number.isFinite(exp) && exp > Date.now();
}
function sessionCookie(req, value, maxAge) {
  return `admin_session=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;
}

// ---------- routes ----------
const routes = [];
function route(method, pattern, handler) { routes.push({ method, pattern, handler }); }

// Public: survey access
route('GET', /^\/api\/survey\/([A-Za-z0-9-]+)$/, (req, res, m) => {
  if (limited('code:' + clientIp(req), 60, 60_000)) return json(res, 429, { error: 'Too many attempts. Wait a minute.' });
  const emp = db.getEmployeeByCode(m[1]);
  if (!emp) return json(res, 404, { error: 'This access code is not valid. Check it and try again.' });
  json(res, 200, {
    employee: { name: emp.name, department: emp.department },
    orgName: db.getSetting('org_name'),
    ratingScale: seed.RATING_SCALE,
    groups: db.surveyForEmployee(emp),
  });
});
route('POST', /^\/api\/survey\/([A-Za-z0-9-]+)\/submit$/, async (req, res, m) => {
  if (limited('submit:' + clientIp(req), 120, 60_000)) return json(res, 429, { error: 'Too many requests. Wait a minute.' });
  const emp = db.getEmployeeByCode(m[1]);
  if (!emp) return json(res, 404, { error: 'This access code is not valid.' });
  const body = await readJson(req);
  const result = db.submitEvaluation(emp, String(body.group_id || ''), String(body.target_id || ''), body.answers || {});
  if (result.error) return json(res, 400, result);
  json(res, 200, { ok: true });
});

route('GET', /^\/api\/survey\/([A-Za-z0-9-]+)\/reports$/, (req, res, m) => {
  if (limited('code:' + clientIp(req), 60, 60_000)) return json(res, 429, { error: 'Too many attempts. Wait a minute.' });
  const emp = db.getEmployeeByCode(m[1]);
  if (!emp) return json(res, 404, { error: 'This access code is not valid.' });
  // Only surveys whose results have been released by the admin.
  const reports = emp.groups.map(gid => db.getGroup(gid)).filter(g => g && g.status === 'released').map(g => db.reportFor(g.id, emp.id)).filter(Boolean);
  json(res, 200, { employee: { name: emp.name, department: emp.department }, orgName: db.getSetting('org_name'), reports });
});

// Admin: auth
route('GET', /^\/api\/admin\/status$/, (req, res) => {
  json(res, 200, { configured: adminConfigured(), loggedIn: isAdmin(req) });
});
route('POST', /^\/api\/admin\/setup$/, async (req, res) => {
  // First-run only: creates the admin account when none exists yet.
  if (adminConfigured()) return json(res, 400, { error: 'The administrator account already exists.' });
  const body = await readJson(req);
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  if (!username || password.length < 8) return json(res, 400, { error: 'Choose a username and a password of at least 8 characters.' });
  db.setSetting('admin_user', username);
  db.setSetting('admin_password_hash', hashPassword(password));
  res.setHeader('Set-Cookie', sessionCookie(req, makeSession(), SESSION_HOURS * 3600));
  json(res, 200, { ok: true });
});
route('POST', /^\/api\/admin\/password$/, admin(async (req, res) => {
  if (ENV_ADMIN_PASSWORD) return json(res, 400, { error: 'The password is set by the ADMIN_PASSWORD environment variable. Change it there.' });
  const body = await readJson(req);
  if (!checkCredentials(db.getSetting('admin_user', 'admin'), String(body.current || ''))) return json(res, 400, { error: 'Current password is incorrect.' });
  const next = String(body.password || '');
  if (next.length < 8) return json(res, 400, { error: 'New password must be at least 8 characters.' });
  db.setSetting('admin_password_hash', hashPassword(next));
  json(res, 200, { ok: true });
}));
route('POST', /^\/api\/admin\/login$/, async (req, res) => {
  if (limited('login:' + clientIp(req), 10, 15 * 60_000)) return json(res, 429, { error: 'Too many login attempts. Try again in 15 minutes.' });
  const body = await readJson(req);
  if (checkCredentials(String(body.username || ''), String(body.password || ''))) {
    res.setHeader('Set-Cookie', sessionCookie(req, makeSession(), SESSION_HOURS * 3600));
    return json(res, 200, { ok: true });
  }
  json(res, 401, { error: 'Invalid username or password.' });
});
route('POST', /^\/api\/admin\/logout$/, (req, res) => {
  res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
  json(res, 200, { ok: true });
});

function admin(handler) {
  return (req, res, m) => {
    if (!isAdmin(req)) return json(res, 401, { error: 'Please log in.' });
    return handler(req, res, m);
  };
}

route('GET', /^\/api\/admin\/overview$/, admin((req, res) => {
  const started = new Map(db.participation().map(p => [p.id, p.started]));
  const mailed = db.mailStatus();
  json(res, 200, {
    orgName: db.getSetting('org_name'),
    minResponses: parseInt(db.getSetting('min_responses', '3'), 10),
    baseUrl: baseUrl(req),
    groups: db.listGroups().map(g => ({ ...g, questions: db.listQuestions(g.id) })),
    employees: db.listEmployees().map(e => ({ ...e, code: db.formatCode(e.code), started: !!started.get(e.id), inviteSentAt: mailed.get(`${e.id}:invite`) || null, reportSentAt: mailed.get(`${e.id}:report`) || null })),
  });
}));
route('GET', /^\/api\/admin\/results\/([a-z0-9_-]+)$/, admin((req, res, m) => {
  const r = db.results(m[1]);
  if (!r) return json(res, 404, { error: 'Unknown survey.' });
  json(res, 200, r);
}));
route('GET', /^\/api\/admin\/results\/([a-z0-9_-]+)\.csv$/, admin((req, res, m) => {
  const r = db.results(m[1]);
  if (!r) return json(res, 404, { error: 'Unknown survey.' });
  const ratingQs = r.questions.filter(q => q.type === 'rating');
  const textQs = r.questions.filter(q => q.type === 'text');
  const lines = [['Department', 'Name', 'Role', 'Responses', 'Overall', ...ratingQs.map(q => q.text), ...textQs.map(q => q.text)].map(csvEscape).join(',')];
  for (const p of r.people) {
    const row = [p.department, p.name, p.role, p.responses];
    if (!p.visible) row.push(`hidden (fewer than ${r.minResponses} responses)`, ...ratingQs.map(() => ''), ...textQs.map(() => ''));
    else {
      row.push(p.overall == null ? '' : p.overall.toFixed(2));
      row.push(...ratingQs.map(q => p.ratings[q.id] ? p.ratings[q.id].avg.toFixed(2) : ''));
      row.push(...textQs.map(q => (p.comments[q.id] || []).join(' | ')));
    }
    lines.push(row.map(csvEscape).join(','));
  }
  send(res, 200, '﻿' + lines.join('\r\n'), { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="results-${m[1]}.csv"` });
}));
route('GET', /^\/api\/admin\/reports\/([a-z0-9_-]+)$/, admin((req, res, m) => {
  if (!db.getGroup(m[1])) return json(res, 404, { error: 'Unknown survey.' });
  json(res, 200, { orgName: db.getSetting('org_name'), baseUrl: baseUrl(req), reports: db.allReports(m[1]) });
}));
route('POST', /^\/api\/admin\/groups\/([a-z0-9_-]+)\/questions\/restore$/, admin((req, res, m) => {
  if (!db.getGroup(m[1])) return json(res, 404, { error: 'Unknown survey.' });
  json(res, 200, seed.restoreDefaultQuestions(m[1]));
}));
route('GET', /^\/api\/admin\/links\.csv$/, admin((req, res) => {
  const base = baseUrl(req);
  const lines = [['Name', 'Department', 'Role', 'Email', 'Access code', 'Personal link'].join(',')];
  for (const e of db.listEmployees()) lines.push([e.name, e.department, e.role, e.email, db.formatCode(e.code), `${base}/s/${e.code}`].map(csvEscape).join(','));
  send(res, 200, '﻿' + lines.join('\r\n'), { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="survey-links.csv"' });
}));

// Admin: employees
route('POST', /^\/api\/admin\/employees$/, admin(async (req, res) => {
  const body = await readJson(req);
  if (!body.name || !body.department) return json(res, 400, { error: 'Name and department are required.' });
  json(res, 200, db.createEmployee({ name: String(body.name), department: String(body.department), role: String(body.role || ''), email: String(body.email || ''), groups: Array.isArray(body.groups) ? body.groups : [] }));
}));
route('POST', /^\/api\/admin\/employees\/import$/, admin(async (req, res) => {
  // Two formats, detected from the header row:
  //  - Simple list: Name, Department, Role, Email, Survey   (Survey = staff, ops or staff+ops; header row optional)
  //  - Directory export (Microsoft 365 / Entra / Excel): any column order, matched by header name: "Display name"
  //    (or "First name" + "Last name"), "Department", "Job Title", "...Email...", optional "Survey". When there is no
  //    Survey column, the department decides: Operators / Operations -> ops, everything else -> staff.
  const body = await readJson(req);
  const rows = parseCsv(String(body.csv || ''));
  const validGroups = new Set(db.listGroups().map(g => g.id));
  let added = 0; const errors = [];
  const header = rows.length ? rows[0].map(c => (c || '').trim().toLowerCase()) : [];
  const col = (...names) => header.findIndex(hd => names.some(n => hd === n || hd.includes(n)));
  // Header-mapped mode whenever the first row names the columns (a Department column plus any name/email column).
  const mapped = header.some(hd => hd.includes('display name') || hd.includes('job title') || hd.includes('first name') || hd.includes('email'))
    || (header.includes('department') && header.some(hd => hd.includes('name')));
  const start = mapped || /^name$/.test(header[0] || '') ? 1 : 0;
  const idx = mapped ? {
    display: col('display name', 'full name', 'name'), first: col('first name', 'given name'), last: col('last name', 'surname', 'family name'),
    dept: col('department'), role: col('job title', 'title', 'role', 'position'), email: col('email', 'e-mail', 'mail'), survey: col('survey'),
  } : null;
  if (body.replace) db.resetAll();
  for (let i = start; i < rows.length; i++) {
    const cells = rows[i].map(c => (c || '').trim());
    let name, department, role = '', email = '', groups = 'staff';
    if (mapped) {
      const at = j => (j >= 0 ? cells[j] || '' : '');
      name = (idx.display >= 0 && !/^(first|last) name/.test(header[idx.display]) ? at(idx.display) : '') || [at(idx.first), at(idx.last)].filter(Boolean).join(' ');
      department = at(idx.dept); role = at(idx.role); email = at(idx.email);
      groups = at(idx.survey) || (isOperationsDepartment(department) ? 'ops' : 'staff');
    } else {
      [name, department, role = '', email = '', groups = 'staff'] = cells;
    }
    if (!name && !department && !email) continue;
    if (!name || !department) { errors.push(`Line ${i + 1}: name and department are required.`); continue; }
    const gs = groups.split(/[+;|/ ]+/).map(x => x.trim().toLowerCase()).filter(Boolean);
    const bad = gs.filter(g => !validGroups.has(g));
    if (bad.length) { errors.push(`Line ${i + 1}: unknown survey "${bad.join(', ')}" (use staff, ops or staff+ops).`); continue; }
    db.createEmployee({ name, department, role, email, groups: gs, sort: i });
    added++;
  }
  json(res, 200, { added, errors });
}));
function isOperationsDepartment(department) {
  return /^\s*op[ée]rat/i.test(department || '');
}
route('PUT', /^\/api\/admin\/employees\/([a-f0-9-]+)$/, admin(async (req, res, m) => {
  const body = await readJson(req);
  const e = db.updateEmployee(m[1], body);
  if (!e) return json(res, 404, { error: 'Not found.' });
  json(res, 200, e);
}));
route('DELETE', /^\/api\/admin\/employees\/([a-f0-9-]+)$/, admin((req, res, m) => {
  json(res, 200, { ok: db.deleteEmployee(m[1]) });
}));
route('POST', /^\/api\/admin\/employees\/([a-f0-9-]+)\/regenerate$/, admin((req, res, m) => {
  const e = db.regenerateCode(m[1]);
  if (!e) return json(res, 404, { error: 'Not found.' });
  json(res, 200, { ...e, code: db.formatCode(e.code) });
}));

// Admin: groups, questions, settings
route('PUT', /^\/api\/admin\/groups\/([a-z0-9_-]+)$/, admin(async (req, res, m) => {
  const body = await readJson(req);
  const fields = {};
  if (typeof body.name === 'string' && body.name.trim()) fields.name = body.name.trim();
  if (typeof body.description === 'string') fields.description = body.description.trim();
  if (['open', 'closed', 'released'].includes(body.status)) fields.status = body.status;
  const g = db.updateGroup(m[1], fields);
  if (!g) return json(res, 404, { error: 'Unknown survey.' });
  json(res, 200, g);
}));
route('PUT', /^\/api\/admin\/groups\/([a-z0-9_-]+)\/questions$/, admin(async (req, res, m) => {
  if (!db.getGroup(m[1])) return json(res, 404, { error: 'Unknown survey.' });
  const body = await readJson(req);
  const qs = (Array.isArray(body.questions) ? body.questions : [])
    .map(q => ({ id: q.id, text: String(q.text || '').trim().slice(0, 500), type: q.type === 'text' ? 'text' : 'rating', category: String(q.category || '').trim().slice(0, 100) }))
    .filter(q => q.text);
  if (!qs.length) return json(res, 400, { error: 'At least one question is required.' });
  json(res, 200, db.replaceQuestions(m[1], qs));
}));
route('PUT', /^\/api\/admin\/settings$/, admin(async (req, res) => {
  const body = await readJson(req);
  if (body.minResponses != null) {
    const n = parseInt(body.minResponses, 10);
    if (!Number.isInteger(n) || n < 1 || n > 50) return json(res, 400, { error: 'Minimum responses must be between 1 and 50.' });
    db.setSetting('min_responses', n);
  }
  if (typeof body.orgName === 'string' && body.orgName.trim()) db.setSetting('org_name', body.orgName.trim().slice(0, 100));
  json(res, 200, { ok: true });
}));
route('POST', /^\/api\/admin\/demo$/, admin(async (req, res) => {
  const body = await readJson(req);
  if (body.what === 'employees') seed.loadSampleEmployees();
  else if (body.what === 'responses') seed.loadDemoResponses();
  else if (body.what === 'all') { seed.loadSampleEmployees(); seed.loadDemoResponses(); }
  else return json(res, 400, { error: 'Unknown demo action.' });
  json(res, 200, { ok: true });
}));
route('POST', /^\/api\/admin\/reset$/, admin(async (req, res) => {
  const body = await readJson(req);
  if (body.what === 'responses') db.resetResponses();
  else if (body.what === 'all') db.resetAll();
  else return json(res, 400, { error: 'Unknown reset action.' });
  json(res, 200, { ok: true });
}));

// Admin: email (personal links and report notices)
route('GET', /^\/api\/admin\/mail$/, admin((req, res) => {
  const counts = {};
  for (const kind of ['invite', 'report']) {
    counts[kind] = { all: 0, unsent: 0, notstarted: 0, blocked: null };
    for (const f of ['all', 'unsent', 'notstarted']) {
      try { counts[kind][f] = mail.recipients(kind, f).length; } catch (e) { counts[kind].blocked = e.message; }
    }
  }
  const employees = db.listEmployees();
  json(res, 200, {
    settings: mail.publicSettings(), templates: mail.templates(), defaults: mail.DEFAULT_TEMPLATES, placeholders: mail.PLACEHOLDERS,
    counts, job: mail.jobStatus(), employees: employees.length, withEmail: employees.filter(e => mail.isEmail(e.email)).length,
  });
}));
route('PUT', /^\/api\/admin\/mail\/settings$/, admin(async (req, res) => {
  const body = await readJson(req);
  try { mail.saveSettings(body); } catch (e) { return json(res, 400, { error: e.message }); }
  json(res, 200, { ok: true, settings: mail.publicSettings() });
}));
route('PUT', /^\/api\/admin\/mail\/templates$/, admin(async (req, res) => {
  const body = await readJson(req);
  try { mail.saveTemplates(body); } catch (e) { return json(res, 400, { error: e.message }); }
  json(res, 200, { ok: true, templates: mail.templates() });
}));
route('POST', /^\/api\/admin\/mail\/test$/, admin(async (req, res) => {
  const body = await readJson(req);
  const to = String(body.to || '').trim();
  if (!mail.isEmail(to)) return json(res, 400, { error: 'Enter a valid email address for the test.' });
  const kind = body.kind === 'report' ? 'report' : 'invite';
  const sample = { id: 'test', name: 'Jane Doe', email: to, code: 'TESTCODE42' };
  const tpl = mail.templates()[kind];
  const vars = mail.varsFor(sample, baseUrl(req));
  const text = mail.render(tpl.body, vars);
  try { await mail.sendMail({ to, toName: sample.name, subject: '[TEST] ' + mail.render(tpl.subject, vars), text, html: mail.htmlEmail(kind, text, vars) }); }
  catch (e) { return json(res, 502, { error: e.message }); }
  json(res, 200, { ok: true });
}));
route('GET', /^\/api\/admin\/mail\/preview\/(invite|report)$/, admin((req, res, m) => {
  // The HTML email as employees will see it, with sample values.
  const sample = { id: 'preview', name: 'Jane Doe', email: 'jane@example.com', code: 'TESTCODE42' };
  const vars = mail.varsFor(sample, baseUrl(req));
  const tpl = mail.templates()[m[1]];
  send(res, 200, mail.htmlEmail(m[1], mail.render(tpl.body, vars), vars), { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
}));
route('POST', /^\/api\/admin\/mail\/send$/, admin(async (req, res) => {
  const body = await readJson(req);
  const kind = ['invite', 'report'].includes(body.kind) ? body.kind : null;
  if (!kind) return json(res, 400, { error: 'Unknown mailing.' });
  try { json(res, 200, mail.startJob(kind, mail.recipients(kind, body.filter, body.ids), baseUrl(req))); }
  catch (e) { json(res, 400, { error: e.message }); }
}));
route('GET', /^\/api\/admin\/mail\/status$/, admin((req, res) => json(res, 200, mail.jobStatus())));

// Admin: restart the process (systemd restarts it within seconds; useful after a git pull without root access)
route('POST', /^\/api\/admin\/restart$/, admin((req, res) => {
  if (!process.env.ALLOW_RESTART) return json(res, 400, { error: 'Restart from the admin is disabled (set ALLOW_RESTART=1 in the service environment to enable it).' });
  json(res, 200, { ok: true });
  setTimeout(() => process.exit(0), 300);
}));

function parseCsv(text) {
  const rows = []; let row = []; let field = ''; let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',' || c === '\t' || c === ';') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(f => f.trim()));
}

// ---------- static files ----------
function serveStatic(req, res, file) {
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR)) return send(res, 404, 'Not found');
  fs.readFile(full, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    send(res, 200, data, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  try {
    if (p.startsWith('/api/')) {
      for (const r of routes) {
        const m = p.match(r.pattern);
        if (m && r.method === req.method) return await r.handler(req, res, m);
      }
      return json(res, 404, { error: 'Not found' });
    }
    if (p === '/') return serveStatic(req, res, 'index.html');
    if (p.startsWith('/s/') || p === '/s') return serveStatic(req, res, 'survey.html');
    if (p === '/admin' || p === '/admin/') return serveStatic(req, res, 'admin.html');
    if (p === '/admin/reports') return serveStatic(req, res, 'reports.html');
    return serveStatic(req, res, p.replace(/^\/+/, ''));
  } catch (e) {
    console.error(e);
    json(res, 500, { error: e.message || 'Server error' });
  }
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`Survey app listening on http://localhost:${PORT}  (admin at /admin, database: ${db.DB_PATH})`);
  });
}

module.exports = { server };
