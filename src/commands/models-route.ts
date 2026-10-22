/**
 * `gbrain models route <preset> [--apply] [--undo] [--json]` — an opt-in
 * routing preset that points every chat-shaped model surface at one provider.
 * Nothing selects a preset by default: the user runs the command, reads the
 * dry run, and applies it.
 *
 * The one preset today is `claude-cli`: every tier, the global default, the
 * `haiku`/`sonnet`/`opus` aliases and the caller-specific routes that read
 * their own key first (fact extraction, atom extraction, the edge-contradiction
 * judge, the brainstorm judge, pinned questions) go to the local `claude` binary, which
 * authenticates with the user's own Claude Code login. Every call on that
 * route, background jobs included, draws on the user's Claude plan usage
 * limits; the guide (docs/guides/claude-subscription.md) says so and points
 * at Anthropic's current terms for automated use. Per-tier choice: utility →
 * Haiku, reasoning/default/subagent → Sonnet, deep → Opus. Nothing else
 * changes: pricing stays at the recipe's nominal API-list rate so the dollar
 * caps keep throttling usage, embeddings are not touched (claude-cli has
 * none), and `chat_fallback_chain` is left alone.
 *
 * Dry run by default: the command prints the before → after rows and writes
 * nothing until `--apply`. The first apply stores the previous value of every
 * key it writes under `models.route.undo` (a JSON map, `null` for unset) and
 * `models.route` names the preset; `--undo` previews the restore and
 * `--undo --apply` restores those values, then clears both keys. A second
 * apply keeps the original snapshot, so undo always returns to the state
 * before the preset was first applied. Without a snapshot (keys set by hand),
 * `--undo --apply` unsets every preset key, which is the documented manual
 * rollback: `gbrain config unset <key>` for each row below.
 *
 * `routeSurfaces()` is the read side the `subscription_routing` doctor check
 * uses: every surface `gbrain models` reports (tiers, per-task routes, the
 * nightly probe's routes), the reranker and the fallback chain, each tagged
 * with whether it stays on the preset's provider, would bill another provider
 * whose key is present, or would fail for lack of a key.
 */
import type { BrainEngine } from '../core/engine.ts';
import { loadConfig, type GBrainConfig } from '../core/config.ts';
import { mergedProviderEnv } from '../core/ai/provider-env.ts';
import { RECIPES } from '../core/ai/recipes/index.ts';
import { splitProviderModelId } from '../core/model-id.ts';
import { readChatFallbackPlanes } from '../core/ai/chat-fallback-planes.ts';
import { resolveProbeEnabled } from '../core/cycle/nightly-quality-probe.ts';

export type RoutePresetId = 'claude-cli';

export interface RoutePresetKey {
  key: string;
  value: string;
  /** Why the preset sets this key (printed in the preview). */
  why: string;
}

export interface RoutePreset {
  id: RoutePresetId;
  provider: string;
  summary: string;
  keys: ReadonlyArray<RoutePresetKey>;
}

export const ROUTE_MARKER_KEY = 'models.route';
export const ROUTE_UNDO_KEY = 'models.route.undo';

const CLAUDE_CLI_HAIKU = 'claude-cli:claude-haiku-5-5';
const CLAUDE_CLI_SONNET = 'claude-cli:claude-sonnet-5-5';
const CLAUDE_CLI_OPUS = 'claude-cli:claude-opus-5-5';

