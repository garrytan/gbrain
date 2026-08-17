/**
 * host-specs.ts — dated spec-targets for external host formats
 * (agent-bootstrap plan: ENG-7, ENG-1, CX2-17).
 *
 * THE ONE MODULE that owns host-format assumptions. Every writer that
 * touches a host's config surface (settings.local.json hooks, `claude mcp
 * add` / `codex mcp add` argv) consumes the shapes exported here, and every
 * assumption is pinned to a DATED spec target with a status + references —
 * so when a host ships a breaking format change, the blast radius is one
 * TARGETS entry and the writers that import from it, not a grep across the
 * tree. (Pattern imported from the codex-as-agent plugin-spec
 * one-file-owns-format rule; see the plan's port map.)
 *
 * Verification discipline: `status: 'verified'` means the referenced
 * behavior was checked against the host's published docs (or binary) on
 * `verifiedAt`. `'provisional'` means the shape is believed-correct from
 * docs/precedent but has not been re-verified against a live host — treat a
 * provisional writer's failure as "re-verify the spec" before debugging
 * gbrain code.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

// ── Spec-target registry [ENG-7] ────────────────────────────────────────────

export interface HostSpecTarget {
  /** Dated spec id, e.g. 'claude-code-2026-08'. */
  id: string;
  status: 'verified' | 'provisional';
  /** ISO date the referenced behavior was last checked. */
  verifiedAt: string;
  /** Docs / precedent the assumptions trace to. */
  references: string[];
  /** What this target asserts about the host, in one place. */
  note: string;
}

export const CLAUDE_CODE_SPEC_ID = 'claude-code-2026-08';
export const CODEX_SPEC_ID = 'codex-2026-08';
export const OPENCODE_SPEC_ID = 'opencode-2026-08';

