**Skills and harness: skills that match the CLI and update safely, OpenClaw and claude-cli fixes, and skill resolver additions.** This release carries three PRs: #8918 (with #8190 and #8353), #8931 (with #8947) and #9095.

### Skill checks, safe skill updates, the OpenClaw route and provider fixes (#8918)

**Skills can no longer drift from the CLI or grow without a reviewer seeing it.**

Every `gbrain ...` invocation a bundled skill shows now runs through the dispatcher's own subcommand and unknown-flag checks in CI, and every operation-shaped `tools:` entry must be a real operation. A PR that renames a command or flag fails until it updates the skills that name it, with the file, line, nearest valid name and the edit to make. Each SKILL.md over 16 KB has a size ceiling in `skills/skill-budgets.tsv` (today's size plus 10%), new skills stay within 16 KB and descriptions within 1 KB. `CONTRIBUTING.md` gains "Changing a skill", the update ladder adapted from skill-diet (MIT): fix it below the skill first, edit the existing line instead of appending, update the skill in the same PR as the code, and record `Skill-size:` before and after in the commit message.

#### What changed

| Situation | Before | Now |
|---|---|---|
| A skill shows `gbrain config sett ...` or `gbrain doctor --jsn` | passed CI; an agent following it got an error | `bun run check:skill-health` fails with the nearest valid name |
| A skill declares a `tools:` entry that is not an operation | passed | fails with the nearest operation |
| A SKILL.md grows past its ceiling, or a new one passes 16 KB | passed | fails; raising a ceiling is a reviewer-visible edit |
| `skills-commit-gate.sh` | four checks | also runs the skill health guard and prints `Skill-size:` lines for staged skills |

**Installed skills get the same health check at runtime.**

`gbrain skillpack health [<skill>]` checks the skills an agent actually loads (the harness or workspace skills folder, else the bundled skills) for size against budget, growth past 10% over the last diet, description size, missing triggers, and `gbrain` commands, flags or tools this gbrain does not have. Each finding names what it saw, what it expected, the fix (for an unedited copy of a bundled skill, `gbrain skillpack reference <skill>` first) and a verify command. It reads files only, so a brain with no git repository gets the same report. Folders without a skills manifest or `skills.lock.json` are checked only for copies of gbrain's bundled skills.

