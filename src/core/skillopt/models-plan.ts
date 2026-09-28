/**
 * SkillOpt models plan: which model every touchpoint of a run will call and
 * which configuration chose it.
 *
 * `resolveSkillOptModels` is the ONE resolution of the optimizer / target /
 * judge roles (tiers deep / subagent / reasoning) shared by the CLI, the
 * `run_skillopt` MCP op, the cycle phase and the background job handler.
 * `buildModelsPlan` adds the engine-internal touchpoints a run can reach:
 * per-task `judge.model` overrides (benchmark + held-out), the gateway's
 * expansion and chat models (provenance retained by
 * `reconfigureGatewayWithEngine`), the embedding model of the column search
 * actually reads, and the reranker when search enables it.
 *
 * Strict mode (`--models-strict` / `skillopt.models_strict`) guarantees that
 * every ACTIVE model was chosen by explicit, touchpoint-specific
 * configuration: a touchpoint resolved through `models.default`, a built-in
 * default, a capability substitution or unknown provenance aborts the run
 * before any spend with a copy-paste fix per touchpoint. Aliases are allowed;
 * the guarantee is about who chose the model, not a fixed identity.
 *
 * Every echoed string (model ids, origins, raw config values) passes
 * `sanitizeEcho`: control characters stripped, capped at 200 chars.
 */

import { getChatModel, getExpansionModel } from '../ai/gateway.ts';
import { getGatewayModelSource } from '../ai/gateway-model-sources.ts';
import { loadConfig, loadConfigFileOnly, loadConfigWithEngine } from '../config.ts';
import type { ConfigReader } from '../config-snapshot.ts';
import type { BrainEngine } from '../engine.ts';
import { errorFor } from '../errors.ts';
import {
  describeResolveOrigin,
  resolveModelDetailed,
  TIER_DEFAULTS,
  type ModelTier,
  type ResolveSource,
} from '../model-config.ts';
import { DEFAULT_COLUMN_NAME, resolveEmbeddingColumn } from '../search/embedding-column.ts';
import { loadSearchModeConfig, resolveSearchMode } from '../search/mode.ts';
import type { ReflectCap } from './output-cap.ts';
import type { BenchmarkTask } from './types.ts';

export type ModelSource = ResolveSource | 'file_config' | 'benchmark' | 'unknown';

export interface ModelResolution {
  model: string;
  source: ModelSource;
  /** Flag / config key / env var that supplied the model, or `built-in default`. */
  origin: string;
  substituted_from?: string;
  substitution_reason?: string;
}

export type SkillOptRole = 'optimizer' | 'target' | 'judge';

export type SkillOptModels = Record<SkillOptRole, ModelResolution>;

export type PlanTouchpoint = SkillOptRole | 'expansion' | 'chat' | 'embedding' | 'reranker';

export interface ModelsPlanEntry extends ModelResolution {
  touchpoint: PlanTouchpoint;
  active: boolean;
  inactive_reason?: string;
}

export interface StrictViolation {
  touchpoint: PlanTouchpoint;
  model: string;
  source: ModelSource;
  origin: string;
  /** Copy-paste remediation (a `gbrain config set` line, or the embedding config path). */
  fix: string;
}

export interface StrictVerdict {
  enabled: boolean;
  ok: boolean;
  violations: StrictViolation[];
  /** Raw `skillopt.models_strict` value that was not recognized (treated as on). */
  unrecognized_value?: string;
}

export const MODELS_STRICT_CONFIG_KEY = 'skillopt.models_strict';

const ECHO_MAX_CHARS = 200;

/** Strip control characters / newlines and cap at 200 chars. */
export function sanitizeEcho(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, ECHO_MAX_CHARS);
}

const ROLE_RESOLUTION: Record<SkillOptRole, { tier: ModelTier; flag: string }> = {
  optimizer: { tier: 'deep', flag: '--optimizer-model' },
  target: { tier: 'subagent', flag: '--target-model' },
  judge: { tier: 'reasoning', flag: '--judge-model' },
};