export const CLAUDE_CLI_ROUTE_PRESET: RoutePreset = {
  id: 'claude-cli',
  provider: 'claude-cli',
  summary: 'every chat surface on your Claude subscription through the local `claude` CLI (opt-in; every call, background jobs included, uses your plan\'s usage limits)',
  keys: [
    { key: 'models.default', value: CLAUDE_CLI_SONNET, why: 'global default for every surface no tier or per-task key covers' },
    { key: 'models.tier.utility', value: CLAUDE_CLI_HAIKU, why: 'bulk work: expansion, atom extraction, synopses, classification' },
    { key: 'models.tier.reasoning', value: CLAUDE_CLI_SONNET, why: 'synthesis, chat, drift and pattern judges' },
    { key: 'models.tier.deep', value: CLAUDE_CLI_OPUS, why: 'think, standing questions' },
    { key: 'models.tier.subagent', value: CLAUDE_CLI_SONNET, why: 'the `gbrain agent run` tool loop (claude-cli supports it)' },
    { key: 'models.aliases.haiku', value: CLAUDE_CLI_HAIKU, why: 'so a `haiku` alias in any other key stays on the subscription' },
    { key: 'models.aliases.sonnet', value: CLAUDE_CLI_SONNET, why: 'same for `sonnet`' },
    { key: 'models.aliases.opus', value: CLAUDE_CLI_OPUS, why: 'same for `opus`' },
    { key: 'facts.extraction_model', value: CLAUDE_CLI_HAIKU, why: 'fact extraction follows the reasoning tier when unset; Haiku is the measured default on Anthropic' },
    // The extract_atoms phase resolves its own key before any tier, so the
    // preset writes it rather than rely on the tier falling through.
    { key: 'models.dream.extract_atoms', value: CLAUDE_CLI_HAIKU, why: 'atom extraction reads its own key first' },
    // These two callers also read their own key before any tier, so a pin
    // left there would keep billing its provider after the preset.
    { key: 'models.dream.edge_contradictions', value: CLAUDE_CLI_HAIKU, why: 'the edge-contradiction judge reads its own key first' },
    { key: 'models.brainstorm.judge', value: CLAUDE_CLI_SONNET, why: 'the brainstorm judge reads its own key first' },
    // Pinned questions read models.standing_questions, then the retired
    // models.auto_think, before the deep tier: setting the newer key
    // shadows a leftover auto_think pin.
    { key: 'models.standing_questions', value: CLAUDE_CLI_OPUS, why: 'pinned questions read it (then the retired models.auto_think) before the deep tier' },
  ],
};

export const ROUTE_PRESETS: ReadonlyMap<RoutePresetId, RoutePreset> = new Map([
  [CLAUDE_CLI_ROUTE_PRESET.id, CLAUDE_CLI_ROUTE_PRESET],
]);

export type RouteChange = 'set' | 'unchanged' | 'unset' | 'restore';

export interface RouteRow {
  key: string;
  before: string | null;
  after: string | null;
  change: RouteChange;
  why?: string;
}

export interface RoutePlan {
  schema_version: 1;
  preset: RoutePresetId;
  mode: 'preview' | 'apply' | 'undo-preview' | 'undo';
  rows: RouteRow[];
  /** Undo had no stored snapshot: the rows unset every preset key instead of restoring values. */
  undo_without_snapshot?: boolean;
  applied: boolean;
}

async function readConfig(engine: BrainEngine, key: string): Promise<string | null> {
  const v = await engine.getConfig(key);
  return v && v.trim() ? v.trim() : null;
}

/** The rows `--apply` would write for `preset`, against the brain's current values. */
export async function planRoute(engine: BrainEngine, preset: RoutePreset): Promise<RoutePlan> {
  const rows: RouteRow[] = [];
  for (const k of preset.keys) {
    const before = await readConfig(engine, k.key);
    rows.push({ key: k.key, before, after: k.value, change: before === k.value ? 'unchanged' : 'set', why: k.why });
  }
  const marker = await readConfig(engine, ROUTE_MARKER_KEY);
  rows.push({ key: ROUTE_MARKER_KEY, before: marker, after: preset.id, change: marker === preset.id ? 'unchanged' : 'set', why: 'names the preset so `gbrain doctor` can report surfaces that leave it' });
  return { schema_version: 1, preset: preset.id, mode: 'preview', rows, applied: false };
}

function parseSnapshot(raw: string | null): Record<string, string | null> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const out: Record<string, string | null> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (v === null || typeof v === 'string') out[k] = v;
    }
    return out;
  } catch {
    return null;
  }
}

