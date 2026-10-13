// Service-level API key auth (x-api-key header). The key itself is never logged;
// only its sha256 is compared, in constant time.
const crypto = require('crypto');

const sha256hex = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

const RAW = process.env.SERVICE_API_KEY || '';
if (!RAW) {
  console.error('FATAL: SERVICE_API_KEY is not set. Refusing to start.');
  process.exit(1);
}
const EXPECTED = Buffer.from(sha256hex(RAW));

function auth(req, res, next) {
  const got = req.get('x-api-key') || '';
  if (!got) return res.status(401).json({ error: 'unauthorized: missing x-api-key' });
  const a = Buffer.from(sha256hex(got));
  if (a.length !== EXPECTED.length || !crypto.timingSafeEqual(a, EXPECTED)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

module.exports = { auth };