export interface SkillOptModelFlags {
  optimizerModel?: string;
  targetModel?: string;
  judgeModel?: string;
}

/**
 * Resolve the three skillopt roles: flag > role config chain (tier config,
 * `models.default`, env, key-aware tier default). Reports the source, the
 * origin key and any subagent capability substitution.
 */
export async function resolveSkillOptModels(
  engine: ConfigReader | null,
  flags: SkillOptModelFlags = {},
): Promise<SkillOptModels> {
  const flagFor: Record<SkillOptRole, string | undefined> = {
    optimizer: flags.optimizerModel,
    target: flags.targetModel,
    judge: flags.judgeModel,
  };
  const out = {} as SkillOptModels;
  for (const role of ['optimizer', 'target', 'judge'] as const) {
    const { tier, flag } = ROLE_RESOLUTION[role];
    const r = await resolveModelDetailed(engine, { cliFlag: flagFor[role], tier, fallback: TIER_DEFAULTS[tier] });
    out[role] = {
      model: sanitizeEcho(r.model),
      source: r.source,
      origin: describeResolveOrigin(r.source, { tier, flag }),
      ...(r.substituted_from ? { substituted_from: sanitizeEcho(r.substituted_from), substitution_reason: r.substitution_reason } : {}),
    };
  }
  return out;
}

/** Role provenance for models handed over without one (programmatic callers, legacy jobs): fail-closed `unknown`. */
export function unknownProvenanceModels(
  models: { optimizerModel: string; targetModel: string; judgeModel: string },
  origin: string,
): SkillOptModels {
  const entry = (model: string): ModelResolution => ({ model: sanitizeEcho(model), source: 'unknown', origin });
  return { optimizer: entry(models.optimizerModel), target: entry(models.targetModel), judge: entry(models.judgeModel) };
}

/** Spread into SkillOptOpts: the role models plus their provenance. */
export function skillOptModelOpts(models: SkillOptModels): {
  optimizerModel: string; targetModel: string; judgeModel: string; models: SkillOptModels;
} {
  return { optimizerModel: models.optimizer.model, targetModel: models.target.model, judgeModel: models.judge.model, models };
}

function judgeUsage(tasks: readonly BenchmarkTask[] | undefined): {
  defaultActive: boolean; inactiveReason?: string; overrides: Map<string, number>;
} {
  const overrides = new Map<string, number>();
  if (!tasks) return { defaultActive: true, overrides };
  let llmTasks = 0;
  let defaultActive = false;
  for (const t of tasks) {
    const judge = t.judge as { kind?: string; model?: unknown };
    if (judge.kind === 'rule' || judge.kind === 'qrels') continue;
    llmTasks += 1;
    const override = judge.kind === 'llm' && typeof judge.model === 'string' ? judge.model.trim() : '';
    if (override) overrides.set(override, (overrides.get(override) ?? 0) + 1);
    else defaultActive = true;
  }
  if (defaultActive) return { defaultActive, overrides };
  return { defaultActive, inactiveReason: llmTasks === 0 ? 'rule/qrels benchmark' : 'every LLM task sets judge.model', overrides };
}

function gatewayEntry(touchpoint: 'expansion' | 'chat'): ModelsPlanEntry {
  let model: string;
  try {
    model = touchpoint === 'expansion' ? getExpansionModel() : getChatModel();
  } catch {
    return { touchpoint, model: '(gateway unconfigured)', source: 'unknown', origin: 'gateway unconfigured', active: true };
  }
  const src = getGatewayModelSource(touchpoint, model);
  return {
    touchpoint,
    model: sanitizeEcho(model),
    source: src?.source ?? 'unknown',
    origin: src?.origin ?? 'unrecorded: gateway not resolved against this brain',
    active: true,
  };
}

