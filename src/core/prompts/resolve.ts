/**
 * Prompt override resolution — the runtime half of the prompt registry.
 *
 * Operators can override any *editable* prompt's text from the admin UI
 * (Prompts page), which persists to the config KV table under
 * `prompts.<id>`. Call sites resolve through `resolvePromptText()` so the
 * DB override wins when present and the hardcoded default applies
 * otherwise. This module deliberately imports nothing from the registry
 * (`registry.ts` imports prompt constants from feature modules, which in
 * turn import THIS module — keeping resolve.ts dependency-free avoids the
 * cycle).
 *
 * Design constraints:
 *   - `engine` is optional at every call site (some extraction paths run
 *     without a DB handle). No engine → default text, never a throw.
 *   - A config read failure (table missing on old brains, transient DB
 *     error) also falls back to the default — a prompt lookup must never
 *     take down an LLM phase.
 *   - Empty/whitespace-only overrides are treated as unset so a botched
 *     save can't silently blank a system prompt.
 */

import { createHash } from 'crypto';
import type { BrainEngine } from '../engine.ts';

export const PROMPT_CONFIG_PREFIX = 'prompts.';

/** Config key that stores the override for a given prompt id. */
export function promptConfigKey(id: string): string {
  return `${PROMPT_CONFIG_PREFIX}${id}`;
}

/**
 * Read the raw override text for a prompt id, or null when unset/unreadable.
 */
export async function getPromptOverride(
  engine: BrainEngine | null | undefined,
  id: string,
): Promise<string | null> {
  if (!engine) return null;
  try {
    const raw = await engine.getConfig(promptConfigKey(id));
    if (raw == null || raw.trim() === '') return null;
    return raw;
  } catch {
    return null;
  }
}

/**
 * Resolve the effective prompt text: DB override (admin UI) > `defaultText`.
 */
export async function resolvePromptText(
  engine: BrainEngine | null | undefined,
  id: string,
  defaultText: string,
): Promise<string> {
  return (await getPromptOverride(engine, id)) ?? defaultText;
}

/**
 * Stable 8-hex-char digest of a prompt's effective text. Appended to
 * prompt-version constants (propose_takes / grade_takes skip-seen caches)
 * so an operator override invalidates version-keyed caches instead of
 * silently reusing verdicts produced by different instructions.
 */
export function promptTextDigest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 8);
}

/**
 * Compose the effective prompt version for version-cached phases:
 * unchanged when running on the default text, `<base>+<digest>` when an
 * override is active.
 */
export function effectivePromptVersion(
  baseVersion: string,
  defaultText: string,
  effectiveText: string,
): string {
  if (effectiveText === defaultText) return baseVersion;
  return `${baseVersion}+${promptTextDigest(effectiveText)}`;
}

/**
 * Placeholder tokens (e.g. `{PAGE_BODY}`) present in `text`. Used by the
 * admin PUT route to refuse an override that drops a placeholder the
 * call site substitutes at runtime.
 */
export function extractPlaceholders(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\{([A-Z][A-Z0-9_]*)\}/g)) out.add(m[1]);
  return [...out];
}

/** Placeholders from `required` that are missing in `text`. */
export function missingPlaceholders(text: string, required: string[]): string[] {
  const present = new Set(extractPlaceholders(text));
  return required.filter((p) => !present.has(p));
}
