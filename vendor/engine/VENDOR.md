# Vendored scan engine

- MIT-licensed open-source scan scripts (see `LICENSE` in this directory).
- Files: `scan.sh` (orchestrator), `check-api.sh`, `recon.sh`, `fingerprint.sh`,
  `extract-prompt.sh`.
- Display strings (banners, report titles, User-Agent) were rebranded to
  fake-llm-checker; the scan logic itself is unmodified.
- The wrapper in `../../src` shells out to `scan.sh` and parses its `#APISH ...`
  machine-readable summary lines — those are internal and intentionally kept
  byte-identical so the parser keeps working.
