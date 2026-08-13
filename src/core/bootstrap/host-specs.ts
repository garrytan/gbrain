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

import { homedir } from 'node:os';
import { join } from 'node:path';

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
      'bank serves a warm pack through.',
  },
  [CODEX_SPEC_ID]: {
    id: CODEX_SPEC_ID,
    status: 'provisional',
    verifiedAt: '2026-08-08',
    references: [
      'docs/mcp/CODEX.md',
      'https://developers.openai.com/codex/mcp',
    ],
    note:
      'Codex has NO hook system — the pull-protocol AGENTS.md gates are the ' +
      'per-turn seam (plan D5). Local stdio MCP registration: ' +
      '`codex mcp add <name> [--env K=V]... -- <command> [args...]`, which ' +
      'writes [mcp_servers.<name>] into ~/.codex/config.toml. A TOML-aware ' +
      'config.toml writer [CX2-17] is deliberately NOT needed in v1: ' +
      '`codex mcp add` owns the config.toml write end-to-end, so gbrain never ' +
      'edits the file directly. Revisit only if a v1.1 feature (notify ' +
      'sweeper, FF2) must write keys `codex mcp add` cannot express.',
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

/** Where Claude Code stores session transcripts — the confinement root [S3#8]. */
export function claudeProjectsDir(): string {
  return join(homedir(), '.claude', 'projects');
}

// ── Codex shapes ────────────────────────────────────────────────────────────

/** Codex CLI's default user-global config file, written by `codex mcp add`.
 * Independently managed project config may instead live at
 * `<workspace>/.codex/config.toml`; gbrain detects/adopts but never writes it. */
export function codexConfigPath(): string {
  return join(homedir(), '.codex', 'config.toml');
}

/** Codex has no hook system — per-turn context is pull-protocol (plan D5). */
export const CODEX_HAS_HOOKS = false;
