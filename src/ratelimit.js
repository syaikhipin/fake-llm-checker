// Tiny in-memory rate limiter: per-IP request cap. Resets are approximate;
// good enough for a free-tier scaffold (use Redis for multi-instance prod).
const hits = new Map();
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 60;

function rateLimit(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  let h = hits.get(ip);
  if (!h || h.reset < now) { h = { count: 0, reset: now + WINDOW_MS }; hits.set(ip, h); }
  h.count += 1;
  if (h.count > MAX_PER_WINDOW) {
    return res.status(429).json({ error: 'rate limited: slow down' });
  }
  next();
}

module.exports = { rateLimit };