export const TARGETS: Record<string, HostSpecTarget> = {
  [CLAUDE_CODE_SPEC_ID]: {
    id: CLAUDE_CODE_SPEC_ID,
    status: 'verified',
    verifiedAt: '2026-08-12',
    references: [
      'https://code.claude.com/docs/en/hooks',
      'https://code.claude.com/docs/en/hooks-guide',
      'https://code.claude.com/docs/en/settings',
    ],
    note:
      'Hook events used: SessionStart / UserPromptSubmit / Stop / SessionEnd / ' +
      'PreCompact. Hooks are written to <workspace>/.claude/settings.local.json ' +
      '(gitignored by Claude Code by default) as hooks.<Event> → [{matcher?, ' +
      'hooks: [{type:"command", command, timeout}]}] with timeout in SECONDS. ' +
      'Hook commands are shell strings (no env map) — env vars are embedded via ' +
      'an `env K=V …` prefix. Unknown properties on the command object are ' +
      'tolerated by the harness, which is what makes the `_gbrain` marker key ' +
      'safe. UserPromptSubmit context injection: stdout JSON ' +
      '{hookSpecificOutput: {hookEventName: "UserPromptSubmit", ' +
      'additionalContext}}; SessionStart plain stdout becomes context. Hook ' +
      'stdout is capped at 10000 chars — overflow is diverted to a file and ' +
      'NOT injected [ENG-1]. Transcripts live under ~/.claude/projects/ as ' +
      '.jsonl (transcript_path in the hook stdin payload). PreCompact stdin ' +
      '(verified against the published hooks reference, not live capture): the ' +
      'common fields (session_id, transcript_path, cwd, hook_event_name) plus ' +
      'trigger:"manual"|"auto" and custom_instructions (the /compact argument ' +
      'for manual, empty for auto). PreCompact stdout is never context-injected ' +
      '— only UserPromptSubmit and SessionStart stdout reach the model — and ' +
      'exit 2 blocks compaction, so the v0.45.7 banking hook must exit 0. ' +
      'SessionStart stdin carries source:"startup"|"resume"|"clear"|"compact" ' +
      '(+"fork" since Claude Code v2.1.214); source:"compact" fires after auto ' +
      'or manual compaction and is the rehydration re-entry the PreCompact ' +
      'bank serves a warm pack through. Skills: user-scope native SKILL.md ' +
      'discovery reads CLAUDE_CONFIG_DIR-else-HOME /.claude/skills ' +
      '(claudeUserSkillsDir — the harness-bridge install target, attested by ' +
      'the gstack convention + plugin lane); project-scope ' +
      '<workspace>/.claude/skills is provisional-from-docs.',
  },
  [CODEX_SPEC_ID]: {
    id: CODEX_SPEC_ID,
    status: 'verified',
    verifiedAt: '2026-08-12',
    references: [
      'docs/mcp/CODEX.md',
      'https://developers.openai.com/codex/mcp',
      'codex-cli 0.147.0 (binary serde field scan + live inline bearer_token wiring, issue #4043)',
    ],
    note:
      'Local stdio MCP registration: `codex mcp add <name> [--env K=V]... -- ' +
      '<command> [args...]`, which writes [mcp_servers.<name>] into ' +
      '(CODEX_HOME || ~/.codex)/config.toml — codex resolves CODEX_HOME as ' +
      'the config dir itself. Streamable-HTTP servers are configured with ' +
      '`url` plus `bearer_token` (inline) or `bearer_token_env_var`; the ' +
      'config parser uses deny-unknown-fields, so writers must emit ONLY ' +
      'verified keys and `KEY = "value"` spacing. The CX2-17 revisit trigger ' +
      'FIRED (#4043): `codex mcp add` cannot express an inline bearer_token ' +
      '(verified against codex-cli 0.147.0 --help), so the harness lane owns ' +
      'a managed marker-delimited TOML block (codex-toml.ts) — the ONE ' +
      'direct config.toml writer. One owner per server name: `codex mcp ' +
      'remove` rewrites config.toml wholesale and drops comments, so the ' +
      'stdio lane (runHooks) must never manage a name the harness block ' +
      'owns, and vice versa. Codex 0.147.0 also ships a real hook system ' +
      '(hooks.json; PreToolUse…SessionEnd) — CODEX_HAS_HOOKS=false means ' +
      '"gbrain does not wire codex hooks yet" (follow-up filed), NOT "codex ' +
      'has no hooks". Some codex builds gate HTTP MCP servers behind ' +
      '`experimental_use_rmcp_client = true` — probe at wiring time. Skills: ' +
      'no attested native skills DIR for direct file installs (the plugin ' +
      'lane serves codex skills); a direct-copy target needs an observation ' +
      'run before a default ships (harness-bridge requires an explicit dest).',
  },
  [OPENCODE_SPEC_ID]: {
    id: OPENCODE_SPEC_ID,
    status: 'verified',
    verifiedAt: '2026-08-15',
    references: [
      'docs/mcp/OPENCODE-CLI-PIN.md',
      'https://opencode.ai/docs/mcp-servers/',
      'opencode-ai 1.18.18 (hermetic observation run, macOS arm64, 2026-08-15)',
    ],
    note:
      'opencode (SST, opencode.ai — not OpenClaw). Config is JSONC everywhere: ' +
      'comments parse in .json-named files, and global opencode.json AND ' +
      'opencode.jsonc are BOTH read (merged) when both exist; `opencode mcp ' +
      'add` writes the user-global opencode.jsonc via a comment-preserving ' +
      'editor, so gbrain writes match that bar (jsonc-parser surgical edits, ' +
      'opencode-json.ts). MCP entries: {type:"local", command[], environment, ' +
      'enabled?} / {type:"remote", url, headers} — header values keep ' +
      '`{env:VAR}` interpolation verbatim; unknown keys tolerated in 1.18.18 ' +
      'but gbrain writes NO marker key (ownership is a structural ' +
      'fingerprint — a future strict-schema flip must not brick the host). ' +
      '`mcp add` has no scope flag (always user-global); project opencode.json ' +
      'is read but a project-defined LOCAL server spawns with NO trust gate ' +
      '(verified) — so gbrain defaults registration to USER scope and treats ' +
      'project scope as explicit opt-in with a sharing warning. `mcp list` is ' +
      'the honest discriminator (spawns servers; ✓/✗ text; exit 0 regardless); ' +
      '`mcp debug` is OAuth-only. Keyless anonymous free tier answers headless ' +
      '`run` AND drives MCP tool calls without --auto (load-bearing for the ' +
      'door SMOKE). DOCS-CONTRADICTION pinned: OPENCODE_CONFIG / _CONFIG_DIR / ' +
      '_CONFIG_CONTENT observed INERT in 1.18.18 — only HOME/XDG_CONFIG_HOME ' +
      'move the config; path helpers resolve via XDG only. opencode sets ' +
      'OPENCODE=1 (+OPENCODE_PID) in bash-tool children — detectHarness ' +
      'probes OPENCODE. AGENTS.md loads natively; CLAUDE.md is NOT ' +
      'double-loaded. opencode ships a JS plugin/event system — ' +
      'OPENCODE_HAS_HOOKS=false means "gbrain does not wire it yet" (follow-up ' +
      'filed), NOT "opencode has no hooks"; probes run with --pure + ' +
      'OPENCODE_DISABLE_AUTOUPDATE=1 because mcp list autoloads plugins. ' +
      'Skills: no attested native skills DIR for direct file installs; a ' +
      'direct-copy target needs an observation run before a default ships ' +
      '(harness-bridge requires an explicit dest).',
  },
};