| Situation | Before | Now |
|---|---|---|
| An installed skill still shows a flag a newer gbrain removed | an agent following it got an error | `gbrain doctor` warns (`skill_health`) with the line and the fix |
| An installed skill grew well past its last diet | nothing reported | `gbrain skillpack health` reports it; doctor shows it without warning |
| `gbrain maintain`, `gbrain skillpack-check` | no skill information | one-line skill health summary (`skill_health` in skillpack-check's JSON) |

**Installed skills you never edited can take gbrain's current version whole, and that update never overwrites a skill you edited.**

`gbrain skillpack reference <name>|--all --update-untouched` replaces a skill only when every one of its files still matches what gbrain installed. Scaffold, sync and harness installs now record the sha256 of each skill file they write, per skills root. A skill with any edited file, a pinned skill (`gbrain skillpack pin`), or a file with no recorded base that matches no released version is skipped whole and its diff is printed. Installs from before bases were recorded can opt in with `--accept-historical` when every file equals a released version listed in the new `skills/skills.lock.history.json`. Every update writes a journal and backups to `~/.gbrain/skillpack-backups/<id>/` before it changes anything, rehashes each file right before replacing it, and runs the conformance, trigger and resolver checks; a failure rolls back only the files that still hold the update's bytes. `gbrain skillpack restore <id>` undoes an update and refuses files you changed since, unless you name them with `--skip`. It never prompts (`--dry-run` is the preview), works the same on a brain with no git repository, and `gbrain upgrade` writes no skill files.

#### Skill updates

| Situation | Before | Now |
|---|---|---|
| You want gbrain's new version of skills you never touched | `--apply-clean-hunks` applied hunks two-way and could not tell your edits from gbrain's | `--update-untouched` replaces only skills whose every file still matches the install |
| A skill you edited or pinned | `--apply-clean-hunks` could overwrite it hunk by hunk | skipped with `local_edits` or `pinned` and its diff |
| An update fails a check or the process dies mid-update | — | rolled back per skill; doctor reports `skillpack_update_incomplete` with the restore command |
| Exit code of an update | — | 0 nothing failed, 1 with `--fail-on-skipped` when a skill was skipped, 2 on a failure |
| `~/.gbrain/skillpack-state.json` | schema v1 | schema v2 with per-skill bases and pins; a v1 file still loads |

#### OpenClaw route

**On OpenClaw, every skill gbrain installs now loads in one read, and setup and the install docs name the per-turn rule as the primary route, with skills as the fallback.**

OpenClaw serves a skill only whole. A SKILL.md larger than one read (64,000 characters on a model with 200k+ context, 32,000 at 100k to 200k, 16,000 below that, and a 32,768-byte page when the context window is unknown) gets "cannot be partially served" and nothing else. `company-brainify` (37 KB) is trimmed to 30 KB with the same steps, gates and checks. A unit test now fails when any SKILL.md that `gbrain skillpack scaffold --harness openclaw --all` installs passes 32,000 bytes, or when anything gbrain writes for OpenClaw names `skills_read`, OpenClaw's deferred skill tool, which fails when called directly. In harness-evals, a listed skill was followed on 1-3% of turns and a per-turn rule on 97-100%. `gbrain setup openclaw` already installs that rule; it now says the rule is the primary route, `skillpack scaffold --harness openclaw` says its skills are the fallback, and INSTALL_FOR_AGENTS.md and docs/mcp/OPENCLAW.md lead with the rule.

#### Providers and skills

**Six provider and skill bugs fixed (#8142, #8143), and Particle joins as a chat provider.**

- **Particle is a chat and expansion provider.** Set `PARTICLE_API_KEY` and use `particle:particle-1` (the id Particle's responses report, `particle-ai/particle-1`, works too). It runs over Chat Completions at `https://api.particle.ai/v1`, with tools, the subagent loop, prompt caching and a 1,048,576-token context; point `provider_base_urls.particle` at `https://us.api.particle.ai/v1` to keep traffic in the US. Spend caps price it at $0.25 input and $1.00 output per million tokens, with reasoning billed as output; cached input (listed at $0.03) is priced at the input rate until that rate is verified. A `thinking: 'off'` call such as an eval judge sends `reasoning_effort: 'none'` and keeps its requested output cap, and reasoning text never becomes answer text. No default model changed.
- **A System One provider that refuses every call no longer reads as "budget exhausted" (#7272).** A decide call the provider refuses with a 4xx (402 billing, 401/403 auth, 400/404 model) never ran, so it now costs $0. Before, each refusal was charged its estimate, the daily budget filled with calls that never ran, and `decide status`, doctor and every slot reported `budget_exhausted` instead of the provider error. A 429, 5xx, timeout or transport failure keeps its charge.
- **An embedding migration keeps a provider URL set with `gbrain config set` (#7666).** After the switch committed, the migration rebuilt its AI gateway from file and env config only, so a `provider_base_urls.<provider>` override in the database (a local Ollama on a non-default port) vanished and every re-embed failed with `Cannot connect to API`. The gateway now keeps the database overlay; file and env still win per key, and nothing from the database is written to the config file.
- **A `deepseek:` model pointed at another OpenAI-compatible endpoint gets room to think (#7662).** With `provider_base_urls.deepseek` on another origin (Ollama Cloud, a proxy), gbrain still sent DeepSeek's thinking switch and the small judge cap that assumes it works, so a model that kept thinking used the whole cap and every `facts relink` judgement came back `model_unparseable`. That route now gets no switch and the thinking-model output headroom, priced the same way. The native DeepSeek origin, any path on it included, is unchanged.
- **`openrouter:voyageai/voyage-*` embeddings are priced (#7034).** OpenRouter names Voyage's models `voyageai/<model>`, which missed the `voyage:` price rows, so a capped `gbrain embed` stopped with `no_pricing`. They now price from those rows (OpenRouter's rates are the same).
- **The bootstrap interview saves an OpenRouter key as `openrouter_api_key` (#7977).** A `sk-or-v1-` key matched the OpenAI `sk-` prefix and was saved as `openai_api_key`.
- **daily-task-manager names its page by the slug `ops/tasks` (#7932).** Its tool calls used `ops/tasks.md`, a different slug, so `get_page` missed the existing task list and the first-run rule could start a second one.

### OpenClaw, Hermes, Windows and claude-cli harness fixes (#8931)

**OpenClaw setups stop breaking each other, upgrades stop breaking OpenClaw, and four other harness fixes land.** Six fixes for people running gbrain with OpenClaw. Setting up one agent's workspace no longer rewrites or removes the per-turn brain rule every other agent on the same gateway relies on. Background turns (heartbeats, cron, finished commands) no longer get told to answer. `gbrain upgrade` no longer reinstalls gbrain in a way OpenClaw refuses to load as a plugin. `gbrain doctor` stops failing on skills another tool put in the workspace. The OpenClaw guide now leads with an install route that works and documents OpenClaw's own remote MCP connection.

**gbrain's background claude-cli calls no longer read your personal Claude Code instructions.** On Claude Code 2.1.314 or newer the claude-cli provider runs its child with `--setting-sources ""`, so your `~/.claude/CLAUDE.md`, memory and `settings.json` stop steering gbrain's extraction and summary calls (and stop adding about 42k cached tokens to each). The trade-off: `settings.json`'s `env`, `apiKeyHelper` and permission rules don't reach the child either; the subscription login is kept. To load them again, set `GBRAIN_CLAUDE_CLI_USER_SETTINGS=1` in your shell or `~/.gbrain/.env`. Older CLIs are unchanged.

Four more harness fixes: a per-turn hook you paste into Hermes by hand now counts, `gbrain setup claude-code --instructions-only` writes the per-turn rule hook on Windows, `request_tools` stops promising tools a stdio session cannot call, and `gbrain schema show --source` reads that source's pack.

- `gbrain setup openclaw --workspace <dir>` leaves the gateway-shared turn-rule plugin alone when it would name another server, and `--no-instructions` there no longer removes it, or the brain-first block in other workspaces' `AGENTS.md`, for every agent; it says how to change it for all agents instead and exits 0. A plugin an older gbrain wrote for the same server is rewritten (reported by @Masashi-Ono0611, #8401).
- OpenClaw heartbeat, cron and exec-completion turns get the brain-first rule without its closing "answer and finish" sentence, so they stop inviting replies nobody asked for (reported by @Masashi-Ono0611, #8440).
- `gbrain doctor` reports skills in an OpenClaw workspace that have no resolver rows and no `manifest.json` as warnings, not errors, the way it already treats a foreign `skills/` found from the current directory (reported by @Masashi-Ono0611, #8629).
- `gbrain upgrade` reinstalls a Bun global install with `--backend=copyfile`, and its recovery commands say the same, so an install OpenClaw loads as a plugin keeps loading after an upgrade (reported by @Masashi-Ono0611, #8663).
- The OpenClaw guide marks the ClawHub bundle route as not available: the ClawHub package named `gbrain` is an unofficial old build that fails to install. It leads with the stdio route (reported by @Masashi-Ono0611, #8470).
- `gbrain agent register --harness openclaw` no longer says OpenClaw has no remote MCP client, and the OpenClaw guide documents connecting over streamable HTTP with `openclaw mcp login` (reported by @Masashi-Ono0611, #8747).
- When your `config.yaml` already has a `hooks:` section, `gbrain setup hermes` prints the `pre_llm_call` entry for you to add. Once you paste it, `gbrain doctor` now sees it (and still reports it untrusted until Hermes approves it) instead of calling it missing (reported by @Masashi-Ono0611, #8857).
- `gbrain setup claude-code --instructions-only`, doctor's turn-hook repair and the hook-launcher refresh now write the per-turn rule hook for a Windows gbrain binary (`C:\...\gbrain.exe`) instead of skipping it with "no absolute gbrain binary was found". The hook names its paths in Git Bash's `/c/...` form, which is how Claude Code runs hooks on Windows. Codex runs hooks on Windows without a POSIX shell, so it still gets the printed step, now with that reason (reported by @Masashi-Ono0611, #8451).
- On a stdio session started at a narrower surface (`gbrain serve --surface starter`), `request_tools {tools: [...]}` lists only the tools the session can call. A tool outside it comes back with its schema, `listed: false` and a note to call `request_tools {"surface":"full"}` first, instead of a promise that it is in your tool list (reported by @Masashi-Ono0611, #8734).
- `gbrain schema show --source <id>` shows that source's own pack (its per-source override, else the brain-wide pack) instead of failing with `Unknown pack: <id>`. A pack you name still wins (reported by @Masashi-Ono0611, #8900).

#### Itemized changes

- `src/core/setup/openclaw-turn-plugin.ts`: the plugin's `package.json` records the access it was written for (`gbrain.access`); `syncOpenclawTurnPlugin({ workspace })` returns `print` (unverified, naming the `--remove` command) for an installed plugin whose rule would change, falling back to the server or launcher in its `RULE` literal when it records none, and `removeOpenclawTurnPlugin({ workspace })` skips; `syncBrainFirst`'s opt-out no longer strips other OpenClaw workspaces' blocks; `src/commands/setup.ts` passes `--workspace` (not on `--remove`). The plugin's `before_prompt_build` returns `renderBrainFirstTurnRule(access, 'openclaw', { reply: false })` when `ctx.inputProvenance.kind` is `internal_system`.
- `src/core/check-resolvable.ts`: the low-confidence `unreachable` downgrade also applies to `openclaw_workspace_*` detection.
- `src/commands/upgrade.ts`: `bun update`, `bun add -g` (stable, pinned and restore) and `bunReinstallCommand` / `reinstallHintLines` pass `--backend=copyfile`.
- `src/core/mcp-registration.ts`: `openclawThinClientBlock` names OpenClaw's native remote MCP route.
- Docs: `docs/mcp/OPENCLAW.md`, `docs/guides/upgrades-auto-update.md`, `TODOS.md`.
- Tests: `test/brain-first-turn-rule.test.ts`, `test/setup-brain-first.test.ts`, `test/check-resolvable.test.ts`, `test/mcp-registration-blocks.test.ts`, and the upgrade suites that pin the child `bun` argv.
- `src/core/ai/providers/claude-cli-language-model.ts`: `runClaude` adds `--setting-sources ""` when a cached `claude --version` (once per binary per process) reads `SETTING_SOURCES_MIN_VERSION` (2.1.314) or newer. `GBRAIN_CLAUDE_CLI_USER_SETTINGS=1` skips the flag and the probe, and a cwd `.env` cannot set it (`src/core/env-trust.ts`). Reported and first fixed by @Masashi-Ono0611 (#8350).
- Docs: `docs/ai-providers/claude-cli.md` (the trade-off), `docs/guides/skillopt.md`, `docs/architecture/key-files/core-ai-continued.md`.
- `src/core/behavior-change-notice.ts`: the `claude_cli_setting_sources_8342` row.
- Tests: `test/claude-cli-setting-sources-8342.test.ts` (including the opt-in); the `test/claude-cli-output-cap.test.ts` stub answers `--version`.

### Skill resolver: session cleanup, extra skill folders and top_gate (#9095)

**The skill resolver's hook lane now cleans up old session files before it exits, each harness can add its own skill folders, and a new experimental `top_gate` setting can hold back weak suggestions.** The skill resolver is the optional feature that offers your agent the right installed skill on each turn. It is still off by default, `top_gate` is off too, and none of this blocks a turn.

Before, the hook lane exited right after its turn, so idle session files waited for the next CLI run to be cleaned up. Now the lane runs one cleanup pass of at most 64 files before it exits, and never runs past its deadline. Before, Claude Code and Codex catalogs were built only from each harness's default skill folder. Now you can list extra folders per harness, and setup keeps them on every later run.

#### How to use it

- Extra skill folders: `gbrain config set skills.resolver.per_harness.claude-code.dirs /abs/dir,/abs/other` (or `.codex.dirs`, at most 32 absolute paths), then run setup again. Setup builds the user catalog from the default folder plus every listed folder that exists, and the catalog's automatic rebuild keeps them. Unset the key and run setup again to drop them.
- `top_gate`: `gbrain config set skills.resolver.top_gate <0-100>`, `--top-gate` on `gbrain skill-resolver`, or `top_gate` in the turn input. It empties the block when the best skill the block would show scores below the threshold, after dividing the score by the catalog's maximum idf so the number means the same thing at any catalog size. A skill named in the turn bypasses it. `skills.resolver.per_harness.<harness>.top_gate` overrides it for one harness.

#### Things to watch

- `top_gate` stays off because no threshold has yet removed suggestions on no-skill turns without hiding many right ones. On held-out turns written to break length-based gates, threshold 1.33 kept false suggestions at 0.17 to 0.19 but cut hit@5 on skill turns from 0.515-0.611 to 0.26-0.28. The guide shows both measurements; treat it as a setting to measure, not one to turn on.
- An empty block can now carry `block_reason: "weak_top_match"`.
- `min_match` behaves as before. Its docs now say it filters candidates and is not a gate.
- A bad `top_gate` or `dirs` value makes the lane log `skill_resolver_config_invalid` and deliver nothing, like the other turn settings.

<!-- behavior-change: claude_cli_setting_sources_8342 -->
