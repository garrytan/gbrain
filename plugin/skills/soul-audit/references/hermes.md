# Soul audit on Hermes Agent

Read this only when your system prompt identifies you as Hermes Agent (Nous
Research). Every other agent follows `../SKILL.md` alone.

Hermes loads its identity from `SOUL.md` in its home (`$HERMES_HOME`, default
`~/.hermes`; a profile is its own home) and reads nothing from a bootstrap
workspace. So on Hermes the answer bank and its rendered files live in a
workspace Hermes never loads, and `../scripts/hermes_apply.py` copies the
result into `$HERMES_HOME/SOUL.md`. The interview, read-back, and confirm steps
are the ones in `../SKILL.md`, unchanged.

## Steps

1. **Workspace.** Use `$HERMES_HOME/gbrain-identity` (one per profile; resolve
   `$HERMES_HOME` from your shell, falling back to `~/.hermes`). If the user
   already has a bank from bootstrapping another agent and wants the same
   identity here, use that workspace instead. Never the Hermes home itself.
   Pass `--workspace "$WS"` to every `gbrain bootstrap` command. On a
   workspace with no bank yet, run `gbrain bootstrap interview --workspace "$WS" --init`
   once.
2. **Interview and read-back:** exactly as in `../SKILL.md`.
3. **Render with `--only`**, never a bare render. A bare render also writes the
   rest of a bootstrap workspace (`CLAUDE.md`, `MEMORY.md`, `.gitignore`, and
   more), which Hermes never reads:

   ```
   gbrain bootstrap render --workspace "$WS" --only SOUL.md,USER.md,AGENTS.md,ACCESS_POLICY.md,HEARTBEAT.md --force
   ```

4. **Preview, then apply.** The helper needs Python 3.8+ and nothing else. Use
   the skill directory your skill loader reports (Hermes `skill_view` returns it
   as `skill_dir`):

   ```
   python3 <skill-dir>/scripts/hermes_apply.py --workspace "$WS" --dry-run
   python3 <skill-dir>/scripts/hermes_apply.py --workspace "$WS"
   ```

   If `scripts/hermes_apply.py` is not in that directory, the installed copy of
   this skill is older than this file: update it (`gbrain skillpack scaffold soul-audit`
   adds missing files without overwriting yours) rather than writing the block by hand.
5. **First run on an existing SOUL.md.** If SOUL.md already holds text and no
   block, the helper exits 3 and writes nothing. Show the user both previews,
   `--dry-run --mode append` (keeps their text above the block) and
   `--dry-run --mode replace` (right for the stock Hermes persona), then re-run
   with the mode they pick. A symlinked SOUL.md is refused until the user agrees
   to `--follow-symlink`.
6. **Verify.** `grep -c 'gbrain:soul-audit:begin' "$HERMES_HOME/SOUL.md"`
   prints 1. The change takes effect in new Hermes sessions; a running session
   keeps its prompt. Report as in `../SKILL.md`, plus the SOUL.md path and the
   backup path the helper printed.

## What the block holds

One block between `<!-- gbrain:soul-audit:begin -->` and
`<!-- gbrain:soul-audit:end -->`, copied from the rendered files:

| Rendered file | Goes into the block | Left out, and why |
|---|---|---|
| `SOUL.md` | all of it | nothing |
| `AGENTS.md` | Mission (as Jobs), the hard gates, the per-message gates, the filing contract | private-repo persistence (the bootstrap repo is not Hermes's home), skill routing (Hermes routes its own skills), the workspace session-startup and memory-layer tables, the hooks note for Codex / opencode |
| `USER.md` | the profile (primary surface becomes Hermes Agent) | the note about maintaining the workspace file |
| `ACCESS_POLICY.md` | tiers, fixed boundaries, what the model provider sees | MCP registration scope for Claude Code / Codex / opencode, the workspace transcript corpus |
| `HEARTBEAT.md` | quiet hours, the silence contract, the user's check-in cadence answer | the session-triggered due-job table (see Recurring jobs) |

All five rendered files must be present; the helper writes nothing otherwise,
so a partial render can never shrink an existing block. Sections are picked by
heading and the workspace-only sentences are removed only where the template's
exact wording appears once, so the user's answers are never filtered. A re-run
replaces only the block; text above and below it stays byte for byte. Every
write first copies the old file to
`$HERMES_HOME/backups/soul-audit-<timestamp>/SOUL.md`.

## Hermes memory and recurring jobs

- **User profile.** Hermes keeps its own small user profile
  (`$HERMES_HOME/memories/USER.md`, written by the `memory` tool). The block
  already carries the rendered profile, so never paste a rendered file into
  Hermes memory. If an entry there contradicts a new answer, show the user both
  and update that entry with the `memory` tool only if they agree.
- **Recurring jobs.** Hermes runs no session-triggered heartbeat; recurring
  work is Hermes cron (`hermes cron create`, `hermes cron list`). Keep the same
  enable ritual as `HEARTBEAT.md`: run one job's task by hand in this session,
  show the result, and create the cron job only after the user agrees, one job
  per session. Cron prompts must be self-contained, and Hermes cron does not
  observe quiet hours, so schedule outside them or put the check in the prompt.
- **Access.** The tiers in the block are prompt-level policy. Who can reach the
  agent at all is set by the Hermes gateway allowlists and pairing; tell the
  user when a tier implies a change there.

## When the helper fails

| Exit | Meaning | What to do |
|---|---|---|
| 3 | SOUL.md holds text and no block yet | Step 5: show both previews, re-run with the user's `--mode` |
| 1 | duplicate or out-of-order markers | Ask the user to keep one block (or fix the markers with their OK), then re-run |
| 1 | `{{TOKEN}}` placeholders left | Get the missing answers, confirm the read-back, render again |
| 1 | SOUL.md is a symlink, or not UTF-8 | Ask the user; `--follow-symlink` only with their OK |
| 1 | a rendered file or section is missing | Render again with the `--only` list from step 3 |

Never edit the block by hand to get past an error. The block is the render
output; change an answer and re-run instead.
