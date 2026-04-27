---
id: claude-code-capture
name: Claude Code Capture
version: 0.1.0
description: Ambient signal capture from Claude Code sessions. A Stop hook runs after every session, asks Haiku to extract decisions / original thinking / entities / concepts, and writes selective brain pages. Mirrors the openclaw signal-detector skill, ported to Claude Code's hook mechanism.
category: sense
requires: []
secrets:
  - name: ANTHROPIC_API_KEY
    description: Anthropic API key. OPTIONAL — only used if `claude` CLI is not installed. With Claude Pro/Max subscription installed, the recipe uses `claude -p` and pays nothing extra.
    where: https://console.anthropic.com/settings/keys — only needed if you want to run the hook on a server without the `claude` CLI authed.
health_checks:
  - type: command
    argv: ["test", "-x", "$HOME/.gbrain/hooks/signal-detector.py"]
    label: "signal-detector.py installed"
  - type: command
    argv: ["jq", "-e", ".hooks.Stop[].hooks[] | select(.command | contains(\"signal-detector\"))", "$HOME/.claude/settings.json"]
    label: "Stop hook wired in settings.json"
setup_time: 5 min
cost_estimate: "$0/mo with Claude Pro/Max subscription (uses `claude -p` headless). ~1-3¢ per session with ANTHROPIC_API_KEY (Haiku 4.5 prices). Recipe picks the cheaper path automatically."
---

# Claude Code Capture: Ambient Brain Capture from Terminal Sessions

By default, Claude Code does NOT write to your brain. The MCP wiring lets the
model query/write *during* a conversation, but sessions end without leaving any
trail in the brain. This recipe fixes that with a Stop hook: at the end of
every session, Haiku reads the transcript, extracts only the signals worth
keeping, and writes selective pages.

This is the openclaw `signal-detector` pattern (which fires per-message on
inbound Telegram messages), ported to Claude Code's hook mechanism (which fires
per-session at end-of-session).

## IMPORTANT: Instructions for the Agent

**You are the installer.** Follow these steps precisely.

**The core pattern: end-of-session hook spawns capture in background.**
The hook runs `python3 ~/.gbrain/hooks/signal-detector.py` with `async: true`,
so the user is never blocked. The script reads the just-finished transcript
(`.jsonl` under `~/.claude/projects/<sanitized-cwd>/`), asks Haiku to extract
*structured* signals (decisions, originals, entities, concepts), and writes
each as its own brain page via `gbrain put`. The full transcript is NEVER
saved — only signals worth keeping forever.

**Why end-of-session and not per-message:**
- During a session the model already has GBrain MCP tools and can call
  `gbrain put` on demand when the user asks. This recipe is for the rest —
  the implicit knowledge that emerged but no one bothered to save.
- One Haiku call per session is much cheaper than one per message.
- A user can always ask the model directly to save during the conversation;
  this recipe is the safety net.

**Do not skip steps. Verify after each step.**

## Architecture

```
Claude Code session ends
  ↓
Stop hook fires (async, never blocks user)
  ↓
~/.gbrain/hooks/signal-detector.py
  ├─ recursion guard: if env GBRAIN_HOOK_RUNNING=1 → exit 0 (we're inside a child claude -p call)
  ├─ read JSON event from stdin: { transcript_path, session_id }
  ├─ fall back to newest *.jsonl in ~/.claude/projects/<sanitized-cwd>/ if path missing
  ├─ skip if transcript < 2KB (trivial sessions ignored)
  ├─ extract last 200 user/assistant turns to plain text (truncate to 30k chars)
  ├─ pick auth mode:
  │    1. PREFERRED: `claude -p --model claude-haiku-4-5 ...` (Pro/Max subscription, $0)
  │    2. FALLBACK: direct API with ANTHROPIC_API_KEY
  │    3. NEITHER: log [skip] reason=no_auth, exit 0
  ├─ robust JSON extraction (find first balanced {...}, ignore prose/fences)
  ├─ pre-validate slugs (kebab segments, lowercase, max 120 chars)
  ├─ YAML-escape title and session_id in frontmatter (prevents YAML parse errors)
  ├─ for each signal: gbrain put <slug> with frontmatter (source_session, captured_at)
  ├─ if write fails: log slug + reason + stderr to write-failures.log sidecar
  └─ write one-line summary to ~/.gbrain/hooks/signal-detector.log
```

