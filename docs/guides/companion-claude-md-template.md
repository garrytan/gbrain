# CLAUDE.md Template — gbrain-companion

Copy this into the root `CLAUDE.md` of your companion repo (e.g. gbrain-companion).
Adjust `GBRAIN_BASE`, auth, and src paths to match your setup.

---

```markdown
# CLAUDE.md — gbrain-companion

## Project goal

Browser automation harness that routes queries through Genspark (cost-optimized
multi-model web platform) and writes results back to the gbrain knowledge brain.

## Tech stack

- Runtime: Bun + TypeScript
- Browser: Playwright → Chrome (user's running instance)
- IPC: Unix socket daemon (client/daemon pattern)
- Brain: gbrain HTTP API at GBRAIN_BASE (see .env)

## Key files

- `src/daemon.ts` — background process, holds browser session, exposes socket
- `src/client.ts` — CLI client, sends queries to daemon via socket
- `src/driver.ts` — Genspark web driver (page nav, form submit, response extraction)
- `src/brain.ts` — gbrain HTTP client (search, put_page, verify)
- `.env` — GBRAIN_BASE, GBRAIN_OTP, GENSPARK_URL

## Architecture

```
client.ts  →  Unix socket  →  daemon.ts
                                  ↓
                            driver.ts (Playwright → Genspark)
                                  ↓
                            brain.ts  →  gbrain HTTP API
```

## Brain write rules

All writes go through `src/brain.ts`. Follow these rules:

1. Content ≤ 2000 chars → sync write (`PUT /page`, timeout 30s)
2. Content > 2000 chars → async write (`PUT /page?async=1`) + poll `GET /job`
3. Always include `idempotency_key` = first 8 hex chars of SHA-256(slug + content)
4. Verify with `GET /page?slug=...` + compare `content_hash` after write
5. Sleep 500ms between consecutive writes
6. Write leaf pages before index pages

## Brain search rules

Before sending any query to Genspark:
1. Search the brain: `GET /search?q=<keywords>`
2. If relevant results found, include them as context in the Genspark prompt
3. After Genspark responds, write the Q&A to `mem/YYYY-MM-DD/<slug>`

## Auth

The gbrain HTTP server uses daily OTP (GBRAIN_TOTP_SECRET) or static token
(GBRAIN_HTTP_TOKEN). The daemon reads from `.env` and injects the correct
auth param on every request. Never hardcode OTP values — regenerate daily.

## Testing

```bash
bun test              # unit tests
bun run test:e2e      # integration tests (requires gbrain daemon running)
```

## Do not

- Do not launch a new Chrome instance — connect to the user's running one
- Do not store session cookies in source code
- Do not write pages > 4000 chars — split into sub-pages first
- Do not retry blindly on timeout — verify with GET /page first
```