// ── Claude Code shapes the writers consume ──────────────────────────────────

/** Settings file the hook writer targets, relative to the workspace root. */
export const CLAUDE_SETTINGS_FILE_RELPATH = join('.claude', 'settings.local.json');

/** The COMMITTED hook carrier [D12]. Cloud sessions clone the repo fresh and
 * snapshot hook config at session start — the gitignored settings.local.json
 * never exists there, and hooks written mid-session never activate. Cloud and
 * attach installs therefore write hooks into the repo-committed
 * `.claude/settings.json` with a PATH-resolved fail-open command (no absolute
 * paths — the file travels between machines). Local installs keep
 * settings.local.json; the writers enforce that one event never fires from
 * both files. */
export const CLAUDE_COMMITTED_SETTINGS_FILE_RELPATH = join('.claude', 'settings.json');

/** Hook events bootstrap wires (plan D5 + hook events table).
 * v0.45.7 ambient recall adds PreCompact: it BANKS the window's standing
 * entities into session_context_state so the post-compaction SessionStart
 * (source=compact — Claude Code's actual rehydration re-entry point) can
 * serve a warm context pack. PreCompact stdout is NOT context-injected by
 * the harness; the banking write is the point. */
export const CLAUDE_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'Stop',
  'SessionEnd',
  'PreCompact',
] as const;
export type ClaudeHookEvent = (typeof CLAUDE_HOOK_EVENTS)[number];

/** `gbrain hook <subcommand>` per event (src/commands/hook.ts dispatch). */
export const CLAUDE_HOOK_SUBCOMMAND: Record<ClaudeHookEvent, string> = {
  SessionStart: 'session-start',
  UserPromptSubmit: 'user-prompt',
  Stop: 'stop',
  SessionEnd: 'session-end',
  PreCompact: 'compact',
};

/**
 * Harness-side cap on hook stdout / additionalContext [ENG-1]: overflow is
 * diverted to a file and NOT injected, so every producer budgets below this.
 */
export const CLAUDE_HOOK_OUTPUT_CAP_CHARS = 10000;

/**
 * Default per-event `timeout` (SECONDS — the settings-file unit) written by
 * the hook installer. Each sits above the command's own self-deadline
 * (session-start ≤1.5s, user-prompt ≤800ms) so the harness timeout is the
 * backstop, never the primary limiter; session-end parses a full transcript
 * and may push, so it gets the widest budget.
 */
export const CLAUDE_HOOK_DEFAULT_TIMEOUT_SECS: Record<ClaudeHookEvent, number> = {
  SessionStart: 5,
  UserPromptSubmit: 3,
  Stop: 10,
  SessionEnd: 60,
  PreCompact: 5,
};

/**
 * Marker property carried by every hook command object bootstrap writes
 * [G5, CX2-17]. The structural JSON merger keys removal/dedupe on this —
 * NEVER on command-string equality (which breaks when the binary path or
 * env values change between runs).
 */
export const GBRAIN_HOOK_MARKER_KEY = '_gbrain';
export const GBRAIN_HOOK_MARKER_VALUE = 'bootstrap-v1';

