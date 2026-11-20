#!/usr/bin/env node
/**
 * cloudlane-mail-stack — SMTP receiver (port 25) + outbound sender.
 *
 * Inbound: accepts mail for registry mailboxes, parses it, stores it in the
 *          workspace database through the platform API (/mail/inbound).
 * Outbound: the API posts to /outbound; we resolve the recipient's MX,
 *          deliver directly (nodemailer), sign with DKIM when keys exist.
 *
 * Env: SMTP_PORT(25), API_URL(http://127.0.0.1:3000/api/v1), MAIL_STACK_TOKEN,
 *      S3_ENDPOINT/S3_ACCESS_KEY/S3_SECRET_KEY/S3_REGION (for attachments),
 *      DKIM_KEY_PATH(/etc/cloudlane/mail/dkim.private), DKIM_SELECTOR(mail)
 */
import { SMTPServer } from 'smtp-server';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import http from 'node:http';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

const SMTP_PORT = Number(process.env.SMTP_PORT || 25);
const API_URL = process.env.API_URL || 'http://127.0.0.1:3000/api/v1';
const TOKEN = process.env.MAIL_STACK_TOKEN || '';
const DKIM_KEY = process.env.DKIM_KEY_PATH || '/etc/cloudlane/mail/dkim.private';
const DKIM_SELECTOR = process.env.DKIM_SELECTOR || 'mail';

let registry = new Map(); // email.toLowerCase() -> workspaceId
let s3 = null;

function log(...args) { console.log(new Date().toISOString(), '[mail-stack]', ...args); }

function s3Client() {
  if (s3) return s3;
  if (!process.env.S3_ACCESS_KEY) return null;
  s3 = new S3Client({
    endpoint: process.env.S3_ENDPOINT || 'http://127.0.0.1:3900',
    region: process.env.S3_REGION || 'garage',
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY,
      secretAccessKey: process.env.S3_SECRET_KEY || '',
    },
    forcePathStyle: true,
  });
  return s3;
}

async function refreshRegistry() {
  try {
    const res = await fetch(`${API_URL}/mail/registry`, { headers: { 'x-mail-stack-token': TOKEN } });
    if (!res.ok) throw new Error(`registry ${res.status}`);
    const data = await res.json();
    registry = new Map((data.mailboxes || []).map((m) => [m.email.toLowerCase(), m.workspaceId]));
    log(`registry loaded: ${registry.size} mailbox(es)`);
  } catch (e) {
    log('registry refresh failed:', e.message);
  }
}

async function apiPost(pathname, body) {
  const res = await fetch(`${API_URL}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-mail-stack-token': TOKEN },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`API ${pathname} -> ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return res.json();
}

async function attachmentBuffer(bucket, key) {
  const client = s3Client();
  if (!client || !bucket || !key) return null;
  const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const chunks = [];
  for await (const chunk of res.Body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

const server = new SMTPServer({
  banner: 'Drevanta Mail Stack',
  authOptional: true,
  disabledCommands: ['AUTH'],
  onRcptTo(address, session, cb) {
    const email = String(address.address || '').toLowerCase();
    if (!registry.has(email)) {
      const err = new Error('Mailbox not found on this server');
      err.responseCode = 550;
      return cb(err);
    }
    return cb();
  },
  onData(stream, session, cb) {
    const rcpts = (session.envelope.rcptTo || []).map((r) => String(r.address).toLowerCase()).filter((a) => registry.has(a));
    const mailFrom = String(session.envelope.mailFrom?.address || '').toLowerCase();
    simpleParser(stream)
      .then(async (parsed) => {
        for (const rcpt of rcpts) {
          try {
            await apiPost('/mail/inbound', {
              rcptTo: rcpt,
              mailFrom,
              subject: parsed.subject || '(no subject)',
              text: parsed.text || '',
              html: parsed.html ? String(parsed.html).slice(0, 200000) : '',
              messageId: parsed.messageId || '',
            });
            log(`stored inbound for ${rcpt} from ${mailFrom}`);
          } catch (e) {
            log('inbound store failed:', e.message);
          }
        }
        cb();
      })
      .catch((e) => { log('parse failed:', e.message); cb(); });
  },
});

server.on('error', (e) => log('SMTP server error:', e.message));

const senderForApi = (reqBody) => new Promise((resolve, reject) => {
    const chunks = [];
    reqBody.on('data', (c) => chunks.push(c));
    reqBody.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(e); }
    });
  });

http.createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/outbound') { res.writeHead(404).end(); return; }
  if (req.headers['x-mail-stack-token'] !== TOKEN) { res.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'bad token' })); return; }
  let body;
  try { body = await senderForApi(req); } catch { res.writeHead(400).end(); return; }

  const to = String(body.to || '');
  const from = String(body.from || '');
  const domain = from.split('@')[1] || '';
  let dkim = false;
  if (fs.existsSync(DKIM_KEY) && domain) {
    try {
      dkim = { domainName: domain, keySelector: DKIM_SELECTOR, privateKey: fs.readFileSync(DKIM_KEY, 'utf8'), headerFields: ['from', 'to', 'subject', 'date'] };
    } catch { dkim = false; }
  }

  const attachments = [];
  for (const a of body.attachments || []) {
    try {
      const buf = await attachmentBuffer(body.bucket, a.key);
      if (buf) attachments.push({ filename: a.name, content: buf });
    } catch (e) { log('attachment fetch failed:', a.name, e.message); }
  }

  try {
    const rcptDomain = to.split('@')[1] || '';
    let hosts = [];
    try {
      const mx = await dns.resolveMx(rcptDomain);
      hosts = (mx || []).sort((a, b) => a.priority - b.priority).map((r) => r.exchange).slice(0, 3);
    } catch { /* fall through to A record */ }
    if (!hosts.length) {
      const a = await dns.resolve4(rcptDomain).catch(() => []);
      hosts = a.slice(0, 1);
    }
    if (!hosts.length) throw new Error(`no MX or A record for ${rcptDomain}`);
    log(`outbound ${from} -> ${to} trying ${hosts.join(', ')}`);
    let info = null;
    let lastErr = null;
    for (const host of hosts) {
      try {
        const opts = { host, port: 25, name: process.env.HELO_NAME || 'server.billucsolutions.co.ke' };
        if (dkim) opts.dkim = dkim;
        info = await nodemailer.createTransport(opts).sendMail({
          from,
          to,
          subject: body.subject || '(no subject)',
          text: body.text || '',
          attachments,
        });
        break;
      } catch (e) {
        lastErr = e;
        log(`attempt via ${host} failed: ${e.message}`);
      }
    }
    if (!info) throw lastErr || new Error('all MX hosts failed');
    log('outbound accepted:', (info.accepted || []).join(', '));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ accepted: info.accepted || [], rejected: info.rejected || [] }));
  } catch (e) {
    log('outbound failed:', e.message);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ accepted: [], error: e.message }));
  }
}).listen(Number(process.env.OUTBOUND_PORT || 3901), '127.0.0.1', () => log('outbound API on 127.0.0.1:3901'));

server.listen(SMTP_PORT, () => log(`SMTP receiver listening on :${SMTP_PORT}`));
refreshRegistry();
setInterval(refreshRegistry, 60000);
