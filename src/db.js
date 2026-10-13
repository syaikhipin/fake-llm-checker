// SQLite job store (node:sqlite — zero native deps).
// Deliberate: there is NO column for the user's LLM API key. Keys live only in
// the runner's in-memory map for the duration of a scan and are dropped after.
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const REPORTS_DIR = path.join(DATA_DIR, 'reports');
fs.mkdirSync(REPORTS_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'checks.sqlite'));
db.exec(`
CREATE TABLE IF NOT EXISTS checks (
  id            TEXT PRIMARY KEY,
  created_at    TEXT NOT NULL,
  started_at    TEXT,
  finished_at   TEXT,
  status        TEXT NOT NULL,   -- queued | running | done | error | timeout
  base_url      TEXT NOT NULL,
  model         TEXT,
  level         TEXT NOT NULL,   -- quick | standard | full
  price         REAL,
  tier          TEXT,
  known         INTEGER NOT NULL DEFAULT 0,
  verdict       TEXT,            -- real | unverified | suspicious | masked | inconclusive
  malice        INTEGER,
  interposed    INTEGER,
  recon_signals INTEGER,
  summary       TEXT,            -- JSON: { moduleVerdict, fingerprint }
  report_path   TEXT,            -- relative path under REPORTS_DIR
  error         TEXT
);
CREATE INDEX IF NOT EXISTS idx_checks_status ON checks(status, created_at);
`);

const now = () => new Date().toISOString();

const q = {
  create: db.prepare(`INSERT INTO checks
    (id, created_at, status, base_url, model, level, price, tier, known)
    VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?)`),
  claim: db.prepare(`
    UPDATE checks SET status='running', started_at=?
    WHERE id = (SELECT id FROM checks WHERE status='queued' ORDER BY created_at LIMIT 1)
    RETURNING *`),
  get: db.prepare(`SELECT * FROM checks WHERE id = ?`),
  active: db.prepare(`SELECT COUNT(*) AS n FROM checks WHERE status IN ('queued','running')`),
  finish: db.prepare(`UPDATE checks SET status=?, finished_at=?, verdict=?, malice=?,
    interposed=?, recon_signals=?, summary=?, report_path=?, error=? WHERE id = ?`),
  list: db.prepare(`SELECT id, created_at, finished_at, status, base_url, level, verdict
    FROM checks ORDER BY created_at DESC LIMIT 20`),
};

function publicRow(r) {
  if (!r) return null;
  // `interposed` is the engine's internal column name; the public API calls it `gateway`.
  const { summary, interposed, ...rest } = r;
  let parsed = null;
  try { parsed = summary ? JSON.parse(summary) : null; } catch { /* ignore */ }
  return {
    ...rest,
    gateway: interposed,
    summary: parsed,
    reportUrl: r.report_path ? `/api/checks/${r.id}/report` : null,
  };
}

module.exports = {
  REPORTS_DIR,
  create(id, { baseUrl, model, level, price, tier, known }) {
    q.create.run(id, now(), baseUrl, model || null, level, price ?? null, tier || null, known ? 1 : 0);
    return publicRow(q.get.get(id));
  },
  claimNext() { return q.claim.get(now()) || null; },
  get(id) { return publicRow(q.get.get(id)); },
  activeCount() { return q.active.get().n; },
  markRunning(id) {
    // claimNext already flips to running; kept for clarity in tests
  },
  finish(id, status, { verdict = null, malice = null, interposed = null,
      reconSignals = null, summary = null, reportPath = null, error = null } = {}) {
    q.finish.run(status, now(), verdict, malice, interposed, reconSignals,
      summary ? JSON.stringify(summary) : null, reportPath, error, id);
  },
  list() { return q.list.all().map(publicRow); },
};