/**
 * Marker VALUE for harness-mode installs (`gbrain bootstrap harness`, #4043).
 * Same `_gbrain` key, distinct value: a box can carry a workspace bootstrap
 * install (bootstrap-v1 in settings.local.json) AND a harness install
 * (bootstrap-harness-v1 in user settings.json or a project settings.local.json)
 * — each removal path strips only its own entries.
 */
export const GBRAIN_HARNESS_MARKER_VALUE = 'bootstrap-harness-v1';

/**
 * User-scope Claude Code settings file (harness-mode hook + permissions
 * target). Resolution mirrors Claude Code itself: CLAUDE_CONFIG_DIR (its
 * documented config-dir override, which the real-claude e2e harness sets)
 * else $HOME/.claude — checked explicitly because Bun's homedir() reads the
 * password database, NOT the HOME env var, so a sandboxed test that remaps
 * HOME would otherwise write into the operator's REAL settings file (this
 * bit us; the write-ahead receipt's remove path self-healed it).
 */
/**
 * The one CLAUDE_CONFIG_DIR-else-HOME-env-else-homedir() resolution (Bun's
 * homedir() reads the password DB, not $HOME — the sandboxed-test hazard
 * documented on claudeUserSettingsPath). Returns the directory that plays
 * the role of `~/.claude` for paths that live INSIDE it (settings.json,
 * skills/). NOT for claudeUserMcpConfigPath — its default lives at the HOME
 * level (`~/.claude.json`), a genuinely different shape.
 */
function claudeConfigBase(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (configDir) return configDir;
  const home = process.env.HOME?.trim();
  return join(home || homedir(), '.claude');
}

export function claudeUserSettingsPath(): string {
  return join(claudeConfigBase(), 'settings.json');
}

/** permissions.allow entry that pre-approves an MCP server's tools for headless runs. */
export function mcpPermissionEntry(serverName: string): string {
  return `mcp__${serverName}`;
}

/**
 * User-scope Claude Code MCP registration store (`claude mcp add` user scope
 * writes here). Same HOME-env-first discipline as claudeUserSettingsPath —
 * Bun's homedir() reads the password database, not $HOME, so a sandboxed
 * test that remaps HOME would otherwise read the operator's REAL config.
 */
export function claudeUserMcpConfigPath(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (configDir) return join(configDir, '.claude.json');
  const home = process.env.HOME?.trim();
  return join(home || homedir(), '.claude.json');
}

/** Where Claude Code stores session transcripts — the confinement root [S3#8]. */
export function claudeProjectsDir(): string {
  return join(homedir(), '.claude', 'projects');
}

/**
 * User-scope Claude Code skills dir (native SKILL.md discovery — the
 * harness-bridge install target). Same CLAUDE_CONFIG_DIR-first then
 * HOME-env-first discipline as claudeUserSettingsPath: Bun's homedir()
 * reads the password database, not $HOME, so a sandboxed test that remaps
 * HOME would otherwise write into the operator's REAL skills dir.
 */
export function claudeUserSkillsDir(): string {
  return join(claudeConfigBase(), 'skills');
}

/**
 * Project-scope Claude Code skills dir (`<workspace>/.claude/skills`).
 * Provisional-from-docs: the user-scope dir is the attested location; the
 * project-scope layout mirrors Claude Code's settings precedence.
 */
export function claudeProjectSkillsDir(workspaceDir: string): string {
  return join(workspaceDir, '.claude', 'skills');
}

// ── Codex shapes ────────────────────────────────────────────────────────────

/**
 * Codex CLI config file (user-global). Real codex resolves CODEX_HOME as the
 * config DIRECTORY itself (config.toml sits directly inside it) — pinned by
 * test/e2e/bootstrap-real-codex.serial.test.ts and connect-bearer.test.ts,
 * which set CODEX_HOME to a temp dir and assert the real binary wrote there.
 * A homedir-only resolution here would make any CODEX_HOME-isolated test
 * clobber the operator's real ~/.codex/config.toml.
 */
export function codexConfigPath(): string {
  const codexHome = process.env.CODEX_HOME?.trim();
  return join(codexHome || join(homedir(), '.codex'), 'config.toml');
}