/**
 * Embedding provenance from the resolver search itself uses: the active
 * column (`search_embedding_column` / `embedding_columns`), else the
 * file-plane `embedding_model` or `GBRAIN_EMBEDDING_MODEL`. DB-plane
 * `embedding_model` rows are never merged into search config, so they are
 * never reported as the source.
 */
async function embeddingEntry(engine: BrainEngine): Promise<ModelsPlanEntry> {
  const unknown = (origin: string): ModelsPlanEntry =>
    ({ touchpoint: 'embedding', model: '(unresolved)', source: 'unknown', origin, active: true });
  let column;
  let explicitDefaultColumn = false;
  try {
    const cfg = (await loadConfigWithEngine(engine).catch(() => null)) ?? loadConfig() ?? { engine: engine.kind };
    column = resolveEmbeddingColumn(undefined, cfg);
    const userColumns: unknown = cfg.embedding_columns;
    explicitDefaultColumn = typeof userColumns === 'object' && userColumns !== null && Object.hasOwn(userColumns, DEFAULT_COLUMN_NAME);
  } catch (err) {
    return unknown(sanitizeEcho(`embedding column unresolved: ${err instanceof Error ? err.message : String(err)}`));
  }
  if (!column.embeddingModel) return unknown('unverified embedding identity (gbrain migrate embeddings --status)');
  const model = sanitizeEcho(column.embeddingModel);
  if (column.name !== DEFAULT_COLUMN_NAME) {
    return { touchpoint: 'embedding', model, source: 'config_key', origin: sanitizeEcho(`search_embedding_column=${column.name} (embedding_columns)`), active: true };
  }
  if (explicitDefaultColumn) {
    return { touchpoint: 'embedding', model, source: 'config_key', origin: `embedding_columns.${DEFAULT_COLUMN_NAME}`, active: true };
  }
  if (process.env.GBRAIN_EMBEDDING_MODEL?.trim()) {
    return { touchpoint: 'embedding', model, source: 'env', origin: 'GBRAIN_EMBEDDING_MODEL', active: true };
  }
  let fileModel: string | undefined;
  try { fileModel = loadConfigFileOnly()?.embedding_model?.trim(); } catch { /* unreadable file plane */ }
  return fileModel
    ? { touchpoint: 'embedding', model, source: 'file_config', origin: 'embedding_model (config.json)', active: true }
    : { touchpoint: 'embedding', model, source: 'fallback', origin: 'built-in default', active: true };
}

/** Reranker entry, only when search enables reranking. */
async function rerankerEntry(engine: BrainEngine): Promise<ModelsPlanEntry | null> {
  let input;
  try { input = await loadSearchModeConfig(engine); } catch { return null; }
  const knobs = resolveSearchMode(input);
  if (!knobs.reranker_enabled) return null;
  const explicit = input.overrides?.reranker_model !== undefined;
  return {
    touchpoint: 'reranker',
    model: sanitizeEcho(knobs.reranker_model),
    source: explicit ? 'config_key' : 'fallback',
    origin: explicit ? 'search.reranker.model' : `built-in default, search.mode ${knobs.resolved_mode}`,
    active: true,
  };
}

/**
 * Full plan for one run. `tasks` are every task the run can judge
 * (benchmark + held-out); omitted, the default judge is assumed active.
 */
