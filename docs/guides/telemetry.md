# Telemetry

gbrain sends no usage data unless you say yes. After `gbrain telemetry off`, or
with `GBRAIN_TELEMETRY=off`, it writes no telemetry file and sends nothing in the
background. The only connections it makes then are the ones you ask for with
`gbrain telemetry pulse` and `gbrain telemetry forget`, and only when a telemetry
address is set.

**This release sends nothing by default.** It ships no telemetry address, so
setup doesn't ask and any telemetry choice stays on your machine. To test a
server, set `GBRAIN_TELEMETRY_URL` in your own environment and supply its
publishable key in `GBRAIN_TELEMETRY_KEY` if it needs one. A `.env` file in the
current directory cannot set either. The question appears when an address is
configured and you haven't answered yet.

## The question

When `gbrain init` creates a brain (on its own or through `gbrain setup <harness>`),
it tells your agent to ask you, in the reply that reports the install, whether gbrain may send usage
data. No option is marked recommended, and the agent is told never to pick one
for you; `--yes`, `--json` and unattended runs never answer it. Your answer is
the command the agent runs for you: `gbrain telemetry anonymous`, `community` or
`off`.

Until you answer, gbrain keeps setup and upgrade results only on your machine,
in `~/.gbrain/telemetry/pending.jsonl` (at most 50, for 7 days). A yes moves them
into the send queue; `off` deletes them. Nothing else is kept before an answer.
A brain created before this question existed is not asked; answer any time with
the same commands, and anything it holds expires unsent after 7 days.

## What you can turn on

| Tier | What is sent |
|---|---|
| `off` (default) | Nothing. |
| `anonymous` | Setup, upgrade and doctor results and daily counts, with no install id. |
| `community` | The same, plus a random install id, so a setup and a later upgrade on one machine can be linked. |

`GBRAIN_TELEMETRY=off` in the environment forces `off` whatever the setting says,
with one known gap listed in the deployment blockers: a `.env` file in the current
directory that sets `GBRAIN_TELEMETRY` also drops an exported
`GBRAIN_TELEMETRY=off`, so the saved answer applies there.

## What is sent, and what never is

Every event carries the gbrain version, OS, CPU architecture, Bun's major and
minor version, how gbrain was installed, the kind of brain (local PGLite, local
Postgres, a thin client of a hosted or self-hosted brain, or an HTTP server), and
whether the event came from a test, CI or a live install (`GBRAIN_TELEMETRY_SOURCE`
can label it `eval`, `capy` or `other` instead). Times are rounded down to the
hour.

- **consent:** your answer (`anonymous` or `community`), once, when you turn it on.
- **setup:** which harness `gbrain setup` or `gbrain init` ran for, whether it
  worked, the error code if it failed, how long it took, and whether an embedding
  model is configured.
- **upgrade:** the old and new version and the release channel the first time a
  new version runs; the error code when an upgrade command fails.
- **doctor:** only a full `gbrain doctor` run (not `--only`, `--fast`,
  `--scope brain` or `--tier ops`), at most once a day, the health score as a band (`70-89`), up to 10
  failing check names, and the brain's page count as a band (`1k-9.9k`).
- **daily counts:** how often each gbrain command and MCP operation ran, which
  error codes were shown, and crash counts by JavaScript error class. Only names
  from gbrain's own command, operation and error-code lists are counted.

It never sends page names, slugs, titles, page text, queries, fact text, file
paths, source names, hostnames or error messages.

## Commands

```bash
gbrain telemetry            # what is on, what is queued or waiting, where it goes
gbrain telemetry status     # same as gbrain telemetry with no subcommand
gbrain telemetry show       # what waits for your answer, the exact JSON the next send would post, and the last sends
gbrain telemetry anonymous  # or: community
gbrain telemetry off        # stop and delete the local queue and anything waiting
gbrain telemetry forget     # delete this install's record on the server and unlink its events, then the local id and queue
gbrain telemetry pulse      # the public aggregate of everyone's opt-in data
gbrain telemetry sync       # send now instead of waiting (--force skips the 6-hour window)
```

Add `--json` for one JSON document. `pulse` exits non-zero with
`telemetry_pulse_unavailable` when the aggregate is stale or unreachable, so a
script never reads an outage as "no problems". `forget` asks the server to delete
this install's record and unlink its stored events from the id; the events stay
as anonymous rows until they expire. It keeps the local id until
the server confirms the deletion (`telemetry_forget_failed` otherwise, also
while a send is in progress), then deletes the local queue so nothing recorded
under the old id goes out under a new one. It leaves your tier as it was:
`gbrain telemetry off` turns off reporting. At any tier, `pulse` can contact a
configured server, and `forget` can too if a local install id exists. With no
local id, `forget` returns `no_id` without a request. The human-readable
`show` output summarizes recent sends; use `show --json` for their payloads.

## Known limits

The server side is not deployed yet. The [telemetry deployment blockers](../../TODOS.md#opt-in-telemetry-client-follow-ups-filed-2026-11-22-telemetry-pr-2)
must be fixed first. Among them, a send still finishing on the
server can bring back a record `forget` just deleted, an opt-out that lands while a
send is starting can still let that one batch go, and `pulse` exits 0 on an
answer that carries no data.

## How sending works

Events wait in `~/.gbrain/telemetry/` (under `GBRAIN_HOME` when set), with
file mode 0600. At most once every 6 hours a background process posts up to 100
events and 45,000 bytes, with a 10-second timeout, so no command waits on the
network. It never starts from a `--json` run, a hook or a server. A send that
hits a 429, a server error or no connection keeps the events for the next try;
a batch the server refuses with any other 4xx is dropped on the third such
refusal.
Events older than 30 days are dropped. The server keeps stored events for 400
days.

Data goes to gbrain's own tables in the Supabase project gbrain shares with
gstack, through one validated endpoint. The publishable key the client sends can
call that endpoint and the public aggregate, and cannot read or write any table.

`gbrain search stats` reads a different, local-only search log that is never
sent.

For server-side setup and rollout checks, see the [telemetry backend runbook](../../supabase/gbrain-telemetry/README.md).