/**
 * Whether gbrain WIRES codex hooks. False = not yet: codex 0.147.0 ships a
 * real hook system (hooks.json; PreToolUse…SessionEnd — see the TARGETS
 * note), but gbrain's codex hook lane is a filed follow-up; per-turn context
 * on codex remains the pull-protocol AGENTS.md gates (plan D5).
 */
export const CODEX_HAS_HOOKS = false;

/**
 * Managed-block markers for the harness lane's direct config.toml writes
 * (codex-toml.ts — the CX2-17 revisit, fired by #4043). Full-line exact
 * match at column 0; the writer requires exactly one begin/end pair.
 */
export const CODEX_TOML_BLOCK_BEGIN =
  `# gbrain:${GBRAIN_HARNESS_MARKER_VALUE} begin - managed by \`gbrain bootstrap harness\`; do not edit inside`;
export const CODEX_TOML_BLOCK_END = `# gbrain:${GBRAIN_HARNESS_MARKER_VALUE} end`;

// ── opencode shapes ─────────────────────────────────────────────────────────

/**
 * opencode config DIRECTORY (user-global). Resolution mirrors what the real
 * binary was OBSERVED to do (OPENCODE-CLI-PIN.md §Path seams): XDG_CONFIG_HOME
 * else $HOME/.config, then /opencode. The OPENCODE_CONFIG / OPENCODE_CONFIG_DIR
 * / OPENCODE_CONFIG_CONTENT env vars are deliberately NOT honored here —
 * observed INERT in opencode 1.18.18 (probes registered through each were
 * invisible to `mcp list` while the XDG-resolved config was still read), so
 * honoring them would write registrations into a file opencode never reads (a
 * silent no-op install). HOME is read from the env explicitly because Bun's
 * homedir() reads the password database, not the HOME env var (the
 * claudeUserSettingsPath lesson).
 */
export function opencodeConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  if (xdg) return join(xdg, 'opencode');
  const home = process.env.HOME?.trim();
  return join(home || homedir(), '.config', 'opencode');
}

/**
 * User-global opencode config FILE. Both `opencode.json` and `opencode.jsonc`
 * are read (merged) by the host when both exist; gbrain edits the file that
 * already carries content, preferring `.jsonc` (the name `opencode mcp add`
 * itself writes) when both or neither exist — one-owner-per-file keeps the
 * merge unambiguous for `mcp.gbrain`.
 */
export function opencodeGlobalConfigPath(): string {
  const dir = opencodeConfigDir();
  const jsonc = join(dir, 'opencode.jsonc');
  const json = join(dir, 'opencode.json');
  if (existsSync(jsonc)) return jsonc;
  if (existsSync(json)) return json;
  return jsonc;
}

/**
 * The OTHER member of the global filename pair for a given config path
 * (`opencode.json` ↔ `opencode.jsonc` in the same dir), or null when the
 * basename is not a pair member. opencode MERGES both files when both exist,
 * so global WRITERS must reconcile `mcp.<name>` across the pair — a same-name
 * entry left in the sibling survives as a shadow registration whose merge
 * winner is ambiguous (and a later removal of the primary "reveals" it).
 * Callers apply this to the USER-GLOBAL pair only; project-scope sibling
 * semantics are unobserved.
 */
export function opencodeGlobalSiblingPath(configPath: string): string | null {
  const dir = dirname(configPath);
  const base = basename(configPath);
  if (base === 'opencode.json') return join(dir, 'opencode.jsonc');
  if (base === 'opencode.jsonc') return join(dir, 'opencode.json');
  return null;
}

/** Project-scope opencode config (docs-canonical name; opencode's lookup
 * traverses up to the git root). Committed-file candidate — the writer's
 * PATH-resolved command + sharing-warning rules apply (OPENCODE.md). */
export function opencodeProjectConfigPath(workspaceDir: string): string {
  return join(workspaceDir, 'opencode.json');
}

/**
 * Whether gbrain WIRES opencode's hook/plugin system. False = not yet:
 * opencode ships a JS plugin/event system (and `--pure` to suppress it), but
 * gbrain's opencode plugin lane is a filed follow-up; per-turn context on
 * opencode rides the pull-protocol AGENTS.md gates, which opencode loads
 * natively (verified — and CLAUDE.md is NOT double-loaded alongside it).
 */
export const OPENCODE_HAS_HOOKS = false;
