// Billu Solutions — reference mobile-app backend.
// Serves the API for a React Native (Expo) client:
//   GET  /health              liveness (no DB)
//   GET  /db-health           MySQL connectivity + latency
//   POST /callbacks/mpesa     M-Pesa STK push callback contract
//   POST /callbacks/:provider generic webhook receiver (idempotent)
//   POST /profiles            create profile {name,email}
//   GET  /profiles            list profiles
//   GET  /profiles/:id        profile (+photoUrl)
//   POST /profiles/:id/photo  upload profile photo (multipart field "photo") -> Garage S3
//   GET  /profiles/:id/photo  stream the photo back (public URL for the app)
import express from 'express';
import mysql from 'mysql2/promise';
import multer from 'multer';
import {
  S3Client, PutObjectCommand, GetObjectCommand, HeadBucketCommand, CreateBucketCommand,
} from '@aws-sdk/client-s3';

const PORT = Number(process.env.PORT || 4100);
const BUCKET = process.env.MEDIA_BUCKET || 'app-media';
const VERSION = '1.0.0';

const app = express();
app.use(express.json({ limit: '1mb' }));

// Express 4 does not catch async rejections — wrap every async handler so a
// failing DB/S3 call returns a 500 instead of killing the process.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---- MySQL ---------------------------------------------------------------
const pool = mysql.createPool({
  host: process.env.MYSQL_HOST || '127.0.0.1',
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DB || 'appdb',
  connectionLimit: 10,
  waitForConnections: true,
  namedPlaceholders: true,
});

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS profiles (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      email VARCHAR(160) NULL,
      photo_key VARCHAR(255) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS webhook_events (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      provider VARCHAR(32) NOT NULL,
      event_id VARCHAR(128) NULL,
      result_code INT NULL,
      payload JSON NOT NULL,
      processed TINYINT NOT NULL DEFAULT 0,
      received_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_provider_event (provider, event_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}

// ---- Garage (S3-compatible) ----------------------------------------------
const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT || 'http://127.0.0.1:3900',
  region: process.env.S3_REGION || 'us-east-1',
  credentials: { accessKeyId: process.env.S3_ACCESS_KEY, secretAccessKey: process.env.S3_SECRET_KEY },
  forcePathStyle: true,
});

async function ensureBucket() {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
  } catch (e) {
    try { await s3.send(new CreateBucketCommand({ Bucket: BUCKET })); } catch (e2) {
      console.warn(`bucket ${BUCKET} unavailable: ${e2.name || e2.message} — uploads will fail until it exists`);
    }
  }
}

// ---- webhooks ------------------------------------------------------------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (/^image\/(jpeg|png|webp)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only jpeg/png/webp images are allowed.'));
  },
});

function pickEventId(body) {
  if (typeof body?.eventId === 'string') return body.eventId;
  if (typeof body?.id === 'string') return body.id;
  if (typeof body?.event_id === 'string') return body.event_id;
  return null;
}

// M-Pesa STK push callback: { Body: { stkCallback: { MerchantRequestID, CheckoutRequestID, ResultCode, ... } } }
function mpesaFacts(body) {
  const cb = body?.Body?.stkCallback;
  if (!cb) return null;
  const meta = Array.isArray(cb.CallbackMetadata?.Item) ? cb.CallbackMetadata.Item : [];
  const item = (name) => meta.find((x) => x.Name === name)?.Value ?? null;
  return {
    eventId: cb.CheckoutRequestID || null,
    resultCode: typeof cb.ResultCode === 'number' ? cb.ResultCode : null,
    facts: {
      merchantRequestId: cb.MerchantRequestID || null,
      resultDesc: cb.ResultDesc || null,
      amount: item('Amount'),
      receipt: item('MpesaReceiptNumber'),
      phone: item('PhoneNumber'),
    },
  };
}

async function recordWebhook(provider, body, eventId, resultCode) {
  // Idempotent: a repeated event_id for the same provider updates instead of duplicating.
  await pool.query(
    `INSERT INTO webhook_events (provider, event_id, result_code, payload, processed)
     VALUES (?, ?, ?, ?, 1)
     ON DUPLICATE KEY UPDATE payload = VALUES(payload), result_code = VALUES(result_code), processed = 1`,
    [provider, eventId, resultCode, JSON.stringify(body)],
  );
}