/** Write the plan's `set` rows; the first apply stores the pre-apply values for `--undo`. */
export async function applyRoute(engine: BrainEngine, plan: RoutePlan): Promise<RoutePlan> {
  const existing = parseSnapshot(await readConfig(engine, ROUTE_UNDO_KEY));
  if (!existing) {
    const snapshot: Record<string, string | null> = {};
    for (const row of plan.rows) snapshot[row.key] = row.before;
    await engine.setConfig(ROUTE_UNDO_KEY, JSON.stringify(snapshot));
  }
  for (const row of plan.rows) {
    if (row.change === 'set' && row.after !== null) await engine.setConfig(row.key, row.after);
  }
  return { ...plan, mode: 'apply', applied: true };
}

/** The rows `--undo --apply` would write: the stored snapshot, else an unset of every preset key. */
export async function planUndo(engine: BrainEngine, preset: RoutePreset): Promise<RoutePlan> {
  const snapshot = parseSnapshot(await readConfig(engine, ROUTE_UNDO_KEY));
  const rows: RouteRow[] = [];
  const keys = snapshot ? Object.keys(snapshot) : [...preset.keys.map(k => k.key), ROUTE_MARKER_KEY];
  for (const key of keys) {
    const before = await readConfig(engine, key);
    const after = snapshot ? snapshot[key] ?? null : null;
    const change: RouteChange = before === after ? 'unchanged' : after === null ? 'unset' : 'restore';
    rows.push({ key, before, after, change });
  }
  return { schema_version: 1, preset: preset.id, mode: 'undo-preview', rows, applied: false, undo_without_snapshot: !snapshot };
}

/** Restore (or unset) every row, then clear the marker and the snapshot. */
export async function applyUndo(engine: BrainEngine, plan: RoutePlan): Promise<RoutePlan> {
  for (const row of plan.rows) {
    if (row.change === 'restore' && row.after !== null) await engine.setConfig(row.key, row.after);
    else if (row.change === 'unset') await engine.unsetConfig(row.key);
  }
  await engine.unsetConfig(ROUTE_MARKER_KEY);
  await engine.unsetConfig(ROUTE_UNDO_KEY);
  return { ...plan, mode: 'undo', applied: true };
}

// ── Read side: which surfaces stay on the preset's provider ──────────────

export type SurfaceStanding = 'stays' | 'bills_other_provider' | 'fails_no_key' | 'off';

export interface RouteSurface {
  /** `tier.utility`, `models.dream.synthesize`, `nightly_probe.reader`, `reranker`, `chat_fallback_chain[0]`, … */
  surface: string;
  model: string;
  /** Where the model came from, as `gbrain models` labels it. */
  source: string;
  provider: string | null;
  standing: SurfaceStanding;
  /** The missing credential when `standing` is `fails_no_key`. */
  missing_key?: string;
}

export interface EmbeddingStanding {
  model: string | null;
  provider: string | null;
  disabled: boolean;
  /** `local` (no key required), `keyed` (key present), `missing_key`, or `unset`. */
  standing: 'local' | 'keyed' | 'missing_key' | 'unset';
  missing_key?: string;
}

export interface RouteSurfaces {
  provider: string;
  surfaces: RouteSurface[];
  leaving: RouteSurface[];
  embedding: EmbeddingStanding;
  /** The nightly quality probe's routes count only while the probe is enabled. */
  nightly_probe: 'on' | 'off';
}

function throwSafeConfig(): GBrainConfig | null {
  try { return loadConfig(); } catch { return null; }
}

/**
 * The credential a provider lacks here, or null when it has one (or needs
 * none). A recipe with its own `authPresent` (TypeSafe accepts
 * JEV_TYPESAFE_API_KEY as well as TYPESAFE_API_KEY) decides by that, the way
 * the gateway's no-key preflight does.
 */
function missingCredential(providerId: string | null, env: Record<string, string>): string | null {
  const recipe = providerId ? RECIPES.get(providerId) : undefined;
  const required = recipe?.auth_env?.required ?? [];
  if (required.length === 0) return null;
  if (recipe?.authPresent) return recipe.authPresent(env) ? null : required[0]!;
  return required.find(k => !env[k]) ?? null;
}

