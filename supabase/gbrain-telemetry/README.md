# gbrain telemetry backend

gbrain's opt-in telemetry lands here: two Supabase edge functions and the SQL behind them, in the Supabase project gbrain shares with gstack. gbrain owns everything in this folder. gstack's own telemetry objects are never touched, joined or read, and nothing of gstack's reads these.

| File | What it is |
|---|---|
| `src/core/telemetry/enums.json` (in gbrain's source, so the client ships it) | Every fixed list a field is checked against. The client, the ingest function and the SQL CHECKs use the same lists; `test/gbrain-telemetry-backend.test.ts` fails when they differ. |
| `migrations/G001_gbrain_telemetry.sql` | Tables, the live view, the pulse summary, forget, prune and the daily ceiling. G-numbered so these files never collide with gstack's `001`-`009`. |
| `functions/gbrain-telemetry-ingest/` | The only write path. `validate.ts` checks every field (gbrain's tests import it); `index.ts` enforces the daily ceiling (15,000 accepted requests and 150,000 rows a UTC day; 429 above it) and handles `forget`. |
| `functions/gbrain-telemetry-pulse/` | Public aggregates, cached an hour; a stale answer or 503 on error, never zeros. |
| `verify.sh` | Smoke test: the public key and signed-in users are refused everything, the ingest stores one `source=test` event and the pulse answers. |

## Who can do what

- The publishable (anon) key the client sends can't read or write any table, view or function here: RLS is on with no policies and every privilege is revoked from `anon` and `authenticated`.
- Only `service_role`, which the two functions hold in their own environment, reads and writes.
- The pulse is public by design: counts only, no installation id. A cell crossed with brain size needs 5 distinct community installs, which stops a casual reader from singling out one install but can't stop a caller who invents ids.
- Every row is an unauthenticated report, so the pulse is a lead to check, not proof, for anyone reading it (the severe sweep included). Its per-version lists cover 10 versions (the newest release always, then the most-reported), and one report's count for any command or error code is capped at 10,000.

## The daily ceiling

Clients send at most one request per install every 6 hours, so 15,000 accepted requests a day covers about 3,700 opted-in installs (about 450,000 a month). With gstack's traffic (about 310,000 invocations a month on 2026-11-22) that stays under half of the Pro plan's 2 million monthly invocations. The ceiling caps what lands in the tables. It can't cap what a caller sends: Supabase counts an invocation before the function runs, so a flood still spends invocations even when every request gets a 429.

The ceiling is one bucket shared by every caller, so one caller can fill it. The pulse reports the requests refused in its 7 days as `ceiling_refusals`, so a full day reads as missing data rather than a quiet one. Per-caller limits would mean storing caller addresses, which this design doesn't do.

## Applying it

**Don't deploy until the forget withdrawal marker ships.** Two known gaps have to be fixed in a follow-up first, and until that lands nobody should deploy these functions or be asked to turn telemetry on:

- `gbrain telemetry forget` can race an ingest that is still running. If the client gives up waiting but the server finishes the insert afterwards, a forgotten install's record can come back. The fix is a withdrawal marker that forget writes and the ingest checks.
- Commands that end through `process.exit` record nothing, which covers most `gbrain init` failures and failed upgrade migrations, so setup success would read too high. The fix is recording the outcome from the exit path too.

Every other P1 item in the telemetry section of `TODOS.md` blocks deployment the same way.

1. Apply `migrations/G001_gbrain_telemetry.sql` as the project owner (psql or the dashboard SQL editor). It runs in one transaction and is safe to run twice.
2. Deploy both functions with JWT verification off (`supabase functions deploy gbrain-telemetry-ingest --no-verify-jwt` and the same for `gbrain-telemetry-pulse`, or paste each `index.ts` into the dashboard editor and turn off "Enforce JWT verification"; each file is self-contained). The client sends only the publishable key in an `apikey` header, which is not a JWT, so with verification on every request is refused with 401 before the function runs.
3. Run `GBRAIN_TELEMETRY_URL=… GBRAIN_TELEMETRY_KEY=… GBRAIN_VERIFY_AUTH_JWT=… bash supabase/gbrain-telemetry/verify.sh` with a signed-in user's JWT and keep its `VERDICT:` line. Without the JWT the signed-in checks are skipped and it ends `INCOMPLETE` with exit 2. It reads both secrets from the environment and never puts them on a command line.
4. Retention: run `select public.gbrain_telemetry_prune();` daily. Where pg_cron is enabled: `select cron.schedule('gbrain-telemetry-prune', '17 4 * * *', 'select public.gbrain_telemetry_prune()');` Otherwise run it by hand at least monthly.

## Changing it

A new field or list value is a new `G00N` file plus the same change in `src/core/telemetry/enums.json` and its copy in the ingest's `validate.ts`. Deploy order: migration, then the ingest, then the client release. An older ingest drops keys it doesn't know, so clients are safe in any order.
