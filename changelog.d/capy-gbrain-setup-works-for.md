**`gbrain setup hermes` works when HERMES_HOME is set, and `gbrain setup openclaw` reads an openclaw.json with comments.**

### Fixed
- `gbrain setup hermes` no longer exits 1 with `turn_hook_not_loaded` when HERMES_HOME points somewhere other than ~/.hermes. The install check now runs `hermes hooks doctor` with HERMES_HOME, so it reads the config setup just wrote. The OpenClaw check (`openclaw plugins inspect`) gets OPENCLAW_HOME, OPENCLAW_STATE_DIR, OPENCLAW_CONFIG_PATH and OPENCLAW_PROFILE the same way, a relative path in any of them is resolved first, and the check still never sees provider keys. With OPENCLAW_HOME set, `gbrain setup openclaw` now writes under `$OPENCLAW_HOME/.openclaw`, where OpenClaw reads, instead of `~/.openclaw`.
- `gbrain setup openclaw` no longer exits 2 with `invalid_params` on an openclaw.json that has a `//` or `/* */` comment above a bare key. Comments, trailing commas, single-quoted strings, a raw tab inside a string, CR-only line endings and `//` inside a string value all read correctly now.

### Changed
- `gbrain connect`, `gbrain doctor` and `gbrain hook` no longer accept `--instructions`, a flag none of them reads (it was listed for them by mistake). `gbrain setup <harness> --instructions` is unchanged.
