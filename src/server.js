// fake-llm-checker API: enqueue APIScamHunter scans, poll for verdicts,
// download the generated HTML evidence report.
const crypto = require('crypto');
const dns = require('dns').promises;
const express = require('express');
const fs = require('fs');
const path = require('path');

const db = require('./db');
const { auth } = require('./auth');
const { rateLimit } = require('./ratelimit');
const runner = require('./runner');

const PORT = parseInt(process.env.PORT || '3000', 10);
const MAX_ACTIVE_PER_KEY = parseInt(process.env.MAX_ACTIVE_CHECKS || '10', 10);

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));

// --- SSRF guard: the scanner makes outbound requests to a user-supplied URL.
// Refuse anything resolving to private/loopback/link-local/metadata ranges.
function isPrivateIp(ip) {
  if (ip === '::1' || ip === '::') return true;
  if (ip.includes(':')) {
    const l = ip.toLowerCase();
    return l.startsWith('fe80:') || l.startsWith('fc') || l.startsWith('fd');
  }
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
  return (
    p[0] === 10 || p[0] === 127 || p[0] === 0 ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) ||
    (p[0] === 169 && p[1] === 254)
  );
}

async function assertPublicUrl(raw) {
  let u;
  try { u = new URL(String(raw).trim()); }
  catch { throw new Error('baseUrl is not a valid URL'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('baseUrl must be http(s)');
  let addrs;
  try { addrs = await dns.lookup(u.hostname, { all: true }); }
  catch { throw new Error('baseUrl hostname does not resolve'); }
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) {
    throw new Error('baseUrl must resolve to a public IP (SSRF guard)');
  }
  return u.toString().replace(/\/+$/, '');
}

const LEVELS = ['quick', 'standard', 'full'];

app.get('/healthz', (req, res) => res.json({ ok: true, service: 'fake-llm-checker' }));

app.post('/api/checks', auth, rateLimit, async (req, res) => {
  try {
    const { baseUrl, apiKey, model, level = 'standard', price, tier, known } = req.body || {};
    if (!apiKey || typeof apiKey !== 'string' || apiKey.length < 8) {
      return res.status(400).json({ error: 'apiKey (the LLM key to test) is required' });
    }
    if (!LEVELS.includes(level)) {
      return res.status(400).json({ error: `level must be one of ${LEVELS.join('|')}` });
    }
    const cleanUrl = await assertPublicUrl(baseUrl);
    if (db.activeCount() >= MAX_ACTIVE_PER_KEY) {
      return res.status(429).json({ error: 'too many active checks; wait for one to finish' });
    }
    const id = crypto.randomUUID();
    const row = db.create(id, {
      baseUrl: cleanUrl,
      model: typeof model === 'string' ? model.slice(0, 80) : undefined,
      level,
      price: price === undefined ? undefined : Number(price) || 0,
      tier: typeof tier === 'string' ? tier.slice(0, 20) : undefined,
      known: !!known,
    });
    runner.submitKey(id, apiKey); // memory only — never persisted
    res.status(202).json({ id, status: row.status, pollUrl: `/api/checks/${id}` });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/checks', auth, rateLimit, (req, res) => {
  res.json({ checks: db.list() });
});

app.get('/api/checks/:id', auth, rateLimit, (req, res) => {
  const row = db.get(req.params.id);
  if (!row) return res.status(404).json({ error: 'unknown check id' });
  res.json(row);
});

app.get('/api/checks/:id/report', auth, rateLimit, (req, res) => {
  const row = db.get(req.params.id);
  if (!row) return res.status(404).json({ error: 'unknown check id' });
  if (!['done', 'timeout'].includes(row.status) || !row.report_path) {
    return res.status(409).json({ error: `report not ready (status=${row.status})` });
  }
  const dir = path.join(db.REPORTS_DIR, row.id);
  const abs = path.join(dir, path.basename(row.report_path));
  if (!abs.startsWith(dir + path.sep) || !fs.existsSync(abs)) {
    return res.status(404).json({ error: 'report file missing' });
  }
  res.type('html').send(fs.readFileSync(abs, 'utf8'));
});

// Minimal frontend (single static page).
app.use(express.static(path.join(__dirname, '..', 'web')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '..', 'web', 'index.html')));

app.use((req, res) => res.status(404).json({ error: 'not found' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[api]', err.message);
  res.status(500).json({ error: 'internal error' });
});

runner.start();
app.listen(PORT, () => console.log(`[api] fake-llm-checker listening on :${PORT}`));