## What gets captured

| Category | Slug pattern | What it is |
|---|---|---|
| Decisions | `decisions/<kebab>` | Concrete decisions made in the session |
| Insights (originals) | `originals/<kebab>` | User's original thinking — exact phrasing, NOT paraphrased |
| Entities | `people/<kebab>` or `companies/<kebab>` | Notable people/companies mentioned |
| Concepts | `concepts/<kebab>` | World concepts or domain ideas referenced |

What is NOT captured:

- The full transcript (would be noise; Claude Code's local auto-memory at `~/.claude/projects/<dir>/memory/` already handles that locally).
- Operational chatter (yes/no/run-this — flagged with `skip_reason: "operational"` and dropped).
- Sessions under 2KB of transcript (skipped as too small).

## Setup Flow

### Step 1: Verify Claude Code is installed and the brain is reachable

```bash
claude --version           # need >= 2.x
gbrain --version           # need 0.2x.x (canonical Garry Tan version, not the npm squat)
gbrain doctor --fast       # health score >= 80 expected
```

If `gbrain` shows a 1.x.x version, the user installed the squatted npm package
instead of `bun install -g github:garrytan/gbrain`. Fix with:

```bash
bun remove -g gbrain && bun install -g github:garrytan/gbrain
```

### Step 2: Install the capture script

```bash
mkdir -p ~/.gbrain/hooks
curl -fsSL https://raw.githubusercontent.com/garrytan/gbrain/master/recipes/claude-code-capture/signal-detector.py \
  -o ~/.gbrain/hooks/signal-detector.py
chmod 700 ~/.gbrain/hooks/signal-detector.py
```

Validate:

```bash
python3 -c "import py_compile; py_compile.compile('$HOME/.gbrain/hooks/signal-detector.py', doraise=True)" \
  && echo "PASS: script syntax valid"
```

### Step 3: Wire the Stop hook into `~/.claude/settings.json`

Append this entry to the `hooks.Stop` array in the user's `~/.claude/settings.json`
(merge with existing hooks; do not replace):

```json
{
  "hooks": {
    "Stop": [{
      "matcher": "",
      "hooks": [{
        "type": "command",
        "command": "python3 $HOME/.gbrain/hooks/signal-detector.py",
        "timeout": 120,
        "async": true
      }]
    }]
  }
}
```

`async: true` is critical: the hook fires in background and never blocks the
user. `timeout: 120` is generous because Haiku extraction takes 5–30s on a
typical session.

Validate:

```bash
jq -e '.hooks.Stop[] | .hooks[] | select(.command | contains("signal-detector")) | .command' \
  ~/.claude/settings.json \
  && echo "PASS: hook wired"
```

After editing, the user must open `/hooks` in Claude Code once or restart the
client so the watcher picks up the new entry.

### Step 4: Smoke test

The script handles a fully-empty stdin gracefully (exits 0 with a `[skip]`
log line). Test it:

```bash
echo '{}' | python3 ~/.gbrain/hooks/signal-detector.py
tail -1 ~/.gbrain/hooks/signal-detector.log
```

Expected output (one of):
- `[skip:unknown] reason=transcript too small` (no real session yet)
- `[ok:unknown] auth=claude_cli captured: N decisions, N insights, N entities, N concepts (Xs, transcript Yb)` (a session existed and was processed)

### Step 5: Real end-to-end test

```bash
claude
# Have a real conversation with at least one decision and one named entity.
# Press Ctrl+D to exit (do NOT type "/exit"; the Stop hook fires on session
# termination, not on the /exit slash command).
# Wait ~30s.
tail -1 ~/.gbrain/hooks/signal-detector.log
```

Expected: an `[ok:<sid>]` line with non-zero counts.

Then:

```bash
gbrain list -n 5
```

You should see new pages with `decisions/`, `originals/`, `concepts/`, etc.
slugs from this session.

## What the agent should do after Step 5

The agent's job ends after Step 5. Capture is now ambient — every Claude Code
session ends with selective signals in the brain. The user does not need to do
anything else.

If the user wants to disable capture temporarily, they can comment out the
hook in `~/.claude/settings.json` or set the env var `GBRAIN_HOOK_RUNNING=1`
in their shell.

## Multi-machine

Each machine runs its own `~/.gbrain/hooks/signal-detector.py` and points at
the same `gbrain` config (same `database_url`). All captures land in the
shared brain. Provenance is preserved via the `source_session: <uuid>`
frontmatter on each page, so the user can always tell which machine and
session a page came from.

## Auth mode details

The script picks the cheaper path automatically:

1. **PREFERRED: `claude -p` (subscription).** If `claude` is in `PATH`, the
   script invokes:
   ```
   claude -p --model claude-haiku-4-5-20251001 "<prompt>+<transcript>"
   ```
   This uses the user's Claude Pro/Max OAuth — zero extra cost. Recursion is
   prevented by setting `GBRAIN_HOOK_RUNNING=1` in the child env; the script
   bails immediately if it sees that var on entry.

2. **FALLBACK: direct API.** If `claude` is not installed (e.g., on a
   headless server that has only the gbrain CLI), the script falls back to
   a direct `https://api.anthropic.com/v1/messages` call with
   `ANTHROPIC_API_KEY`. ~1-3¢ per session at Haiku-4-5 prices.

3. **NO AUTH AVAILABLE:** logs `[skip:<sid>] reason=no_auth` and exits 0
   cleanly. The user can either `npm i -g @anthropic-ai/claude-code` (free,
   uses subscription if logged in) or set `ANTHROPIC_API_KEY`.

## Logs

| Path | Purpose |
|---|---|
| `~/.gbrain/hooks/signal-detector.log` | One line per run: `[ok|empty|skip:<sid>] auth=<mode> captured: ... (Xs, transcript Yb)` |
| `~/.gbrain/hooks/write-failures.log` | One line per failed `gbrain put`: timestamp, slug, reason, stderr (truncated). Diagnoses YAML errors, invalid slugs, CLI timeouts. |
| `~/.gbrain/hooks/last-extraction-raw.txt` | Last raw Haiku response — only written on parse failure. Inspect to tune the prompt. |

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `[skip] reason=no ANTHROPIC_API_KEY` | Neither `claude` CLI nor API key available | Install Claude Code (`npm i -g @anthropic-ai/claude-code`) or set `ANTHROPIC_API_KEY` in `~/gbrain/.env` |
| `[empty:<sid>]` on a real conversation | Haiku returned no signals | Inspect `~/.gbrain/hooks/last-extraction-raw.txt`. The prompt may need tuning for the user's domain |
| `proposed=N/written=0` | All `gbrain put` calls failed | Inspect `~/.gbrain/hooks/write-failures.log`. Common causes: invalid slugs from Haiku (script pre-validates and logs `slug_invalid_chars`), YAML parse error in title (script YAML-escapes; if you see this, please file an issue with the title that broke) |
| Hook never fires | Settings watcher missed the change | User must open `/hooks` once in Claude Code or restart |
| Recursive loop | Stop hook firing on the child `claude -p` invocation | Should not happen — recursion guard via `GBRAIN_HOOK_RUNNING=1` env var. If you see it, file an issue |

## Cost / latency

| Path | Latency per session | Cost per session |
|---|---|---|
| `claude -p` (subscription) | 10-40s | $0 |
| Direct API (fallback) | 5-25s | ~1-3¢ |

Both run async, so the user never waits.

## Reference implementation

Source: [recipes/claude-code-capture/signal-detector.py](claude-code-capture/signal-detector.py)
Installer: [recipes/claude-code-capture/install.sh](claude-code-capture/install.sh)

The script is single-file Python 3 with stdlib only (no `requests`, no `pyyaml`)
so it ships with no install footprint beyond `python3` + `gbrain` + (optionally)
`claude`.

## Comparison with openclaw signal-detector

| | openclaw signal-detector | This recipe |
|---|---|---|
| Trigger | Every inbound Telegram message | End of every Claude Code session |
| Where it runs | Inside the openclaw agent loop | As a Stop hook spawned by Claude Code |
| Model | Whatever the agent is configured to use | Haiku 4.5 (cheap, fast) |
| Auth | Whatever the agent uses | Subscription via `claude -p` (preferred) or API key (fallback) |
| Capture latency | Real-time (during conversation) | End-of-session (batch, async) |
| Output | decisions/originals/people/companies/concepts pages | same |
| Shared brain | Yes (writes to same Postgres) | yes |

Both write to the SAME GBrain Postgres → unified memory across all entry
points (Telegram via openclaw, terminal via Claude Code, etc.).
