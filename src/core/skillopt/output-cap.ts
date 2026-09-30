/**
 * SkillOpt output-token caps.
 *
 * Thinking-by-default optimizers (Claude 5, recipe-declared
 * `thinking_by_default`) spend reasoning tokens inside `maxTokens`, so the
 * small fixed caps skillopt used to send cut replies off mid-JSON. Two caps:
 *
 *   - The REFLECT cap governs every optimizer call (patch + rewrite reflect
 *     and the eval-internal one-shot ablation). Precedence: explicit value
 *     (`--reflect-max-tokens`, MCP / job `reflect_max_tokens`) >
 *     `skillopt.reflect_max_tokens` config > `defaultMaxOutputTokens(optimizer)`
 *     (32000 thinking, 4096 otherwise). Configured values are honored exactly,
 *     including values below the default.
 *   - `skilloptOutputCap` gives the judge and bootstrap-row sites headroom on
 *     thinking models (`max(siteCap, 8192)`) and leaves every other model on
 *     its site cap. The gateway's own maxTokens semantics are untouched.
 */

import type { BrainEngine } from '../engine.ts';
import { defaultMaxOutputTokens, isThinkingModel, THINKING_MODEL_MAX_OUTPUT_TOKENS } from '../ai/gateway.ts';

export const REFLECT_MAX_TOKENS_CONFIG_KEY = 'skillopt.reflect_max_tokens';
/** Floor for remote (MCP / job) reflect caps; local flag + config are honored exactly. */
export const REFLECT_MAX_TOKENS_MIN = 256;
/** Judge + bootstrap-row output floor for thinking models. */
export const SKILLOPT_THINKING_SITE_FLOOR = 8192;

export type ReflectCapSource = 'flag' | 'config' | 'default';

export interface ReflectCap {
  maxTokens: number;
  source: ReflectCapSource;
}

export function skilloptOutputCap(model: string | undefined, siteCap: number): number {
  return isThinkingModel(model) ? Math.max(siteCap, SKILLOPT_THINKING_SITE_FLOOR) : siteCap;
}

/** Positive-integer parse shared by the CLI flag, config value and remote params. */
export function parsePositiveInt(raw: unknown): number | undefined {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw.trim()) : NaN;
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * Validate an untrusted reflect cap (MCP op param, background job data):
 * absent -> undefined; not a positive integer -> throws; otherwise clamped to
 * [REFLECT_MAX_TOKENS_MIN, THINKING_MODEL_MAX_OUTPUT_TOKENS].
 */
export function clampRemoteReflectMaxTokens(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  const n = parsePositiveInt(raw);
  if (n === undefined) {
    throw new Error(`reflect_max_tokens must be a positive integer (got ${JSON.stringify(raw)})`);
  }
  return Math.min(THINKING_MODEL_MAX_OUTPUT_TOKENS, Math.max(REFLECT_MAX_TOKENS_MIN, n));
}

const warnedInvalidConfig = new Set<string>();

export async function resolveReflectMaxTokens(
  engine: Pick<BrainEngine, 'getConfig'>,
  optimizerModel: string,
  explicit?: number,
): Promise<ReflectCap> {
  if (explicit !== undefined) return { maxTokens: explicit, source: 'flag' };
  let raw: string | null = null;
  try {
    raw = await engine.getConfig(REFLECT_MAX_TOKENS_CONFIG_KEY);
  } catch { /* unreadable config -> default */ }
  if (raw !== null && raw !== undefined && raw.trim() !== '') {
    const n = parsePositiveInt(raw);
    if (n !== undefined) return { maxTokens: n, source: 'config' };
    if (!warnedInvalidConfig.has(raw)) {
      warnedInvalidConfig.add(raw);
      process.stderr.write(`[skillopt] ignoring ${REFLECT_MAX_TOKENS_CONFIG_KEY}=${JSON.stringify(raw.slice(0, 200))} (not a positive integer); using the default\n`);
    }
  }
  return { maxTokens: defaultMaxOutputTokens(optimizerModel), source: 'default' };
}