function standingFor(model: string, provider: string, env: Record<string, string>): Pick<RouteSurface, 'provider' | 'standing' | 'missing_key'> {
  const { provider: p } = splitProviderModelId(model);
  const id = p?.trim().toLowerCase() ?? null;
  if (model === 'none') return { provider: id, standing: 'off' };
  if (id === provider) return { provider: id, standing: 'stays' };
  const missing = missingCredential(id, env);
  return missing ? { provider: id, standing: 'fails_no_key', missing_key: missing } : { provider: id, standing: 'bills_other_provider' };
}

/**
 * Every chat-shaped surface and where it would send a request, judged from
 * this process's environment (a key only in the daemon's env file reads as
 * absent here, the same caveat `gbrain models` prints).
 */
export async function routeSurfaces(engine: BrainEngine, provider: string): Promise<RouteSurfaces> {
  const { buildModelsReport, resolveLiveRerankerModel } = await import('./models.ts');
  const report = await buildModelsReport(engine);
  const cfg = throwSafeConfig();
  const env = mergedProviderEnv(cfg, process.env);
  const surfaces: RouteSurface[] = [];
  const push = (surface: string, model: string, source: string) =>
    surfaces.push({ surface, model, source, ...standingFor(model, provider, env) });

  for (const tier of Object.values(report.tiers)) push(`tier.${tier.tier}`, tier.resolved, tier.source);
  for (const row of report.per_task) push(row.key, row.resolved, row.source);
  // The probe's reader, extractor and judge panel only call a model while the
  // probe is on (dual-plane read, as autopilot resolves it); off, they are
  // routes nothing walks and would make every keyless brain warn on the panel.
  let probeDb: string | null = null;
  try { probeDb = await engine.getConfig('autopilot.nightly_quality_probe.enabled'); } catch { /* file plane only */ }
  const probeOn = resolveProbeEnabled(probeDb, cfg?.autopilot?.nightly_quality_probe?.enabled);
  if (probeOn) {
    push('nightly_probe.reader', report.nightly_probe.reader.model, report.nightly_probe.reader.source);
    push('nightly_probe.extractor', report.nightly_probe.extractor.model, report.nightly_probe.extractor.source);
    for (const slot of report.nightly_probe.slots) push(`nightly_probe.slot.${slot.id}`, slot.model, slot.source);
  }

  // The reranker is on in every default mode bundle; live search skips it
  // fail-open when its provider's key is absent (results pass through
  // unreranked), so a keyless reranker is `off`, not a surface that leaves.
  const reranker = await resolveLiveRerankerModel(engine);
  if (reranker) {
    const standing = standingFor(reranker, provider, env);
    surfaces.push({ surface: 'reranker', model: reranker, source: 'search mode (search.reranker.model)', ...standing,
      ...(standing.standing === 'fails_no_key' ? { standing: 'off' as const } : {}) });
  }

  try {
    const planes = await readChatFallbackPlanes(engine);
    (planes.effective?.chain ?? []).forEach((entry, i) => push(`chat_fallback_chain[${i}]`, entry, `config: chat_fallback_chain (${planes.effective!.plane})`));
  } catch { /* unreadable chain: the chat_fallback_chain check reports it */ }

  const embeddingModel = cfg?.embedding_model?.trim() || null;
  const embeddingProvider = embeddingModel ? splitProviderModelId(embeddingModel).provider?.trim().toLowerCase() ?? null : null;
  const embeddingRequired = embeddingProvider ? RECIPES.get(embeddingProvider)?.auth_env?.required ?? [] : [];
  const embeddingMissing = missingCredential(embeddingProvider, env);
  const embedding: EmbeddingStanding = {
    model: embeddingModel,
    provider: embeddingProvider,
    disabled: cfg?.embedding_disabled === true,
    standing: !embeddingModel ? 'unset' : embeddingRequired.length === 0 ? 'local' : embeddingMissing ? 'missing_key' : 'keyed',
    ...(embeddingMissing ? { missing_key: embeddingMissing } : {}),
  };

  return { provider, surfaces, leaving: surfaces.filter(s => s.standing === 'bills_other_provider' || s.standing === 'fails_no_key'), embedding, nightly_probe: probeOn ? 'on' : 'off' };
}

// ── CLI ──────────────────────────────────────────────────────────────────

