/**
 * anthropic-model-ids — version grammar for Anthropic tier-family model ids.
 *
 * Parses `claude-<family>-<major>[-<minor>][-<YYYYMMDD>]` for the three tier
 * families (`haiku`, `sonnet`, `opus`), with an optional `anthropic:` (or
 * `anthropic/`) prefix. The 8-digit segment is a snapshot date, never a
 * version: `claude-haiku-4-5` and `claude-haiku-4-5-20251001` compare equal.
 * `fable` is not a tier family, and other providers (including OpenRouter's
 * `openrouter:anthropic/...` transport form) and unknown shapes parse to null,
 * so callers degrade to "no opinion" rather than a wrong comparison.
 *
 * `newerAnthropicModel` answers "does the anthropic recipe ship a newer priced
 * model in this id's family?" — advisory only (the `gbrain models` hint); it
 * never changes a default.
 */

import { splitProviderModelId } from '../model-id.ts';
import { canonicalLookup } from '../model-pricing.ts';
import { anthropic } from './recipes/anthropic.ts';

export type AnthropicFamily = 'haiku' | 'sonnet' | 'opus';

export interface ParsedAnthropicModelId {
  /** Bare model id (provider prefix stripped). */
  id: string;
  family: AnthropicFamily;
  major: number;
  minor: number;
  date?: string;
}

const ANTHROPIC_ID_RE = /^claude-(haiku|sonnet|opus)-(\d{1,2})(?:-(\d{1,2}))?(?:-(\d{8}))?$/;

export function parseAnthropicModelId(model: string): ParsedAnthropicModelId | null {
  const { provider, model: id } = splitProviderModelId(model);
  if (provider !== null && provider !== 'anthropic') return null;
  const m = ANTHROPIC_ID_RE.exec(id);
  if (!m) return null;
  return {
    id,
    family: m[1] as AnthropicFamily,
    major: Number(m[2]),
    minor: m[3] === undefined ? 0 : Number(m[3]),
    ...(m[4] ? { date: m[4] } : {}),
  };
}

/** Version order within a family: major, then minor. Snapshot dates are ignored. */
export function compareAnthropicVersions(a: ParsedAnthropicModelId, b: ParsedAnthropicModelId): number {
  return a.major - b.major || a.minor - b.minor;
}

/**
 * The anthropic recipe's newest priced chat model in `model`'s family when it
 * is strictly newer than `model`; null when `model` is current, newer than the
 * recipe, unpriced-family-only, fable, non-Anthropic or unparseable.
 */
export function newerAnthropicModel(
  model: string,
  ids: readonly string[] = anthropic.touchpoints.chat?.models ?? [],
  priced: (id: string) => boolean = (id) => canonicalLookup(`anthropic:${id}`) !== undefined,
): ParsedAnthropicModelId | null {
  const current = parseAnthropicModelId(model);
  if (!current) return null;
  let newest: ParsedAnthropicModelId | null = null;
  for (const id of ids) {
    const p = parseAnthropicModelId(id);
    if (!p || p.family !== current.family || !priced(id)) continue;
    if (!newest || compareAnthropicVersions(p, newest) > 0) newest = p;
  }
  return newest && compareAnthropicVersions(newest, current) > 0 ? newest : null;
}
