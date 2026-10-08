# Connect GBrain to pi

> This page wires a finished brain into **pi** (`@earendil-works/pi-coding-agent`,
> the `pi` terminal coding agent). For the brain install itself — CLI, engine,
> skills — follow [INSTALL_FOR_AGENTS.md](../../INSTALL_FOR_AGENTS.md) first.

pi gets two things from gbrain:

1. **Memory tools** through an MCP server entry in pi's user config
   (`~/.pi/agent/mcp.json`).
2. **Lifecycle hooks** — per-turn brain context, the writeback backstop,
   compaction banking and session capture — through a gbrain-owned pi
   **extension** (`~/.pi/agent/extensions/gbrain-hooks.ts`). pi has no
   shell-hook config; its lifecycle surface is the extension API, so the
   extension is the hook registration.

Both are user-global (pi has no per-workspace hook scope) and need no agent
workspace.

**Say to your agent:** *"Connect my brain to pi."*
**Say to your agent:** *"Is gbrain wired into pi correctly?"*
**Say to your agent:** *"Remove gbrain from pi."*

## Install

```bash
gbrain bootstrap hooks --harness pi
```

This writes:

- `~/.pi/agent/extensions/gbrain-hooks.ts`, rendered with the absolute path of
  your `gbrain` binary. Line 1 carries the marker `gbrain:pi-hooks-v1`; gbrain
  only ever rewrites or deletes a file that carries it. A different file at
  that path (for example a hand-made bridge) is reported and left alone —
  move it aside first, because pi loads every file in that directory and two
  bridges would fire every hook twice.
- `mcpServers.gbrain` in `~/.pi/agent/mcp.json` — a stdio `gbrain serve
  --surface starter` entry by default. Its `description` marks it as
  gbrain-managed. Other servers and keys in the file are preserved. An
  existing `gbrain` entry that gbrain did not write is **kept** (it already
  provides the tools) and the run still succeeds.

Restart pi (or run `/reload`) to load the extension. Run from inside pi with no
`--harness`, `gbrain bootstrap hooks` picks the pi lane itself (pi sets
`PI_CODING_AGENT=true`).

Options:

| Flag | Effect |
| --- | --- |
| `--source ID` | Bind hooks and the stdio MCP entry to one source (`GBRAIN_SOURCE`). Default: the serve's own source. |
| `--seat LABEL` | Credit captured sessions to this agent seat (`GBRAIN_SEAT`). |
| `--url U` | Write an HTTP MCP entry for a running `gbrain serve --http` instead of stdio. |
| `--mcp-auth-command CMD` | With `--url`: the `Authorization` header becomes pi's whole-value `!CMD` form, so the bearer stays out of the file. |
| `--surface verbs\|starter\|full` | MCP tool surface for the stdio entry (default `starter`). |
| `--no-hooks` / `--no-mcp` | Skip one of the two carriers. |
| `--gbrain-bin PATH` | Absolute binary to render (default: `gbrain` on PATH). |
| `--json` | Machine-readable result. |

A shared HTTP serve with a Keychain-held bearer:

```bash
gbrain bootstrap hooks --harness pi \
  --url http://127.0.0.1:3131/mcp \
  --mcp-auth-command 'echo Bearer $(security find-generic-password -s gbrain-pi -w)'
```

`PI_CODING_AGENT_DIR` moves every path above (pi honors it too).

## What the hooks do

| pi event | gbrain hook | Effect |
| --- | --- | --- |
| `session_start` | `session-start` | Digest (MEMORY.md sections, push status, hook health, context pack), delivered with the first prompt. |
| `before_agent_start` | `user-prompt` | Per-turn brain context, added as a hidden message (`customType: "gbrain-context"`). |
| `agent_settled` | `stop` | Ambient-writeback backstop (when enabled) and workspace push. Not awaited. |
| `session_before_compact` | `compact` | Banks the window before pi compacts it. |
| `session_compact` | `session-start` (`source: compact`) | Post-compaction rehydration pack. |
| `session_shutdown` | `session-end` | Dream-corpus capture (secret-scanned), detached so pi's exit never waits. Skipped on `/reload`. |

Every call is `gbrain hook <event> --harness pi` with a hook-JSON payload on
stdin: `session_id`, `cwd` and `transcript_path` (this session's file under
`~/.pi/agent/sessions/`, sent once pi has created it). `--harness pi` selects
gbrain's pi transcript lane: the path is confined to the pi session store
(`PI_CODING_AGENT_SESSION_DIR` when set), only the active branch of the
session tree is read, and the `gbrain-context` messages gbrain injected
earlier are read back so a page is volunteered once per session, not once
per mention.

`session_shutdown` does not fire when pi is killed, crashes or loses its
terminal, so each pi session-start also looks for sessions that never reached
the corpus: session files from the last 7 days, idle for at least 30 minutes,
with no corpus copy (or an older one). Up to three per start, newest first,
go through the same `session-end` capture in the background. A file version
that was already tried is not retried. `GBRAIN_PI_SWEEP=0` turns this off.

Every hook fails open: a missing binary, a timeout or an error never blocks
pi. Run `/gbrain-hooks` inside pi to see each hook's last outcome.
`GBRAIN_HOOKS=0` disables them all.

## Check

```bash
gbrain bootstrap status --harness pi     # report, always exit 0
gbrain bootstrap verify --harness pi     # exit 1 unless the extension is gbrain's,
                                         # its binary is executable and a gbrain MCP entry exists
pi mcp list                              # pi's own view of the MCP connection
```

`gbrain doctor --only harness_wiring` reads the pi entry and smoke-tests it, and
warns `pi_hooks_missing` when pi has the MCP entry but not gbrain's extension. Hook
health lands in gbrain's usual heartbeat
(`<gbrain home>/integrations/hooks/heartbeat.jsonl`).

## Import past sessions

The hooks capture new sessions as they end. To bring in sessions from before the
hooks were installed, import pi's session store:

```bash
gbrain transcripts ingest            # discovery: lists what was found, imports nothing
gbrain transcripts ingest --all      # import everything discovered (pi included)
gbrain transcripts ingest --format pi <file.jsonl>   # a pi session file kept elsewhere
```

Each session becomes one page under `conversations/sessions/`. Only the branch you
kept is imported: when you rewound with `/tree`, the abandoned branch stays out.
Thinking, tool output and the context gbrain itself injected are not imported.

## Remove

```bash
gbrain bootstrap uninstall --harness pi
```

Removes the extension and the `gbrain` MCP entry only when gbrain wrote them.

## Hosted brains

`gbrain connect <url> --harness pi --credentials-file <handoff> --install`
writes an HTTP `mcpServers` entry into `~/.pi/agent/mcp.json` from a private
handoff, like the other managed adapters (see
[hosted harness access](../guides/hosted-harness-access.md)). Hooks still come
from `gbrain bootstrap hooks --harness pi --no-mcp` on the machine running pi.
