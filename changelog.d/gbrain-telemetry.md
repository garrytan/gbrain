**gbrain has an opt-in usage-data command, `gbrain telemetry`, and this release sends nothing: it ships no address to send to yet, so setup asks nothing and any choice stays on your machine. The release that deploys the server side turns the question on.**

<!-- behavior-change: opt_in_telemetry_sends_nothing_yet -->

### Added
- Once a release ships the telemetry address, `gbrain init` and `gbrain setup <harness>` add a usage-data question to the settings your agent relays after the install. No option is marked recommended, nothing is chosen by default, and the agent is told to ask you and never answer for you; `--yes`, `--json` and unattended runs never answer it. Your answer is the command the agent runs: `gbrain telemetry anonymous`, `community` or `off`.
- `anonymous` sends setup, upgrade and doctor results and daily command, error-code and crash counts with no install id. `community` adds a random install id, so a setup and a later upgrade on one machine can be linked.
- Before you answer, nothing is sent and no connection is opened. Setup, init and failed-upgrade results wait only on your machine, in `~/.gbrain/telemetry/pending.jsonl` (at most 50, for 7 days), and only once a gbrain home exists. A yes moves them into the send queue; `off` deletes them. `GBRAIN_TELEMETRY=off` in the environment keeps nothing at all and forces sending off whatever the setting says.
- `gbrain telemetry` shows what is on, what is queued, what is waiting for your answer and where it goes. `gbrain telemetry show` prints the exact JSON the next send would post. `gbrain telemetry off` stops sending and deletes the local queue.
- Only names from gbrain's own command, operation and error-code lists are counted. Page names, slugs, titles, page text, queries, file paths, source names, hostnames and error messages are never sent.
- Events wait in `~/.gbrain/telemetry/` with file mode 0600. A background process sends at most every 6 hours, never from a `--json` run, a hook or a server, so no command waits on the network. Events older than 30 days are dropped.
- `gbrain telemetry forget` deletes this install's record on the server and unlinks its stored events from the id (they stay only as anonymous rows), then deletes the local install id and queue. The id is kept until the server confirms the deletion (`telemetry_forget_failed` otherwise, also while a send is in progress).
- `gbrain telemetry pulse` shows the public aggregate of everyone's opt-in data, and exits non-zero with `telemetry_pulse_unavailable` when it is stale or unreachable, so a script never reads an outage as "no problems".
- A `.env` file in the current directory cannot set `GBRAIN_TELEMETRY_URL` or `GBRAIN_TELEMETRY_KEY`, so a repository cannot redirect where telemetry goes.
- `supabase/gbrain-telemetry/` holds the server side: its own tables and two functions in a shared Supabase project. The public key that ships with gbrain can read and write nothing; every table is row-level locked with no policies, and only the ingest function writes.
- The ingest function checks every field against fixed lists and drops anything else, so free text never reaches a table. It accepts at most 15,000 requests and 150,000 rows a UTC day and answers 429 above that. `forget` stays outside that limit, so a flood can't block a user's withdrawal.
- The pulse function publishes counts only, cached for an hour. It always includes the newest release, ignores versions newer than the latest release, and answers stale or 503 instead of zeros when it can't compute. `verify.sh` checks a deployment end to end.

- Nothing recorded under one answer goes out under another: switching between `anonymous` and `community` deletes what was queued, `off` and `forget` also delete the record of past sends, and a send or count still in flight when you change your answer is dropped. Daily counts carry the gbrain version that counted them, and only a full `gbrain doctor` run is reported (not `--only`, `--fast`, `--scope brain` or `--tier ops`).
- `gbrain telemetry` takes exactly one subcommand, so `gbrain telemetry community off` is refused instead of turning telemetry on.

### Changed
- README has a "Privacy & telemetry" section, and docs/guides/telemetry.md explains every tier, the question and the waiting file.
