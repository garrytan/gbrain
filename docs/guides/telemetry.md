# Telemetry

gbrain sends no usage data unless you say yes. With no answer, or after
`gbrain telemetry off`, it writes no telemetry file and opens no connection.

## What you can turn on

| Tier | What is sent |
|---|---|
| `off` (default) | Nothing. |
| `anonymous` | Setup, upgrade and doctor results and daily counts, with no install id. |
| `community` | The same, plus a random install id, so a setup and a later upgrade on one machine can be linked. |

`GBRAIN_TELEMETRY=off` in the environment forces `off` whatever the setting says.

## What is sent, and what never is

Every event carries the gbrain version, OS, CPU architecture, Bun's major and
minor version, how gbrain was installed, the kind of brain (local PGLite, local
Postgres, a thin client of a hosted or self-hosted brain, or an HTTP server), and
whether the event came from a test, CI or a live install. Times are rounded down
to the hour.

- **setup:** which harness `gbrain setup` or `gbrain init` ran for, whether it
  worked, the error code if it failed, how long it took, and whether an embedding
  model is configured.
- **upgrade:** the old and new version and the release channel the first time a
  new version runs; the error code when an upgrade command fails.
- **doctor:** at most once a day, the health score as a band (`70-89`), up to 10
  failing check names, and the brain's page count as a band (`1k-9.9k`).
- **daily counts:** how often each gbrain command and MCP operation ran, which
  error codes were shown, and crash counts by JavaScript error class. Only names
  from gbrain's own command, operation and error-code lists are counted.

It never sends page names, slugs, titles, page text, queries, fact text, file
paths, source names, hostnames or error messages.

## Commands

```bash
gbrain telemetry            # what is on, what is queued, where it goes
gbrain telemetry show       # the exact JSON the next send would post, and the last sends
gbrain telemetry anonymous  # or: community
gbrain telemetry off        # stop and delete the local queue
gbrain telemetry forget     # delete this install's data on the server, then the local id
gbrain telemetry pulse      # the public aggregate of everyone's opt-in data
```

Add `--json` for one JSON document. `pulse` exits non-zero with
`telemetry_pulse_unavailable` when the aggregate is stale or unreachable, so a
script never reads an outage as "no problems". `forget` keeps the local id until
the server confirms the deletion (`telemetry_forget_failed` otherwise).

## How sending works

Events wait in `~/.gbrain/telemetry/` (under `GBRAIN_HOME` when set), with
file mode 0600. At most once every 6 hours a background process posts up to 100
events and 45,000 bytes, with a 10-second timeout, so no command waits on the
network. It never starts from a `--json` run, a hook or a server. A failed send
keeps the events for the next try; events older than 30 days are dropped.

Data goes to gbrain's own tables in the Supabase project gbrain shares with
gstack, through one validated endpoint. The publishable key in the code can call
that endpoint and the public aggregate, and cannot read or write any table.

`gbrain search stats` reads a different, local-only search log that is never
sent.