export async function buildModelsPlan(
  engine: BrainEngine,
  models: SkillOptModels,
  tasks?: readonly BenchmarkTask[],
): Promise<ModelsPlanEntry[]> {
  const judges = judgeUsage(tasks);
  const plan: ModelsPlanEntry[] = [
    { touchpoint: 'optimizer', ...models.optimizer, active: true },
    { touchpoint: 'target', ...models.target, active: true },
    {
      touchpoint: 'judge',
      ...models.judge,
      active: judges.defaultActive,
      ...(judges.inactiveReason ? { inactive_reason: judges.inactiveReason } : {}),
    },
  ];
  for (const [model, count] of judges.overrides) {
    plan.push({
      touchpoint: 'judge',
      model: sanitizeEcho(model),
      source: 'benchmark',
      origin: `benchmark judge.model, ${count} task${count === 1 ? '' : 's'}`,
      active: true,
    });
  }
  plan.push(gatewayEntry('expansion'), gatewayEntry('chat'), await embeddingEntry(engine));
  const reranker = await rerankerEntry(engine);
  if (reranker) plan.push(reranker);
  return plan;
}

const FALLBACK_SOURCES: ReadonlySet<ModelSource> = new Set(['models_default', 'tier_default', 'fallback', 'unknown']);

/** Origin as echoed: the key, plus the substitution when the capability gate replaced the configured model. */
function originText(e: ModelResolution): string {
  return e.substituted_from
    ? `${e.origin} -> substituted: ${e.substitution_reason ?? 'unsupported'}; configured ${e.substituted_from}`
    : e.origin;
}

/** True when strict mode counts this entry's choice as a fallback (not explicit configuration). */
export function isFallbackChoice(entry: ModelResolution): boolean {
  return FALLBACK_SOURCES.has(entry.source) || entry.substituted_from !== undefined;
}

const FIX_KEY: Record<Exclude<PlanTouchpoint, 'embedding'>, string> = {
  optimizer: 'models.tier.deep',
  target: 'models.tier.subagent',
  judge: 'models.tier.reasoning',
  expansion: 'models.tier.utility',
  chat: 'models.chat',
  reranker: 'search.reranker.model',
};

function fixFor(entry: ModelsPlanEntry): string {
  if (entry.touchpoint === 'embedding') {
    return `set embedding_model in ~/.gbrain/config.json or export GBRAIN_EMBEDDING_MODEL=${entry.model} (changing the embedding model needs a migration: gbrain migrate embeddings --status)`;
  }
  return `gbrain config set ${FIX_KEY[entry.touchpoint]} ${entry.model}`;
}

export function strictVerdict(
  plan: readonly ModelsPlanEntry[],
  strict: { on: boolean; unrecognized?: string },
): StrictVerdict {
  const violations = plan
    .filter((e) => e.active && isFallbackChoice(e))
    .map((e) => ({ touchpoint: e.touchpoint, model: e.model, source: e.source, origin: originText(e), fix: fixFor(e) }));
  return {
    enabled: strict.on,
    ok: violations.length === 0,
    violations,
    ...(strict.unrecognized !== undefined ? { unrecognized_value: strict.unrecognized } : {}),
  };
}

const STRICT_ON = new Set(['true', '1', 'yes', 'on']);
const STRICT_OFF = new Set(['false', '0', 'no', 'off', '']);
const warnedStrictValues = new Set<string>();

/** `true|1|yes|on` on; `false|0|no|off|empty` off; anything else warns once and counts as ON. */
export function parseModelsStrict(raw: string | null | undefined): { on: boolean; unrecognized?: string } {
  if (raw === null || raw === undefined) return { on: false };
  const v = raw.trim().toLowerCase();
  if (STRICT_ON.has(v)) return { on: true };
  if (STRICT_OFF.has(v)) return { on: false };
  const unrecognized = sanitizeEcho(raw);
  if (!warnedStrictValues.has(unrecognized)) {
    warnedStrictValues.add(unrecognized);
    process.stderr.write(`[skillopt] ${MODELS_STRICT_CONFIG_KEY}='${unrecognized}' is not a recognized value (true/false); treating it as on\n`);
  }
  return { on: true, unrecognized };
}

