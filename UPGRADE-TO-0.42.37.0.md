# Upgrade gbrain to 0.42.37.0 — MacBook steps

This upgrades gbrain from the old fork (0.41.26.1) to **upstream 0.42.37.0 + GBRAIN_SOURCES**.
It fixes the dream-cycle "connect() has not been called" bug and catches you up on 49 upstream fixes.

## ⚠️ Order matters — do the VPS (openclaw) upgrade FIRST

The shared Supabase DB gets migrated (v109 → v115) during the **VPS** step. Only run these Mac
steps **after** the VPS upgrade + migration is done. Otherwise the DB schema won't match.

## Mac steps (paste into a terminal, one block)

```bash
# 1. Go to your gbrain clone (adjust path if different)
cd ~/dev/gbrain 2>/dev/null || cd ~/dev/dbrain

# 2. Get the upgrade branch
git fetch origin
git checkout upgrade-0.42.37.0
git pull --ff-only origin upgrade-0.42.37.0

# 3. Install deps + build the new binary
#    (the postinstall "apply-migrations" line may print an error — ignore it, it's cosmetic)
bun install
BIN="$(which gbrain)"
bun build --compile --outfile "$BIN" src/cli.ts

# 4. Confirm the version
gbrain --version            # must show 0.42.37.0
```

## 5. Restart Claude Code on the Mac

Quit and reopen Claude Code so its gbrain MCP picks up the new binary.

## 6. Verify

In Claude Code, ask it to find a known page across sources, e.g.:

> find the academics daily transcript from feb 16

If it returns the page, you're done — the new binary works **and** multi-source access
(`GBRAIN_SOURCES`) still works.

## Notes

- **`GBRAIN_SOURCES` in `~/.claude.json` is unchanged and still required** — it's the one fork
  feature we kept. Don't remove it.
- Nothing else on the Mac changes. Your `~/.gbrain/config.json` (Supabase URL, OpenAI key,
  embedding model) stays exactly as-is.
- Once upstream PR #2014 merges, you can switch to plain `garrytan/gbrain` and drop the fork
  entirely. Until then, this `upgrade-0.42.37.0` branch is your basis.
