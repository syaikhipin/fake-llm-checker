# Vendored upstream

- Source: https://github.com/astrozeta/api-scam-hunter
- Commit vendored: `e366378` (2026-10-13)
- License: MIT (see `LICENSE` in this directory) — Copyright (c) 2026 astrozeta
- Files taken: `scripts/*.sh` (recon, check-api, fingerprint, extract-prompt,
  apiscamhunter orchestrator). Unmodified.

The SaaS wrapper in `../../src` shells out to `apiscamhunter.sh` and parses its
`#APISH ...` summary lines. To update: re-copy `scripts/*.sh` from upstream and
bump the commit hash above.
