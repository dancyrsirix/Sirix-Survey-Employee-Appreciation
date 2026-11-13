'use strict';
// Email without npm dependencies: a small SMTP client (SSL/TLS, STARTTLS or plain), the two
// mailings (personal link, report available) with editable templates, and a background job that
// sends to employees one by one so the admin can follow the progress and see who failed.
const net = require('node:net');
const tls = require('node:tls');
const os = require('node:os');
const crypto = require('node:crypto');
const db = require('./db');

const DEFAULT_TEMPLATES = {
  invite: {
    subject: 'Work appreciation survey: your personal link',
    body: `Hi {first_name},

I wanted to create this survey for a simple reason: to help us improve, individually and as a team, by listening to what the people we work with every day have to say about us. We all have strengths and things we can do better, and honest, constructive feedback from our colleagues is one of the best ways to see both.

You are invited to evaluate the colleagues you work with. It takes about a minute per person.

Your personal link: {link}
Your access code: {code}

A few things to know:
- Your answers are confidential and are never shared with other employees.
- You can skip any statement, or any colleague you do not work with enough to judge.
- You can come back later with the same link; your progress is saved.

Thank you for being part of this amazing team. I will keep working to make {organization} the best working environment possible, and your feedback is a big part of that.

{signature}`,
  },
  report: {
    subject: 'Your appreciation report is available',
    body: `Hi {first_name},

The work appreciation survey is over. Your personal report is now available on your personal link:
{link}

It shows your average per category next to the department and company averages, as well as the constructive comments you received. You can print it or save it as a PDF.

Take it for what it is: an honest picture from the people who work with you, with things to be proud of and things to work on. Thank you again for taking part and for helping us build the best working environment possible.

{signature}`,
  },
};
const PLACEHOLDERS = ['{first_name}', '{name}', '{link}', '{code}', '{organization}', '{signature}'];
// The sender's signature: plain text in the text part, a styled block in the HTML part (see htmlEmail).
const SIGNATURE = {
  name: 'Daniel Cyr', title: 'President / CEO',
  company: 'Sirix', tagline: 'Remote Live Monitoring',
  phone: '1-866-765-6667 x1012', email: 'dan@sirixmonitoring.com',
  address: '2525 Bd Daniel-Johnson, Suite #405, Laval, QC H7T 1S9', website: 'www.sirixmonitoring.com',
};
const SIGNATURE_TEXT = `${SIGNATURE.name}
${SIGNATURE.title}

${SIGNATURE.company} - ${SIGNATURE.tagline}
T: ${SIGNATURE.phone} | ${SIGNATURE.email}

${SIGNATURE.address} | ${SIGNATURE.website}`;
const SIGNATURE_MARK = '\u0000signature\u0000';
const SECURITIES = ['tls', 'starttls', 'none'];
const ENV_LOCKED = !!process.env.SMTP_HOST;
const PAUSE_MS = parseInt(process.env.MAIL_PAUSE_MS || '300', 10);

