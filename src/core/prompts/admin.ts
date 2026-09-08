/**
 * Control layer over the prompt registry: read override state, validate and
 * persist an override, reset one.
 *
 * Separate from the CLI (`src/commands/prompts.ts`) so an HTTP admin surface
 * can reuse the same validation instead of reimplementing the placeholder
 * check. Overrides live in the config KV table under `prompts.<id>` — no
 * migration, and nothing is cached process-wide: call sites resolve through
 * `resolvePromptText` on every run, so a saved override takes effect on the
 * next LLM call without a restart.
 */

import type { BrainEngine } from '../engine.ts';
import { PROMPT_REGISTRY, getPromptDef, type PromptDef } from './registry.ts';
import {
  getPromptOverride,
  promptConfigKey,
  missingPlaceholders,
  effectivePromptVersion,
} from './resolve.ts';

/** Registry entry + live override state. */
export interface PromptStatus {
  id: string;
  group: PromptDef['group'];
  label: string;
  description: string;
  defined_at: string;
  editable: boolean;
  required_placeholders: string[];
  default_text: string;
  /** Non-null when an operator override is active. */
  override_text: string | null;
  overridden: boolean;
  /** Effective version for version-cached phases (digest-suffixed when overridden). */
  effective_version: string | null;
}

/**
 * Override size cap. Generous next to the largest built-in prompt, small
 * enough that a paste accident can't push a multi-megabyte row into config.
 */
export const MAX_PROMPT_CHARS = 32_000;

async function toStatus(engine: BrainEngine, def: PromptDef): Promise<PromptStatus> {
  const override = def.editable ? await getPromptOverride(engine, def.id) : null;
  const effectiveText = override ?? def.defaultText;
  return {
    id: def.id,
    group: def.group,
    label: def.label,
    description: def.description,
    defined_at: def.definedAt,
    editable: def.editable,
    required_placeholders: def.requiredPlaceholders,
    default_text: def.defaultText,
    override_text: override,
    overridden: override !== null,
    effective_version: def.baseVersion
      ? effectivePromptVersion(def.baseVersion, def.defaultText, effectiveText)
      : null,
  };
}

/** Every registry entry with its live override state. */
export async function listPrompts(engine: BrainEngine): Promise<PromptStatus[]> {
  return Promise.all(PROMPT_REGISTRY.map((def) => toStatus(engine, def)));
}

/** One registry entry with its live override state; null for an unknown id. */
export async function getPromptStatus(engine: BrainEngine, id: string): Promise<PromptStatus | null> {
  const def = getPromptDef(id);
  return def ? toStatus(engine, def) : null;
}

/** Carries an HTTP-shaped status so a route layer needs no error mapping. */
export class PromptAdminError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Validate + persist an override. Returns the fresh status. */
export async function setPromptOverride(
  engine: BrainEngine,
  id: string,
  text: unknown,
): Promise<PromptStatus> {
  const def = getPromptDef(id);
  if (!def) throw new PromptAdminError('unknown_prompt_id', 404);
  if (!def.editable) throw new PromptAdminError('prompt_not_editable', 400);
  if (typeof text !== 'string' || text.trim() === '') {
    throw new PromptAdminError('text_required', 400);
  }
  if (text.length > MAX_PROMPT_CHARS) {
    throw new PromptAdminError(`text_too_long (max ${MAX_PROMPT_CHARS} chars)`, 400);
  }
  const missing = missingPlaceholders(text, def.requiredPlaceholders);
  if (missing.length > 0) {
    throw new PromptAdminError(
      `missing_placeholders: ${missing.map((m) => `{${m}}`).join(', ')} — the call site substitutes these at runtime; the override must keep them`,
      400,
    );
  }
  // Saving the default text verbatim = reset. A config row holding today's
  // default would shadow an improved default shipped by a later upgrade.
  if (text === def.defaultText) {
    await engine.unsetConfig(promptConfigKey(id));
  } else {
    await engine.setConfig(promptConfigKey(id), text);
  }
  return toStatus(engine, def);
}

/** Remove an override, restoring the built-in default. */
export async function resetPromptOverride(engine: BrainEngine, id: string): Promise<PromptStatus> {
  const def = getPromptDef(id);
  if (!def) throw new PromptAdminError('unknown_prompt_id', 404);
  await engine.unsetConfig(promptConfigKey(id));
  return toStatus(engine, def);
}
