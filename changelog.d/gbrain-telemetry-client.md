**gbrain can now send opt-in usage telemetry, off until you choose a tier with `gbrain telemetry anonymous` or `gbrain telemetry community`.**

### Added
- `gbrain telemetry` shows what is on, what is queued and where it goes. `gbrain telemetry show` prints the exact JSON the next send would post. `gbrain telemetry off` stops sending and deletes the local queue, and `GBRAIN_TELEMETRY=off` in the environment forces it off whatever the setting says.
- With no answer gbrain writes no telemetry file and opens no connection. `anonymous` sends setup, upgrade and doctor results and daily command, error-code and crash counts with no install id. `community` adds a random install id, so a setup and a later upgrade on one machine can be linked.
- Only names from gbrain's own command, operation and error-code lists are counted. Page names, slugs, titles, page text, queries, file paths, source names, hostnames and error messages are never sent.
- Events wait in `~/.gbrain/telemetry/` with file mode 0600. A background process sends at most every 6 hours, never from a `--json` run, a hook or a server, so no command waits on the network. Events older than 30 days are dropped.
- `gbrain telemetry forget` deletes this install's data on the server, then the local install id and queue. The id is kept until the server confirms the deletion (`telemetry_forget_failed` otherwise, also while a send is in progress).
- `gbrain telemetry pulse` shows the public aggregate of everyone's opt-in data, and exits non-zero with `telemetry_pulse_unavailable` when it is stale or unreachable, so a script never reads an outage as "no problems".
- A `.env` file in the current directory cannot set `GBRAIN_TELEMETRY_URL` or `GBRAIN_TELEMETRY_KEY`, so a repository cannot redirect where telemetry goes.

Full detail: docs/guides/telemetry.md.