// ---- routes --------------------------------------------------------------
app.get('/health', wrap((_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), version: VERSION });
}));

app.get('/db-health', wrap(async (_req, res) => {
  const t0 = Date.now();
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'up', latencyMs: Date.now() - t0 });
  } catch (e) {
    res.status(503).json({ status: 'degraded', db: 'down', error: e.code || e.message });
  }
}));

app.post('/callbacks/mpesa', wrap(async (req, res) => {
  try {
    const parsed = mpesaFacts(req.body);
    if (!parsed) {
      await recordWebhook('mpesa', req.body, null, null);
      return res.status(400).json({ ResultCode: 1, ResultDesc: 'Unrecognized payload' });
    }
    await recordWebhook('mpesa', req.body, parsed.eventId, parsed.resultCode);
    // Accept fast; real processing (order fulfilment etc.) happens on the stored row.
    res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  } catch (e) {
    console.error('mpesa callback error:', e.message);
    res.status(500).json({ ResultCode: 1, ResultDesc: 'Failed' });
  }
}));

app.post('/callbacks/:provider', wrap(async (req, res) => {
  try {
    const provider = String(req.params.provider).slice(0, 32);
    const eventId = req.get('x-event-id') || pickEventId(req.body);
    await recordWebhook(provider, req.body, eventId, null);
    res.json({ received: true, provider, eventId });
  } catch (e) {
    console.error('callback error:', e.message);
    res.status(500).json({ received: false, error: e.code || e.message });
  }
}));

app.post('/profiles', wrap(async (req, res) => {
  const { name, email } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  const [r] = await pool.query('INSERT INTO profiles (name, email) VALUES (?, ?)', [String(name).slice(0, 120), email ? String(email).slice(0, 160) : null]);
  const [[row]] = await pool.query('SELECT * FROM profiles WHERE id = ?', [r.insertId]);
  res.status(201).json(row);
}));

app.get('/profiles', wrap(async (_req, res) => {
  const [rows] = await pool.query('SELECT * FROM profiles ORDER BY id DESC LIMIT 100');
  res.json(rows);
}));

app.get('/profiles/:id', wrap(async (req, res) => {
  const [[row]] = await pool.query('SELECT * FROM profiles WHERE id = ?', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(row);
}));

app.post('/profiles/:id/photo', upload.single('photo'), wrap(async (req, res) => {
  const [[row]] = await pool.query('SELECT id FROM profiles WHERE id = ?', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'profile not found' });
  const ext = (req.file.mimetype.split('/')[1] || 'bin').replace('jpeg', 'jpg');
  const key = `profiles/${row.id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: req.file.buffer, ContentType: req.file.mimetype }));
  await pool.query('UPDATE profiles SET photo_key = ? WHERE id = ?', [key, row.id]);
  res.json({ id: row.id, photoUrl: `/profiles/${row.id}/photo`, key });
}));

app.get('/profiles/:id/photo', wrap(async (req, res) => {
  const [[row]] = await pool.query('SELECT photo_key FROM profiles WHERE id = ?', [req.params.id]);
  if (!row?.photo_key) return res.status(404).json({ error: 'no photo' });
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: row.photo_key }));
    res.setHeader('Content-Type', obj.ContentType || 'application/octet-stream');
    obj.Body.pipe(res);
  } catch (e) {
    res.status(404).json({ error: 'object missing' });
  }
}));

// error handler (multer + async safety net)
app.use((err, _req, res, _next) => {
  console.error('request error:', err.code || err.message);
  res.status(err.status || 500).json({ error: err.message || 'internal error' });
});

async function main() {
  await ensureSchema();
  await ensureBucket();
  app.listen(PORT, '127.0.0.1', () => console.log(`mobile-backend v${VERSION} on 127.0.0.1:${PORT} (bucket: ${BUCKET})`));
}
main().catch((e) => { console.error('startup failed:', e); process.exit(1); });