function isEmail(s) { return /^[^\s@"<>]+@[^\s@"<>]+\.[^\s@"<>]+$/.test(String(s || '').trim()); }

// ---------- settings (database, or SMTP_* environment variables which then lock the admin form) ----------
function settings() {
  const g = (key, env, fallback = '') => ENV_LOCKED ? (process.env[env] ?? fallback) : db.getSetting(key, fallback);
  const s = {
    envLocked: ENV_LOCKED,
    host: g('mail_host', 'SMTP_HOST'),
    port: parseInt(g('mail_port', 'SMTP_PORT', '465'), 10) || 465,
    security: g('mail_security', 'SMTP_SECURITY', 'tls'),
    user: g('mail_user', 'SMTP_USER'),
    password: g('mail_password', 'SMTP_PASSWORD'),
    from: g('mail_from', 'SMTP_FROM'),
    fromName: g('mail_from_name', 'SMTP_FROM_NAME') || db.getSetting('org_name', ''),
    replyTo: g('mail_reply_to', 'SMTP_REPLY_TO'),
    verifyTls: g('mail_tls_verify', 'SMTP_TLS_VERIFY', '1') !== '0',
  };
  if (!SECURITIES.includes(s.security)) s.security = 'tls';
  if (!s.from) s.from = s.user;
  return s;
}
function isConfigured(s = settings()) { return !!(s.host && isEmail(s.from)); }
function publicSettings() {
  const s = settings();
  return { ...s, password: undefined, hasPassword: !!s.password, configured: isConfigured(s) };
}
function saveSettings(body) {
  if (ENV_LOCKED) throw new Error('Email settings come from the SMTP_* environment variables. Change them there.');
  const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
  if (body.port != null) {
    const n = parseInt(body.port, 10);
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error('Port must be between 1 and 65535.');
  }
  if (body.security != null && !SECURITIES.includes(body.security)) throw new Error('Security must be tls, starttls or none.');
  if (body.from != null && str(body.from) && !isEmail(str(body.from))) throw new Error('The From address is not a valid email address.');
  if (body.replyTo != null && str(body.replyTo) && !isEmail(str(body.replyTo))) throw new Error('The Reply-To address is not a valid email address.');
  if (body.host != null) db.setSetting('mail_host', str(body.host));
  if (body.port != null) db.setSetting('mail_port', parseInt(body.port, 10));
  if (body.security != null) db.setSetting('mail_security', body.security);
  if (body.user != null) db.setSetting('mail_user', str(body.user));
  if (typeof body.password === 'string' && body.password !== '') db.setSetting('mail_password', body.password.slice(0, 200));
  if (body.clearPassword) db.setSetting('mail_password', '');
  if (body.from != null) db.setSetting('mail_from', str(body.from));
  if (body.fromName != null) db.setSetting('mail_from_name', str(body.fromName, 100));
  if (body.replyTo != null) db.setSetting('mail_reply_to', str(body.replyTo));
  if (body.verifyTls != null) db.setSetting('mail_tls_verify', body.verifyTls ? '1' : '0');
}

// ---------- templates ----------
function templates() {
  const out = {};
  for (const k of Object.keys(DEFAULT_TEMPLATES)) {
    out[k] = { subject: db.getSetting(`mail_tpl_${k}_subject`, DEFAULT_TEMPLATES[k].subject), body: db.getSetting(`mail_tpl_${k}_body`, DEFAULT_TEMPLATES[k].body) };
  }
  return out;
}
function saveTemplates(body) {
  for (const k of Object.keys(DEFAULT_TEMPLATES)) {
    const t = body[k];
    if (!t) continue;
    const subject = String(t.subject || '').trim().slice(0, 200);
    const text = String(t.body || '').trim().slice(0, 5000);
    if (!subject || !text) throw new Error('Subject and message are required.');
    if (!text.includes('{link}')) throw new Error('The message must contain {link}, the personal link.');
    db.setSetting(`mail_tpl_${k}_subject`, subject);
    db.setSetting(`mail_tpl_${k}_body`, text);
  }
}
function render(tpl, vars) { return String(tpl).replace(/\{(first_name|name|link|code|organization|signature)\}/g, (_, k) => vars[k] ?? ''); }
function varsFor(emp, base) {
  return { name: emp.name, first_name: emp.name.trim().split(/\s+/)[0], link: `${base}/s/${emp.code}`, code: db.formatCode(emp.code), organization: db.getSetting('org_name', ''), signature: SIGNATURE_TEXT };
}
function signatureHtml() {
  const s = SIGNATURE, row = (inner, extra = '') => `<tr><td style="font-family:${FONT};font-size:14px;line-height:1.4;color:#1a1a1a;${extra}">${inner}</td></tr>`;
  const sep = '<span style="color:#9aa0a6;padding:0 6px;">|</span>';
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:26px 0 2px;">
${row(`<span style="font-size:19px;font-weight:800;color:#5fd0b0;">${escapeHtml(s.name)}</span>`)}
${row(escapeHtml(s.title), 'padding-bottom:14px;')}
${row(`<span style="font-size:17px;font-weight:800;color:#1d2433;">${escapeHtml(s.company)}</span> - ${escapeHtml(s.tagline)}`)}
${row(`<b>T:</b> ${escapeHtml(s.phone)}${sep}<a href="mailto:${escapeHtml(s.email)}" style="color:#1a1a1a;">${escapeHtml(s.email)}</a>`, 'padding-bottom:14px;')}
${row(`${escapeHtml(s.address)}${sep}<a href="https://${escapeHtml(s.website)}" style="color:#4a8fe7;font-weight:700;text-decoration:none;">${escapeHtml(s.website)}</a>`)}
</table>`;
}

// ---------- Sirix-style HTML version, generated from the plain-text template ----------
const FONT = "Montserrat, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
function escapeHtml(str) { return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function linkify(escaped) { return escaped.replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g, '<a href="$1" style="color:#1a1a1a;font-weight:600;">$1</a>'); }
function htmlEmail(kind, text, vars) {
  const button = kind === 'report' ? 'See my report' : kind === 'admin' ? 'Choose my password' : 'Open my survey';
  const blocks = [];
  let para = [], list = [];
  const flushPara = () => { if (para.length) { blocks.push(`<p style="margin:0 0 14px;">${para.map(l => linkify(escapeHtml(l))).join('<br>')}</p>`); para = []; } };
  const flushList = () => { if (list.length) { blocks.push(`<ul style="margin:0 0 14px;padding-left:22px;">${list.map(l => `<li style="margin:0 0 6px;">${linkify(escapeHtml(l))}</li>`).join('')}</ul>`); list = []; } };
  for (const raw of String(text).split(SIGNATURE_TEXT).join(`\n${SIGNATURE_MARK}\n`).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) { flushPara(); flushList(); continue; }
    if (line === SIGNATURE_MARK) { flushPara(); flushList(); blocks.push(signatureHtml()); continue; }
    if (/^[-•*]\s+/.test(line)) { flushPara(); list.push(line.replace(/^[-•*]\s+/, '')); continue; }
    flushList();
    if (vars.link && line.includes(vars.link)) {
      flushPara();
      const label = escapeHtml(line.replace(vars.link, '').replace(/[:\s]+$/, '').trim());
      blocks.push(`${label ? `<p style="margin:0 0 10px;">${label}</p>` : ''}
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:4px 0 10px;"><tr><td style="background:#1a1a1a;border-radius:8px;">
<a href="${escapeHtml(vars.link)}" style="display:inline-block;padding:13px 26px;font-family:${FONT};font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-bottom:3px solid #5fd0b0;border-radius:8px;">${button} &rarr;</a>
</td></tr></table>
<p style="margin:0 0 16px;font-size:12px;color:#6b6f76;">Or copy this link into your browser:<br><a href="${escapeHtml(vars.link)}" style="color:#6b6f76;">${escapeHtml(vars.link)}</a></p>`);
      continue;
    }
    if (vars.code && line.includes(vars.code)) {
      flushPara();
      const label = escapeHtml(line.replace(vars.code, '').replace(/[:\s]+$/, '').trim());
      blocks.push(`<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px;"><tr><td style="background:#e6f7f1;border-radius:8px;padding:12px 18px;">
<div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#0d2b22;font-weight:700;">${label || 'Access code'}</div>
<div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:22px;font-weight:700;letter-spacing:.12em;color:#0d2b22;margin-top:2px;">${escapeHtml(vars.code)}</div>
</td></tr></table>`);
      continue;
    }
    para.push(line);
  }
  flushPara(); flushList();
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(vars.organization || 'Sirix')}</title></head>
<body style="margin:0;padding:0;background:#f4f5f7;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
<tr><td style="background:#1a1a1a;border-bottom:6px solid #5fd0b0;padding:22px 26px;border-radius:10px 10px 0 0;">
<div style="font-family:${FONT};font-weight:800;font-size:30px;letter-spacing:.08em;color:#ffffff;line-height:1;">SIRIX</div>
<div style="font-family:${FONT};font-size:12px;color:#d9dbdf;margin-top:6px;">Always present. Constantly vigilant.</div>
</td></tr>
<tr><td style="background:#ffffff;border:1px solid #e3e5e8;border-top:0;padding:26px 26px 20px;border-radius:0 0 10px 10px;font-family:${FONT};font-size:15px;line-height:1.5;color:#1a1a1a;">
<div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#6b6f76;font-weight:700;margin:0 0 16px;">Work appreciation survey &middot; Confidential</div>
${blocks.join('\n')}
</td></tr>
<tr><td style="padding:16px 10px;font-family:${FONT};font-size:12px;color:#6b6f76;text-align:center;line-height:1.5;">
Confidential: your colleagues never see who wrote what.<br>${escapeHtml(vars.organization || '')}
</td></tr>
</table></td></tr></table>
</body></html>`;
}

// ---------- message building (RFC 5322, UTF-8 everywhere, base64 body) ----------
function encodeWord(s) {
  s = String(s);
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  const words = [];
  let chunk = '';
  for (const ch of s) {
    if (Buffer.byteLength(chunk + ch, 'utf8') > 42) { words.push(chunk); chunk = ''; }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map(w => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join('\r\n ');
}
function formatAddress(name, addr) {
  name = String(name || '').trim().replace(/[\r\n]/g, ' ');
  if (!name) return `<${addr}>`;
  const shown = /^[\x20-\x7e]*$/.test(name) ? `"${name.replace(/(["\\])/g, '\\$1')}"` : encodeWord(name);
  return `${shown} <${addr}>`;
}
function wrap76(s) { return s.match(/.{1,76}/g) || ['']; }
function buildMessage({ from, fromName, to, toName, replyTo, subject, text, html }) {
  const domain = from.split('@')[1] || os.hostname();
  const b64 = (str) => wrap76(Buffer.from(String(str).replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64'));
  const boundary = '=_sirix_' + crypto.randomBytes(12).toString('hex');
  const lines = [
    `From: ${formatAddress(fromName, from)}`,
    `To: ${formatAddress(toName, to)}`,
    replyTo ? `Reply-To: <${replyTo}>` : null,
    `Subject: ${encodeWord(subject.replace(/[\r\n]+/g, ' '))}`,
    `Date: ${new Date().toUTCString().replace(/GMT$/, '+0000')}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    'MIME-Version: 1.0',
    ...(html ? [
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      ...b64(text),
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      ...b64(html),
      `--${boundary}--`,
    ] : [
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      ...b64(text),
    ]),
  ].filter(l => l != null);
  return lines.join('\r\n');
}

// ---------- SMTP client ----------
function smtpSend(s, envelopeFrom, to, message, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    let socket = null, buffer = '', done = false, waiter = null;
    const queue = [];
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (socket) { try { socket.destroy(); } catch { /* ignore */ } }
      err ? reject(err) : resolve();
    };
    const timer = setTimeout(() => finish(new Error('SMTP timeout: the mail server did not answer within 30 seconds.')), timeoutMs);
    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        const idx = buffer.search(/^\d{3} [^\n]*\n/m);
        if (idx < 0) return;
        const end = buffer.indexOf('\n', idx) + 1;
        const reply = { code: parseInt(buffer.slice(idx, idx + 3), 10), text: buffer.slice(0, end).trim() };
        buffer = buffer.slice(end);
        if (waiter) { const w = waiter; waiter = null; w(reply); } else queue.push(reply);
      }
    };
    const attach = (sock) => {
      socket = sock;
      sock.on('data', onData);
      sock.on('error', (e) => finish(new Error('SMTP connection error: ' + e.message)));
      sock.on('close', () => { if (!done) finish(new Error('The mail server closed the connection unexpectedly.')); });
    };
    const read = () => new Promise(res => { if (queue.length) res(queue.shift()); else waiter = res; });
    const expect = async (cmd, okCodes, label) => {
      if (cmd != null) socket.write(cmd + '\r\n');
      const r = await read();
      if (!okCodes.includes(r.code)) throw new Error(`SMTP ${label || (cmd ? cmd.split(/[ :]/)[0] : 'greeting')} failed: ${r.text}`);
      return r;
    };
    const tlsOptions = { servername: s.host, rejectUnauthorized: s.verifyTls !== false };
    const connect = () => new Promise((res, rej) => {
      const onErr = (e) => rej(new Error(`Cannot connect to ${s.host}:${s.port}: ${e.message}`));
      if (s.security === 'tls') {
        const sock = tls.connect({ host: s.host, port: s.port, ...tlsOptions }, () => { sock.off('error', onErr); attach(sock); res(); });
        sock.once('error', onErr);
      } else {
        const sock = net.connect({ host: s.host, port: s.port }, () => { sock.off('error', onErr); attach(sock); res(); });
        sock.once('error', onErr);
      }
    });
    const upgrade = () => new Promise((res, rej) => {
      const plain = socket;
      plain.removeAllListeners('data'); plain.removeAllListeners('error'); plain.removeAllListeners('close');
      const onErr = (e) => rej(new Error('STARTTLS failed: ' + e.message));
      const secure = tls.connect({ socket: plain, ...tlsOptions }, () => { secure.off('error', onErr); attach(secure); res(); });
      secure.once('error', onErr);
    });

    (async () => {
      await connect();
      await expect(null, [220]);
      const ehlo = async () => (await expect(`EHLO ${os.hostname() || 'localhost'}`, [250])).text;
      let caps = await ehlo();
      if (s.security === 'starttls') {
        if (!/STARTTLS/i.test(caps)) throw new Error('The mail server does not offer STARTTLS on this port.');
        await expect('STARTTLS', [220]);
        await upgrade();
        caps = await ehlo();
      }
      if (s.user) {
        if (/AUTH[ =][^\n]*PLAIN/i.test(caps)) {
          await expect('AUTH PLAIN ' + Buffer.from(`\0${s.user}\0${s.password}`, 'utf8').toString('base64'), [235], 'AUTH');
        } else if (/AUTH[ =][^\n]*LOGIN/i.test(caps)) {
          await expect('AUTH LOGIN', [334], 'AUTH');
          await expect(Buffer.from(s.user, 'utf8').toString('base64'), [334], 'AUTH');
          await expect(Buffer.from(s.password, 'utf8').toString('base64'), [235], 'AUTH');
        } else {
          throw new Error('The mail server does not accept a username and password here (no AUTH PLAIN/LOGIN). Try another port or security setting.');
        }
      }
      await expect(`MAIL FROM:<${envelopeFrom}>`, [250]);
      await expect(`RCPT TO:<${to}>`, [250, 251]);
      await expect('DATA', [354]);
      socket.write(message.replace(/^\./gm, '..') + '\r\n.\r\n');
      const r = await read();
      if (r.code !== 250) throw new Error('The mail server refused the message: ' + r.text);
      socket.write('QUIT\r\n');
      finish();
    })().catch(finish);
  });
}

let transport = smtpSend;
function setTransport(fn) { transport = fn || smtpSend; }

async function sendMail({ to, toName = '', subject, text, html = null }) {
  const s = settings();
  if (!isConfigured(s)) throw new Error('Email is not configured yet. Fill in the mail server settings first.');
  to = String(to || '').trim();
  if (!isEmail(to)) throw new Error(`Invalid email address: ${to || '(empty)'}`);
  const message = buildMessage({ from: s.from, fromName: s.fromName, to, toName, replyTo: s.replyTo, subject, text, html });
  await transport(s, s.from, to, message);
}

// ---------- recipients and background job ----------
function recipients(kind, filter = 'all', ids = []) {
  let list = db.listEmployees().filter(e => isEmail(e.email));
  if (kind === 'report') {
    const released = db.listGroups().filter(g => g.status === 'released').map(g => g.id);
    if (!released.length) throw new Error('No survey has its reports released yet. Release them first in "Individual reports".');
    const hasReport = new Set();
    for (const gid of released) for (const rep of db.allReports(gid)) if (rep && rep.person.visible) hasReport.add(rep.person.id);
    list = list.filter(e => hasReport.has(e.id));
  }
  if (filter === 'unsent') { const st = db.mailStatus(); list = list.filter(e => !st.has(`${e.id}:${kind}`)); }
  else if (filter === 'notstarted') { const started = new Map(db.participation().map(p => [p.id, p.started])); list = list.filter(e => !started.get(e.id)); }
  else if (filter === 'ids') { const set = new Set(Array.isArray(ids) ? ids : []); list = list.filter(e => set.has(e.id)); }
  return list;
}

const job = { running: false, kind: null, total: 0, sent: 0, failed: [], startedAt: null, finishedAt: null };
function jobStatus() { return { ...job, failed: job.failed.slice(0, 500) }; }
function startJob(kind, list, base) {
  if (job.running) throw new Error('A mailing is already in progress. Wait for it to finish.');
  if (!isConfigured()) throw new Error('Email is not configured yet. Fill in the mail server settings first.');
  if (!list.length) throw new Error('Nobody to send to with this selection.');
  const tpl = templates()[kind];
  Object.assign(job, { running: true, kind, total: list.length, sent: 0, failed: [], startedAt: new Date().toISOString(), finishedAt: null });
  (async () => {
    for (const emp of list) {
      const vars = varsFor(emp, base);
      try {
        const text = render(tpl.body, vars);
        await sendMail({ to: emp.email, toName: emp.name, subject: render(tpl.subject, vars), text, html: htmlEmail(kind, text, vars) });
        db.logMail(emp.id, kind, true);
        job.sent++;
      } catch (e) {
        db.logMail(emp.id, kind, false, e.message);
        job.failed.push({ id: emp.id, name: emp.name, email: emp.email, error: e.message });
      }
      if (PAUSE_MS > 0) await new Promise(r => setTimeout(r, PAUSE_MS));
    }
    job.running = false;
    job.finishedAt = new Date().toISOString();
  })();
  return jobStatus();
}

module.exports = {
  DEFAULT_TEMPLATES, PLACEHOLDERS, SIGNATURE, SIGNATURE_TEXT, isEmail, settings, publicSettings, saveSettings, isConfigured,
  templates, saveTemplates, render, varsFor, htmlEmail, buildMessage, smtpSend, setTransport, sendMail,
  recipients, startJob, jobStatus,
};
