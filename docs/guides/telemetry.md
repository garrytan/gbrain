# Telemetry

gbrain sends no usage data unless you say yes. After `gbrain telemetry off`, or
with `GBRAIN_TELEMETRY=off`, it writes no telemetry file and opens no connection.

**This release sends nothing at all.** It ships no address to send to, because
the server side is not deployed yet, so setup asks you nothing and any choice you
make with `gbrain telemetry` stays on your machine. The release that deploys the
server turns the question on; this page describes how it works from then on.

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

`GBRAIN_TELEMETRY=off` in the environment forces `off` whatever the setting says.

## What is sent, and what never is

Every event carries the gbrain version, OS, CPU architecture, Bun's major and
minor version, how gbrain was installed, the kind of brain (local PGLite, local
Postgres, a thin client of a hosted or self-hosted brain, or an HTTP server), and
whether the event came from a test, CI or a live install (`GBRAIN_TELEMETRY_SOURCE`
can label it `eval`, `capy` or `other` instead). Times are rounded down to the
hour.

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
gbrain telemetry show       # what waits for your answer, the exact JSON the next send would post, and the last sends
gbrain telemetry anonymous  # or: community
gbrain telemetry off        # stop and delete the local queue and anything waiting
gbrain telemetry forget     # delete this install's record on the server and unlink its events, then the local id and queue
gbrain telemetry pulse      # the public aggregate of everyone's opt-in data
gbrain telemetry sync       # send now instead of waiting (--force skips the 6-hour window)
```

Add `--json` for one JSON document. `pulse` exits non-zero with
`telemetry_pulse_unavailable` when the aggregate is stale or unreachable, so a
script never reads an outage as "no problems". `forget` keeps the local id until
the server confirms the deletion (`telemetry_forget_failed` otherwise, also
while a send is in progress), then deletes the local queue so nothing recorded
under the old id goes out under a new one. It leaves your tier as it was:
`gbrain telemetry off` stops sending.

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
