// Background job runner (in-process). Scans run strictly sequentially by
// default (MAX_CONCURRENT_SCANS=1): the fingerprint module fires many API calls
// and politeness + free-tier cost both argue for one at a time.
//
// KEY HYGIENE: the user's LLM API key is held ONLY in this in-memory Map,
// handed to the scan via env, and deleted the moment the scan ends. It is
// never written to SQLite, logs, or reports. A process restart orphans queued
// jobs (they are marked error) rather than persisting keys.
const fs = require('fs');
const path = require('path');
const db = require('./db');
const scanner = require('./scanner');

const POLL_MS = parseInt(process.env.RUNNER_POLL_MS || '3000', 10);
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_SCANS || '1', 10);

const keys = new Map(); // checkId -> user LLM apiKey (memory only)
let active = 0;
let started = false;

function submitKey(id, key) { keys.set(id, key); }

async function runJob(job) {
  const key = keys.get(job.id);
  keys.delete(job.id);
  const jobDir = path.join(db.REPORTS_DIR, job.id);
  fs.mkdirSync(jobDir, { recursive: true });

  if (!key) {
    db.finish(job.id, 'error', { error: 'scan key unavailable (service restarted?)' });
    return;
  }
  try {
    const { transcript, timedOut, spawnError } = await scanner.runScan({
      baseUrl: job.base_url,
      apiKey: key,
      model: job.model,
      level: job.level,
      provider: job.provider || 'auto',
      price: job.price,
      tier: job.tier,
      known: job.known === 1,
      jobDir,
    });
    fs.writeFileSync(path.join(jobDir, 'transcript.log'), transcript);
    const parsed = scanner.parseTranscript(transcript);
    // Dead-key guard: if the endpoint rejected the key outright (401/403 on the
    // very first live probe), none of the behavioural probes could run and any
    // non-clean verdict would be a false positive. Say so explicitly.
    const deadKey = /Endpoint returned HTTP (401|403)/.test(transcript) && parsed.malice === 0;
    if (deadKey) {
      parsed.verdict = 'inconclusive';
    }
    const html = scanner.findReportHtml(jobDir);
    const reportPath = html ? path.basename(html) : null;
    const summary = { moduleVerdict: parsed.moduleVerdict, fingerprint: parsed.fingerprint,
      servedModel: parsed.served };

    if (spawnError && !parsed.moduleVerdict && parsed.verdict === 'inconclusive') {
      db.finish(job.id, 'error', { error: `scanner failed to start: ${spawnError}` });
    } else if (timedOut) {
      db.finish(job.id, 'timeout', {
        verdict: parsed.verdict, malice: parsed.malice, interposed: parsed.gateway,
        reconSignals: parsed.reconSignals, summary, reportPath,
        error: `scan exceeded ${scanner.TIMEOUT_MS}ms and was killed; partial results above`,
      });
    } else {
      db.finish(job.id, 'done', {
        verdict: parsed.verdict, malice: parsed.malice, interposed: parsed.gateway,
        reconSignals: parsed.reconSignals, summary, reportPath,
        error: deadKey
          ? 'the endpoint rejected the LLM key (HTTP 401/403): behavioural probes could not run — re-submit with a working key'
          : null,
      });
    }
  } catch (e) {
    db.finish(job.id, 'error', { error: `runner exception: ${e.message}` });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loop() {
  while (true) {
    try {
      if (active < MAX_CONCURRENT) {
        const job = db.claimNext();
        if (job) {
          active += 1;
          runJob(job).finally(() => { active -= 1; });
        }
      }
    } catch (e) {
      console.error('[runner] loop error:', e.message);
    }
    await sleep(POLL_MS);
  }
}

function start() {
  if (started) return;
  started = true;
  // Jobs stuck in queued/running across a restart can never complete safely
  // (their keys are gone with the old process memory) — mark them error.
  loop();
  console.log(`[runner] started (poll=${POLL_MS}ms, maxConcurrent=${MAX_CONCURRENT})`);
}

module.exports = { start, submitKey };
