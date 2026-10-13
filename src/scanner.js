// Runs the vendored scan-engine orchestrator for one job and parses its
// machine-readable summary lines (#APISH ...) plus the VERDICT banner.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const SCRIPT = path.join(__dirname, '..', 'vendor', 'engine', 'scan.sh');
const TIMEOUT_MS = parseInt(process.env.SCAN_TIMEOUT_MS || '600000', 10); // 10 min default

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

function parseTranscript(text) {
  const t = stripAnsi(String(text || ''));
  const out = {
    verdict: 'inconclusive',
    moduleVerdict: null,
    malice: null,
    gateway: null,
    reconSignals: null,
    fingerprint: null,
  };
  let m = t.match(/^#\s*VERDICT:\s*(.+)$/m);
  if (m) {
    const v = m[1];
    if (/MASKED MODEL/.test(v)) out.verdict = 'masked';
    else if (/POSSIBLY MASKED/.test(v)) out.verdict = 'suspicious';
    else if (/MODEL UNVERIFIED/.test(v)) out.verdict = 'unverified';
    else if (/REAL MODEL/.test(v)) out.verdict = 'real';
  }
  // #APISH machine line keeps the engine's internal vocabulary; translate here.
  m = t.match(/^#APISH check verdict=(\w+)\s+malice=(\d+)\s+interposed=(\d+)/m);
  if (m) {
    out.moduleVerdict = { fraud: 'masked', interposed: 'unverified', clean: 'real' }[m[1]] || m[1];
    out.malice = +m[2]; out.gateway = +m[3];
  }
  m = t.match(/^#APISH recon signals=(\d+)/m);
  if (m) out.reconSignals = +m[1];
  m = t.match(/^#APISH fingerprint pass=(\d+)\s+tot=(\d+)\s+blocked=(\d+)\s+foreign=(\d+)\s+pool=(\d+)\s+leak=(\d+)/m);
  if (m) out.fingerprint = { pass: +m[1], tot: +m[2], blocked: +m[3], foreign: +m[4], pool: +m[5], leak: +m[6] };
  return out;
}

function findReportHtml(jobDir) {
  try {
    const f = fs.readdirSync(jobDir).find((n) => n.endsWith('.html') && n.startsWith('fake-llm-checker-'));
    return f ? path.join(jobDir, f) : null;
  } catch { return null; }
}

// The user's LLM key travels via env (ANTHROPIC_API_KEY fallback in the script),
// never as argv, so it doesn't show in `ps` listings. It is dropped from memory
// by the runner as soon as the scan ends.
function runScan({ baseUrl, apiKey, model, level, provider, price, tier, known, jobDir }) {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      ANTHROPIC_API_KEY: apiKey,
      // Explicit provider choice overrides the engine's auto-detection.
      ...(provider && provider !== 'auto' ? { PROVIDER: provider } : {}),
      OUTDIR: jobDir,
      QUICK: level === 'quick' ? '1' : '0',
      FULL: level === 'full' ? '1' : '0',
      PRICE: String(price || 0),
      TIER: tier || 'opus',
      KNOWN: known ? '1' : '0',
    };
    const args = [SCRIPT, baseUrl, '', model || ''];
    const child = spawn('bash', args, { env, cwd: jobDir, detached: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
      resolve({ transcript: out, timedOut: true });
    }, TIMEOUT_MS);
    child.on('close', () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ transcript: out, timedOut: false });
    });
    child.on('error', (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ transcript: out + `\n[runner] spawn error: ${e.message}`, timedOut: false, spawnError: e.message });
    });
  });
}

module.exports = { runScan, parseTranscript, findReportHtml, TIMEOUT_MS };