const PRICING_NOTE = 'Pricing is untouched: claude-cli models keep the nominal API-list rate so spend caps keep throttling plan usage (`gbrain pricing set \'claude-cli:*\' --rate 0` turns that off).';

function fmtValue(v: string | null): string {
  return v ?? '(unset)';
}

function formatPlan(preset: RoutePreset, plan: RoutePlan): string {
  const lines: string[] = [];
  const undo = plan.mode === 'undo' || plan.mode === 'undo-preview';
  lines.push(undo
    ? `Undo route preset ${preset.id}${plan.undo_without_snapshot ? ' (no stored snapshot: every preset key is unset)' : ' (restores the values stored at apply)'}:`
    : `Route preset ${preset.id}: ${preset.summary}.`);
  const width = Math.max(...plan.rows.map(r => r.key.length));
  for (const r of plan.rows) {
    const arrow = r.change === 'unchanged' ? '=' : '→';
    const tail = r.change === 'unchanged' ? '  (unchanged)' : r.why ? `  # ${r.why}` : '';
    lines.push(`  ${r.key.padEnd(width)}  ${fmtValue(r.before)} ${arrow} ${fmtValue(r.after)}${tail}`);
  }
  lines.push('');
  if (plan.applied) {
    lines.push(undo
      ? `Restored. ${ROUTE_MARKER_KEY} and ${ROUTE_UNDO_KEY} are cleared; \`gbrain models\` shows the routing now in effect.`
      : `Applied. \`gbrain models\` shows the routing; \`gbrain doctor --only subscription_routing\` names any surface that still leaves ${preset.provider}. Undo with \`gbrain models route ${preset.id} --undo --apply\`.`);
  } else {
    lines.push(undo
      ? `Dry run: nothing written. Restore with \`gbrain models route ${preset.id} --undo --apply\`.`
      : `Dry run: nothing written. Apply with \`gbrain models route ${preset.id} --apply\`; undo later with \`--undo --apply\`.`);
  }
  if (!undo) {
    lines.push(`Every call on this route, background jobs included, draws on your Claude plan's usage limits; the guide names Anthropic's terms for automated use.`);
    lines.push(PRICING_NOTE);
    lines.push(`Embeddings are not routed (${preset.provider} has no embedding model): keep a local or keyed embedding provider, or run keyword-only. See docs/guides/claude-subscription.md.`);
  }
  return lines.join('\n');
}

export const ROUTE_USAGE = `Usage:
  gbrain models route <preset>                 Preview the keys the preset would set (dry run)
  gbrain models route <preset> --apply         Write them (the previous values are kept for --undo)
  gbrain models route <preset> --undo          Preview the restore
  gbrain models route <preset> --undo --apply  Restore the previous values (or unset the keys)
  --json                                       Machine-readable plan

Presets:
  claude-cli   ${CLAUDE_CLI_ROUTE_PRESET.summary}
`;

/** `gbrain models route …`; `args` starts after the `route` token. Exit 2 on usage errors. */
export async function runModelsRoute(engine: BrainEngine, args: string[]): Promise<void> {
  const json = args.includes('--json');
  const apply = args.includes('--apply');
  const undo = args.includes('--undo');
  const positional = args.filter(a => !a.startsWith('--'));
  const presetId = positional[0];
  const preset = presetId ? ROUTE_PRESETS.get(presetId as RoutePresetId) : undefined;
  if (!preset) {
    process.stderr.write(presetId ? `Unknown route preset "${presetId}".\n` : 'A route preset is required.\n');
    process.stderr.write(ROUTE_USAGE);
    process.exit(2);
  }
  const stray = args.find(a => a.startsWith('--') && !['--json', '--apply', '--undo'].includes(a));
  if (stray || positional.length > 1) {
    process.stderr.write(`Unknown argument "${stray ?? positional[1]}".\n${ROUTE_USAGE}`);
    process.exit(2);
  }

  let plan = undo ? await planUndo(engine, preset) : await planRoute(engine, preset);
  if (apply) plan = undo ? await applyUndo(engine, plan) : await applyRoute(engine, plan);

  if (json) process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
  else process.stdout.write(formatPlan(preset, plan) + '\n');
}
