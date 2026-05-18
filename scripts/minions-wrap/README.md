# minions-wrap/

Each script wraps a cron job in `gbrain jobs submit shell --follow` so the
work runs through the Minions queue instead of directly from launchd.

**Benefit over plain launchd**: retry (`--max-attempts`), timeout (`--timeout-ms`),
unified `gbrain jobs list` visibility, audit trail at `~/.gbrain/audit/`.

**PGLite constraint**: We can't run `gbrain jobs work` as a daemon (exclusive
file lock). Instead each launchd tick calls `--follow` to execute inline.

**Env handling**: Minions' shell handler whitelists only `PATH/HOME/USER/LANG/TZ/NODE_ENV`.
API keys and other secrets are sourced *inside* the shell command by
`. ./.env.local` (within the worktree root), so nothing sensitive flows
through `--params`.

## Scripts

- `notion-poller.sh` — 5-min Notion delta sync (was `com.jarvis.notion-poller`)
- `kos-patrol.sh` — daily brain-health patrol (was `com.jarvis.kos-patrol`)
- `enrich-sweep.sh` — weekly entity extraction (was `com.jarvis.enrich-sweep`)
- ~~`kos-deep-lint.sh`~~ — **RETIRED 2026-05-17** (§6.28 follow-up; v1 KOS lint target was a never-fired zombie since M1 — `launchctl run count = 0` over 5 months. Script + plist moved to `scripts/launchd/_archived/`)
