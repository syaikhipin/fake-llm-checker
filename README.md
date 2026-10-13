# 🕵️ fake-llm-checker

A tiny SaaS that answers one question: **is that cheap LLM API endpoint you bought
actually serving the real model — or a masked substitute?**

It wraps an MIT-licensed open-source scan engine (vendored in `vendor/engine/`,
see `LICENSE` there) in a web service: submit an endpoint + key, get a verdict
(🟢 real / 🟡 unverified / 🟠 suspicious / 🔴 masked) plus the full HTML evidence report
the scan generates. 100% free stack: Node.js, SQLite, Docker — deployable
on Render's free tier.

## How it works

```
browser ──POST /api/checks──▶ Express API ──SQLite queue──▶ in-process runner
                                                        (1 scan at a time)
   ▲                                                        │
   └── poll GET /api/checks/:id ◀── verdict ───────────────┘
   └── GET  /api/checks/:id/report → upstream HTML report
```

- **Scans run strictly sequentially** (`MAX_CONCURRENT_SCANS=1`): the fingerprint
  module fires many API calls; this keeps it polite and cheap.
- **Your LLM key is never stored.** It lives in process memory only, is passed to
  the scan via env, and is deleted when the scan ends. A restart orphans queued
  jobs rather than persisting keys.
- **SSRF guard**: the target hostname must resolve to a public IP (no localhost,
  private ranges, or `169.254.x.x` metadata).
- **Rate limiting**: 60 requests/minute per IP, plus a cap on concurrent scans.
- **Provider choice**: the UI offers OpenAI-compatible vs Claude-compatible endpoints.
  Bases must end with `/v1` (e.g. `https://api.openai.com/v1`,
  `https://api.anthropic.com/v1`) — the UI adds it if forgotten and the engine
  enforces it; the checker then appends only `/chat/completions` or `/messages`.
  Zhipu bases (`.../paas/v4`) are the exception with no `/v1`.

## Quickstart (local, Docker)

```bash
docker compose up --build   # → http://localhost:3000
```

Or without Docker (needs node ≥ 22, bash, curl, openssl, python3):

```bash
npm install
DATA_DIR=./data npm start
```

## Free deploy (Render)

1. Push this repo to GitHub.
2. Render → New → Blueprint → point at the repo (`render.yaml`).
3. Open the service URL. Note: the free tier has no persistent disk, so SQLite
   results reset on redeploy — fine for a checker, documented limitation.

## API

| Method | Path | Notes |
|---|---|---|
| GET | `/healthz` | liveness probe |
| GET | `/` | web UI |
| POST | `/api/checks` | → `202 {id, pollUrl}` |
| GET | `/api/checks` | last 20 checks |
| GET | `/api/checks/:id` | status + verdict + signals (never the key) |
| GET | `/api/checks/:id/report` | upstream HTML evidence report |

`POST /api/checks` body:

```json
{
  "baseUrl": "https://cheap-api.example.com",
  "apiKey": "sk-the-key-you-bought",
  "model": "claude-opus-4-8",
  "level": "standard",
  "known": false
}
```

`level`: `quick` (behavioural probes only) · `standard` (default: + passive recon,
free) · `full` (+ model fingerprint + prompt extraction — slower, more API calls).
`known: true` if you use the gateway on purpose (judges malice only).

Example:

```bash
curl -s -H 'Content-Type: application/json' \
  -d '{"baseUrl":"https://api.z.ai/api/coding/paas/v4","apiKey":"sk-...","provider":"openai","level":"quick"}' \
  http://localhost:3000/api/checks
# → {"id":"...","status":"queued","pollUrl":"/api/checks/..."}
curl -s http://localhost:3000/api/checks/<id>
```

`provider` is `auto` (default) | `openai` | `anthropic`. The UI offers an
OpenAI-compatible / Claude choice. Bases carry a mandatory trailing `/v1`
(the UI adds it if missing; Zhipu `z.ai`/`bigmodel.cn` bases like
`.../paas/v4` are the exception with no `/v1`); the checker then appends only
`/chat/completions` (OpenAI-style) or `/messages` (Claude-style). Users never
type those paths — any pasted suffix is stripped.

## Dead keys don't produce verdicts

If the endpoint rejects the submitted LLM key (HTTP 401/403 on the first live
probe), the check is marked `inconclusive` with an explanatory error instead of
a verdict — otherwise the upstream heuristics would misread "auth failed" as
"rewritten API surface" and falsely report the model as unverified. Re-submit with a working key.

## Honest limits (inherited from upstream)

- A **passing score is not a safety certificate**: a proxy that forwards your
  prompt untouched while logging/reselling it is undetectable client-side.
- Model fingerprinting distinguishes tiers (junk vs frontier), not exact models.
- "Fraudulent behaviour" is a technical description of probe results, not a legal
  conclusion.

## Security notes for operators

- The scan spawns `bash` with a 10-minute kill timeout (`SCAN_TIMEOUT_MS`); the
  whole process group is SIGKILLed on timeout.
- Rate limit: 60 req/min per IP + cap on concurrent checks (`MAX_ACTIVE_CHECKS`).
- For production: put it behind TLS (Render/Caddy), add persistent storage, and
  consider envelope-encrypting keys if you ever need to survive restarts.

## Credits

Scan engine: MIT-licensed open-source scripts vendored under `vendor/engine/`
(display strings rebranded to fake-llm-checker; scan logic unmodified).
SaaS wrapper: MIT.