/** `--models-strict` (flag) wins; otherwise `skillopt.models_strict` config. */
export async function resolveModelsStrict(
  engine: ConfigReader,
  flag?: boolean,
): Promise<{ on: boolean; unrecognized?: string }> {
  if (flag === true) return { on: true };
  let raw: string | null | undefined = null;
  try {
    raw = await engine.getConfig(MODELS_STRICT_CONFIG_KEY);
  } catch {
    // Fail closed: an unreadable policy must not silently disable enforcement.
    process.stderr.write(`[skillopt] could not read ${MODELS_STRICT_CONFIG_KEY}; treating strict mode as on\n`);
    return { on: true };
  }
  return parseModelsStrict(raw);
}

/** Multi-line verdict: pass, or each offending touchpoint with its copy-paste fix. */
export function describeStrictVerdict(verdict: StrictVerdict): string {
  if (verdict.ok) return 'models strict check: pass (every active model was chosen by explicit configuration)';
  const lines = [
    `models strict check: ${verdict.violations.length} active model touchpoint(s) were not chosen by touchpoint-specific configuration:`,
  ];
  for (const v of verdict.violations) {
    lines.push(`  ${v.touchpoint}  ${v.model}  (${v.origin})`, `    ${v.fix}`);
  }
  if (verdict.unrecognized_value !== undefined) {
    lines.push(`(${MODELS_STRICT_CONFIG_KEY}='${verdict.unrecognized_value}' treated as on)`);
  }
  return lines.join('\n');
}

/** Pre-spend strict abort listing each offending touchpoint with its fix. */
export function modelsStrictError(verdict: StrictVerdict): Error {
  return errorFor({
    class: 'ModelsStrict',
    code: 'models_strict_violation',
    message: describeStrictVerdict(verdict),
    hint: `run the listed commands, or turn strict mode off (drop --models-strict; gbrain config set ${MODELS_STRICT_CONFIG_KEY} false)`,
  });
}

const FALLBACK_FOOTNOTE = '* not chosen by touchpoint-specific configuration (models.default, a built-in default, a substitution or unknown provenance); --models-strict aborts on these';

function bannerRow(e: ModelsPlanEntry): string {
  const origin = e.active ? originText(e) : `inactive: ${e.inactive_reason ?? 'unused'}`;
  const mark = e.active && isFallbackChoice(e) ? ' *' : '';
  return `${e.touchpoint.padEnd(9)}  ${e.model}  (${origin})${mark}`;
}

const sameEntry = (a: ModelsPlanEntry, b: ModelsPlanEntry): boolean =>
  a.touchpoint === b.touchpoint && a.model === b.model && a.source === b.source && a.origin === b.origin && a.active === b.active;

/**
 * Stderr banner. With `baseline` (batch / cycle runs after the invocation
 * banner) only rows that differ from it print, and nothing when none do.
 */
export function formatModelsBanner(
  plan: readonly ModelsPlanEntry[],
  opts: { skill?: string; baseline?: readonly ModelsPlanEntry[]; reflectCap?: ReflectCap } = {},
): string {
  const rows = opts.baseline ? plan.filter((e) => !opts.baseline!.some((b) => sameEntry(b, e))) : plan;
  if (rows.length === 0) return '';
  const scope = opts.skill ? ` for ${sanitizeEcho(opts.skill)}` : '';
  const lines = [opts.baseline ? `[skillopt] Models${scope} (differs from the run banner):` : `[skillopt] Models${scope}:`];
  for (const e of rows) lines.push(`[skillopt]   ${bannerRow(e)}`);
  if (opts.reflectCap && !opts.baseline) {
    lines.push(`[skillopt]   optimizer output cap ${opts.reflectCap.maxTokens} tokens (${opts.reflectCap.source === 'flag' ? '--reflect-max-tokens' : opts.reflectCap.source === 'config' ? 'skillopt.reflect_max_tokens' : 'default'})`);
  }
  if (rows.some((e) => e.active && isFallbackChoice(e))) lines.push(`[skillopt]   ${FALLBACK_FOOTNOTE}`);
  return lines.join('\n') + '\n';
}
