/**
 * v0.41 Approach C — composable subagent system prompt renderer.
 *
 * Field-report case: a `shell` tool sat in the registry and the subagent
 * never used it because the default system prompt was one generic line
 * (`'You are a helpful assistant running as a gbrain subagent.'`) and gave
 * the model no guidance on WHICH tool to reach for. This module fixes that
 * by splicing a deterministic tool-guidance preamble into the system prompt
 * based on the actual `toolDefs` array, including any plugin-registered
 * tools the core has no knowledge of.
 *
 * Three properties matter for the Anthropic prompt-cache contract:
 *
 *  1. Deterministic — same `(toolDefs, userSystem, opts)` input produces
 *     byte-identical output. The Anthropic `cache_control: ephemeral`
 *     marker on the system block wraps OUR rendered string; if rendering
 *     drifted across runs, the cache marker would miss on every turn.
 *  2. Generative — works for plugin tools the core has never heard of.
 *     A downstream plugin that registers `playwright_navigate` with a
 *     `usage_hint` gets that hint surfaced automatically.
 *  3. Opinionated — the closing paragraph names `shell`/`bash` explicitly
 *     AND tells the model that brain tools (`put_page`, `search`, `query`)
 *     write to the brain DB, not the local filesystem. Both halves of the
 *     field-report bug (subagent didn't reach for shell + subagent wrote
 *     brain pages when files were wanted) collapse into one fix.
 *
 * Override paths preserved: caller's `data.system` overrides the default
 * generic line; `data.system_no_tool_preamble: true` skips the preamble
 * splice entirely so the caller's prompt stays byte-for-byte as provided.
 */

import type { ToolDef } from './types.ts';

export const DEFAULT_SUBAGENT_SYSTEM =
  'You are a helpful assistant running as a gbrain subagent.';

export interface SystemPromptOpts {
  /** Skip the auto-generated tool guidance preamble. */
  no_tool_preamble?: boolean;
}

/**
 * Render the final system prompt sent to the Anthropic Messages API.
 *
 * Composition order:
 *   - userSystem (or DEFAULT) — the caller's preamble.
 *   - blank line.
 *   - tool guidance preamble (when toolDefs is non-empty AND opts.no_tool_preamble !== true).
 *
 * Output is fully deterministic for a given input — required for the
 * Anthropic prompt-cache marker on the system block.
 */
export function buildSystemPrompt(
  toolDefs: ToolDef[],
  userSystem: string | undefined,
  opts: SystemPromptOpts = {},
): string {
  const base = userSystem ?? DEFAULT_SUBAGENT_SYSTEM;
  if (opts.no_tool_preamble || toolDefs.length === 0) return base;
  return base + '\n\n' + renderToolPreamble(toolDefs);
}

/**
 * Render the tool-usage preamble. Pure function; no I/O.
 *
 * Preamble shape (exact bytes, do not reorder — cache-marker stability):
 *
 *   You have the following tools available. Reach for them by default — do NOT
 *   describe file contents, hypothetical shell output, or planned database
 *   writes in prose. Call the tool.
 *
 *   - `tool_name` — usage_hint (when present)
 *   - `tool_name` (when no usage_hint)
 *   ...
 *
 *   When the task asks you to write a file, run a command, or modify the
 *   filesystem, prefer a `shell` or `bash` tool if one is in your registry.
 *   Brain tools (`put_page`, `search`, `query`) write to the gbrain database,
 *   not to local files.
 *
 * Tools are listed in the order the caller passed them — NO sorting. The
 * caller's order matches the order in the Anthropic `tools:` array, which
 * matches the order the model sees in its tool-choice context. Sorting
 * would diverge from that and confuse cache-marker reasoning.
 */
export function renderToolPreamble(toolDefs: ToolDef[]): string {
  const lines: string[] = [];
  for (const t of toolDefs) {
    if (t.usage_hint && t.usage_hint.trim()) {
      // Normalize any embedded whitespace/newlines so the rendered line
      // stays single-line. Defense against a plugin author shipping a
      // multi-line hint (which would corrupt the preamble layout).
      const hint = t.usage_hint.replace(/\s+/g, ' ').trim();
      lines.push(`- \`${t.name}\` — ${hint}`);
    } else {
      lines.push(`- \`${t.name}\``);
    }
  }
  return [
    'You have the following tools available. Reach for them by default — do NOT',
    'describe file contents, hypothetical shell output, or planned database',
    'writes in prose. Call the tool.',
    '',
    ...lines,
    '',
    'When the task asks you to write a file, run a command, or modify the',
    'filesystem, prefer a `shell` or `bash` tool if one is in your registry.',
    'Brain tools (`put_page`, `search`, `query`) write to the gbrain database,',
    'not to local files.',
  ].join('\n');
}
