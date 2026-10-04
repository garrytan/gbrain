/**
 * Capability readiness (agent operator contract v1, A7): one place that says
 * what this install can do, why not, and the fix. Two tiers:
 *
 * - config plane (`configReadiness`): synchronous, memoized per (config
 *   object, transport), in-memory config only. The one file read it allows is
 *   a memoized `peekLock()` for `lock_owner` (none when this process holds the
 *   lock itself). Used by MCP initialize, whoami and write receipts. On the
 *   CLI transport `harness_wiring` additionally resolves the absolute gbrain
 *   binary once per process (a PATH lookup); stdio and http never do.
 * - probed tier (`probedReadiness`): worker, backup (per asset), migrations,
 *   sync applicability; 60 s cache, single-flight, 2 s per-probe bound,
 *   stale-while-revalidate; never `getStats`/`getHealth`. Used by doctor and
 *   `gbrain://capabilities`.
 *
 * Consumer rule: never coach on `disabled_by_choice` (e.g. `init
 * --no-embedding`). Those entries still carry the enable command as `fix` so
 * doctor can show it as information, but notices and nudges must stay silent
 * (Lanes E/F).
 *
 * Exclusive fixes (they need the brain's single-writer lock) go through
 * `exclusiveFix`: commands that delegate to a running owner stay one step;
 * everything else becomes a two-step plan whose first step (actor `user`)
 * stops the owning serve named by `lock_owner`.
 */
import type { GBrainConfig } from './config.ts';
import { gbrainPath } from './config.ts';
import type { BrainEngine } from './engine.ts';
import { redactForTransport, type Action, type ActionInput, type Effect, type Transport } from './agent-output.ts';
import { detectCapabilities } from './capability.ts';
import { embeddingProviderConfigured } from './brain-score-recommendations.ts';
import { isEngineDegraded } from './degraded-marker.ts';
import { heldLockFor, peekLock, type LockPeekResult } from './pglite-lock.ts';
import { listRecipes, RECIPES } from './ai/recipes/index.ts';
import type { Recipe } from './ai/types.ts';
import { mergedProviderEnv } from './ai/provider-env.ts';
import { resolveSchemaEmbeddingDim } from './embedding-dim-check.ts';
import { DEFAULT_EMBEDDING_DIMENSIONS, NEW_INSTALL_DEFAULT_EMBEDDING_MODEL } from './ai/defaults.ts';
import { getCliOptions, parseGlobalFlags } from './cli-options.ts';
import { validateMountId } from './brain-registry.ts';
import { agentProcessMarker } from './interaction.ts';
import { resolveGbrainBin } from './gbrain-bin.ts';
import { resolveWritebackConfigFromFile } from './facts/writeback-config.ts';

export type ReadinessState = 'ok' | 'disabled_by_choice' | 'not_applicable' | 'missing' | 'degraded' | 'unknown';
export type CapabilityId =
  | 'embeddings' | 'chat_llm' | 'worker' | 'writeback' | 'backup' | 'tool_surface'
  | 'sync' | 'migrations' | 'harness_wiring' | 'local_transcripts';

export interface ReadinessEntry {
  capability: CapabilityId;
  state: ReadinessState;
  /** Closed vocabulary per capability (the `*_REASONS` consts below). */
  reason: string;
  why: string;
  fix?: Action;
  tier: 'config' | 'probed';
  /** backup: which asset. */
  asset?: string;
  /** false → stripped from the HTTP view. */
  http_visible: boolean;
}

export interface LockOwner { pid: number; transport: 'stdio' | 'http'; started_at?: string; is_self: boolean }
export interface ConfigReadiness { entries: ReadinessEntry[]; lock_owner: LockOwner | null }

/** Probe cache for the probed tier (process-wide on stdio/CLI; one per ServeHttpContext on HTTP). */
export interface ReadinessCache {
  get(key: string): { at: number; value: ReadinessEntry[] } | undefined;
  set(key: string, value: { at: number; value: ReadinessEntry[] }): void;
}

// ── closed reason vocabularies ─────────────────────────────────────────────

export const EMBEDDINGS_REASONS = [
  'configured', 'embedding_disabled', 'not_configured', 'key_missing', 'unknown_model', 'remote_brain',
] as const;
export const CHAT_LLM_REASONS = ['configured', 'not_configured', 'remote_brain'] as const;
export const WORKER_REASONS = [
  'worker_running', 'no_pending_jobs', 'no_worker', 'engine_unreachable', 'probe_failed', 'probe_timeout',
] as const;
export const WRITEBACK_REASONS = ['enabled', 'off_by_choice', 'not_configured', 'invalid_mode', 'remote_brain'] as const;
export const BACKUP_REASONS = [
  'verified', 'covered', 'no_remote', 'unpushed', 'dirty', 'failing', 'unverified', 'info',
  'engine_unreachable', 'probe_failed', 'probe_timeout',
] as const;
export const TOOL_SURFACE_REASONS = ['surface_full', 'surface_starter', 'surface_verbs', 'remote_brain'] as const;
export const SYNC_REASONS = [
  'git_sources', 'no_repo_sources', 'remote_brain', 'engine_unreachable', 'probe_failed', 'probe_timeout',
] as const;
export const MIGRATIONS_REASONS = ['current', 'pending', 'engine_unreachable', 'probe_failed', 'probe_timeout'] as const;
/** Raw session transcripts on the brain host: present (read through the CLI) or none. */
export const LOCAL_TRANSCRIPTS_REASONS = ['transcripts_cli_only', 'no_transcripts', 'engine_unreachable', 'probe_failed', 'probe_timeout'] as const;
export const HARNESS_WIRING_REASONS = [
  'wired_running', 'registration_unverified', 'http_serve_running', 'multiple_sessions', 'multiple_harnesses',
  'no_harness_detected', 'binary_unresolved', 'remote_transport',
] as const;

const VERIFY = (check: string) => ({ argv: ['gbrain', 'doctor', '--only', check, '--json'] });
const ENABLEMENT_DOCS = 'docs/guides/search-modes.md';

// ── brain axis (in-memory only) ────────────────────────────────────────────

/** `--brain` flag, then GBRAIN_BRAIN_ID; the `.gbrain-mount` dotfile walk is not read on the config plane. */
function brainIdInMemory(): string {
  const raw = getCliOptions().brain ?? process.env.GBRAIN_BRAIN_ID ?? 'host';
  if (!raw || raw === 'host') return 'host';
  try { return validateMountId(raw, '--brain value'); } catch { return 'host'; }
}

// ── embeddings ─────────────────────────────────────────────────────────────

interface EmbeddingChoice { recipe: Recipe; model: string }

function keyedEmbeddingRecipes(): Recipe[] {
  const canonical = NEW_INSTALL_DEFAULT_EMBEDDING_MODEL.split(':')[0];
  const keyed = listRecipes().filter(r => {
    const tp = r.touchpoints.embedding as { models?: string[]; user_provided_models?: boolean } | undefined;
    return !!tp?.models?.length && !tp.user_provided_models && (r.auth_env?.required?.length ?? 0) > 0;
  });
  return [...keyed.filter(r => r.id === canonical), ...keyed.filter(r => r.id !== canonical)];
}

function recipeKeyed(recipe: Recipe, env: Record<string, string>): boolean {
  return (recipe.auth_env?.required ?? []).every(k => !!env[k]);
}

/** The recipe's default model if it can produce `width`-dimensional vectors, else its first model that can. */
function modelForWidth(recipe: Recipe, width: number): string | null {
  const tp = recipe.touchpoints.embedding as { models: string[]; default_model?: string };
  const ordered = [tp.default_model, ...tp.models].filter((m): m is string => !!m);
  for (const model of ordered) {
    if (resolveSchemaEmbeddingDim({ embedding_model: `${recipe.id}:${model}`, embedding_dimensions: width }).ok) return model;
  }
  return null;
}

function firstChoice(recipes: Recipe[], width: number): EmbeddingChoice | null {
  for (const recipe of recipes) {
    const model = modelForWidth(recipe, width);
    if (model) return { recipe, model };
  }
  return null;
}

function providerLabel(recipe: Recipe): string {
  return recipe.name ?? recipe.id;
}

/** Provider keys `gbrain config set` stores on the file plane (src/commands/config.ts FILE_PLANE_API_KEYS). */
const FILE_PLANE_KEY_ENVS: ReadonlySet<string> = new Set([
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'VOYAGE_API_KEY', 'DASHSCOPE_API_KEY',
  'DEEPSEEK_API_KEY', 'LITELLM_API_KEY', 'TOGETHER_API_KEY', 'GOOGLE_API_KEY', 'AZURE_OPENAI_API_KEY',
]);

function keyHow(name: string): string {
  return FILE_PLANE_KEY_ENVS.has(name)
    ? `store it with \`gbrain config set ${name.toLowerCase()} <key>\` (every gbrain process reads it), or export ${name} in the environment of every gbrain process`
    : `export ${name}=<key> in the environment of every gbrain process, including the one your agent harness starts`;
}

function keyInput(recipe: Recipe): ActionInput[] {
  return (recipe.auth_env?.required ?? []).map(name => ({
    name,
    how: `Ask the user for an API key for ${providerLabel(recipe)}; ${keyHow(name)}. Then run the command.`,
  }));
}

/** The datastore the enable command must target, resolved before any argv is built. */
function enableArgv(cfg: GBrainConfig, model: string, width: number): string[] {
  const brainId = brainIdInMemory();
  if (brainId !== 'host') {
    return ['gbrain', 'embeddings', 'enable', '--brain', brainId, '--embedding-model', model, '--embedding-dimensions', String(width)];
  }
  const base = ['gbrain', 'init', '--force', '--embedding-model', model, '--embedding-dimensions', String(width)];
  if (cfg.engine === 'postgres') return base;
  return [...base, '--path', cfg.database_path ?? gbrainPath('brain.pglite')];
}

function datastoreLabel(cfg: GBrainConfig): string {
  const brainId = brainIdInMemory();
  if (brainId !== 'host') return `mounted brain '${brainId}' (the embedding model is set host-wide, so the host brain uses it too)`;
  return cfg.engine === 'postgres' ? 'this Postgres brain' : `the PGLite brain at ${cfg.database_path ?? gbrainPath('brain.pglite')}`;
}

const KEPT = 'Pages, facts and keyword search are kept; existing chunks and facts are queued for vectors, which `gbrain embed --stale` (or the next maintenance cycle) fills.';

function readyEnablement(cfg: GBrainConfig, choice: EmbeddingChoice, width: number): Action {
  const model = `${choice.recipe.id}:${choice.model}`;
  const label = providerLabel(choice.recipe);
  return {
    argv: enableArgv(cfg, model, width),
    consent: ['credentials', 'paid'],
    actor: 'agent',
    why: `Embeddings are off, so search is keyword-only. This turns on ${model} (${width}d) for ${datastoreLabel(cfg)} using the ${label} key already configured. ${KEPT}`,
    user_message: `I can turn on semantic search with ${label} (${model}). It uses your API key and costs a little per page embedded; your notes and saved facts stay as they are. OK to run it?`,
    verify: VERIFY('embeddings'),
    docs: ENABLEMENT_DOCS,
    requires_exclusive: true,
  };
}

function keyNeededEnablement(cfg: GBrainConfig, choice: EmbeddingChoice, width: number, note: string): Action {
  const model = `${choice.recipe.id}:${choice.model}`;
  const label = providerLabel(choice.recipe);
  return {
    argv: enableArgv(cfg, model, width),
    consent: ['credentials', 'paid'],
    actor: 'user',
    why: `Embeddings are off, so search is keyword-only, and no configured embedding key fits this brain.${note} Once the key is set this turns on ${model} (${width}d) for ${datastoreLabel(cfg)}. ${KEPT}`,
    user_message: `Semantic search needs an embedding API key. ${label} works with this brain; if you add a key (${(choice.recipe.auth_env?.required ?? []).join(', ')}), I can turn it on. Embedding costs a little per page; your notes and facts stay as they are.`,
    verify: VERIFY('embeddings'),
    docs: ENABLEMENT_DOCS,
    requires_exclusive: true,
    inputs: keyInput(choice.recipe),
  };
}

/** `cfg.embedding_model` as an explicit preference, when it names a known embedding model that fits `width`. */
function preferredChoice(cfg: GBrainConfig, width: number): EmbeddingChoice | null {
  const model = cfg.embedding_model?.trim();
  if (!model?.includes(':')) return null;
  const recipe = RECIPES.get(model.slice(0, model.indexOf(':')));
  if (!recipe?.touchpoints.embedding) return null;
  if (!resolveSchemaEmbeddingDim({ embedding_model: model, embedding_dimensions: width }).ok) return null;
  return { recipe, model: model.slice(model.indexOf(':') + 1) };
}

/**
 * The one "turn on embeddings" fix. Resolves the configured datastore (PGLite
 * path, Postgres, or a mounted brain via `--brain`/GBRAIN_BRAIN_ID) and the
 * brain's vector width (`embedding_dimensions`, default 1024), then picks a
 * model: `cfg.embedding_model` when set and it fits, else a keyed provider
 * that can produce that width. No key → the fix asks the user for one. A
 * width no keyed provider can produce → the fix names a provider that can
 * (or the migration preview when none can); nothing is rebuilt.
 */
export function embeddingEnablement(cfg: GBrainConfig): Action {
  const env = mergedProviderEnv(cfg);
  const width = cfg.embedding_dimensions ?? DEFAULT_EMBEDDING_DIMENSIONS;
  const preferred = preferredChoice(cfg, width);
  if (preferred) {
    return recipeKeyed(preferred.recipe, env) ? readyEnablement(cfg, preferred, width) : keyNeededEnablement(cfg, preferred, width, '');
  }
  const recipes = keyedEmbeddingRecipes();
  const ready = recipes.filter(r => recipeKeyed(r, env));
  const pick = firstChoice(ready, width);
  if (pick) return readyEnablement(cfg, pick, width);
  const ask = firstChoice(recipes, width);
  if (!ask) {
    return {
      argv: ['gbrain', 'migrate', 'embeddings', '--status', '--json'],
      consent: [],
      actor: 'agent',
      why: `This brain's vector column is ${width}-dimensional and no keyed embedding provider produces ${width}d vectors. Changing the width is a re-embed through \`gbrain migrate embeddings --to <provider:model> --dim <N> --dry-run\` (preview first; pages and facts are kept). Read the status, then ask the user which provider to use.`,
      verify: VERIFY('embeddings'),
      docs: 'docs/guides/embedding-migration.md',
      requires_exclusive: false,
    };
  }
  const note = ready.length > 0
    ? ` The configured ${ready.map(providerLabel).join(', ')} key${ready.length > 1 ? 's' : ''} cannot produce this brain's ${width}d vectors without rebuilding the vector column, so this uses ${providerLabel(ask.recipe)}, which can.`
    : '';
  return keyNeededEnablement(cfg, ask, width, note);
}

function embeddingsEntry(cfg: GBrainConfig): ReadinessEntry {
  const base = { capability: 'embeddings' as const, tier: 'config' as const, http_visible: true };
  if (cfg.remote_mcp) return { ...base, state: 'not_applicable', reason: 'remote_brain', why: 'Embeddings are configured on the remote brain host this thin client talks to.' };
  if (cfg.embedding_disabled) {
    return { ...base, state: 'disabled_by_choice', reason: 'embedding_disabled', why: 'This brain was set up keyless (`--no-embedding`): search is keyword-only by choice.', fix: embeddingEnablement(cfg) };
  }
  const model = cfg.embedding_model?.trim();
  if (!model) return { ...base, state: 'missing', reason: 'not_configured', why: 'No embedding model is configured, so search is keyword-only.', fix: embeddingEnablement(cfg) };
  const providerId = model.includes(':') ? model.slice(0, model.indexOf(':')) : model;
  const recipe = RECIPES.get(providerId);
  if (!recipe?.touchpoints.embedding) {
    return { ...base, state: 'degraded', reason: 'unknown_model', why: `The configured embedding model '${model}' is not a known embedding provider, so vectors cannot be computed.`, fix: embeddingEnablement({ ...cfg, embedding_model: undefined }) };
  }
  const env = mergedProviderEnv(cfg);
  if (embeddingProviderConfigured(model, k => !!env[k]) && detectCapabilities({ config: cfg }).embeddings.available) {
    return { ...base, state: 'ok', reason: 'configured', why: `Embeddings run on ${model}.` };
  }
  const keys = recipe.auth_env?.required ?? [];
  return {
    ...base, state: 'degraded', reason: 'key_missing',
    why: `Embeddings are configured for ${model} but ${keys.join(', ')} is not set, so new content gets no vectors and search falls back to keyword-only.`,
    fix: {
      consent: ['credentials'], actor: 'user', requires_exclusive: false,
      why: `Provide ${keys.join(', ')}: ${keys.map(keyHow).join('; ')}. Queued chunks then embed on the next \`gbrain embed --stale\`.`,
      user_message: `Semantic search is configured for ${providerLabel(recipe)} but its API key is missing. Can you add it?`,
      inputs: keyInput(recipe), verify: VERIFY('embeddings'),
    },
  };
}

// ── chat, writeback, tool surface ──────────────────────────────────────────

function chatEntry(cfg: GBrainConfig): ReadinessEntry {
  const base = { capability: 'chat_llm' as const, tier: 'config' as const, http_visible: true };
  if (cfg.remote_mcp) return { ...base, state: 'not_applicable', reason: 'remote_brain', why: 'Chat models run on the remote brain host.' };
  const caps = detectCapabilities({ config: cfg });
  if (caps.extraction.available) return { ...base, state: 'ok', reason: 'configured', why: `Automatic fact extraction and synthesis run on ${caps.extraction.provider}.` };
  return {
    ...base, state: 'missing', reason: 'not_configured',
    why: 'No chat model key is configured: memory comes from agent-authored facts and explicit writes; automatic extraction, enrichment and synthesis are off.',
    fix: {
      argv: ['gbrain', 'providers', 'list'], consent: ['credentials', 'paid'], actor: 'user', requires_exclusive: false,
      why: 'Adding one chat provider key (for example ANTHROPIC_API_KEY or OPENAI_API_KEY) turns on automatic extraction; `gbrain providers list` shows which keys each provider needs.',
      user_message: 'Automatic fact extraction needs a chat model API key (Anthropic or OpenAI, for example). Want to add one? It costs a little per page processed.',
      verify: VERIFY('facts_extraction_health'),
    },
  };
}

function writebackEntry(cfg: GBrainConfig): ReadinessEntry {
  const base = { capability: 'writeback' as const, tier: 'config' as const, http_visible: false };
  if (cfg.remote_mcp) return { ...base, state: 'not_applicable', reason: 'remote_brain', why: 'Ambient writeback is configured on the remote brain host.' };
  const wb = resolveWritebackConfigFromFile(cfg);
  if (wb.enabled) return { ...base, state: 'ok', reason: 'enabled', why: `Ambient memory writeback is on (${wb.mode}).` };
  const enable: Action = {
    argv: ['gbrain', 'config', 'set', 'memory.auto_writeback', 'salient'], consent: [], actor: 'user', requires_exclusive: false,
    why: 'Ambient writeback lets the agent save salient facts without being asked; it is opt-in, so the user decides.',
    user_message: 'Should I save important facts from our conversations automatically (ambient writeback, "salient" mode)? You can turn it off any time.',
    verify: { argv: ['gbrain', 'config', 'get', 'memory.auto_writeback'] }, docs: 'docs/guides/ambient-writeback.md',
  };
  if (!wb.mode_valid) return { ...base, state: 'degraded', reason: 'invalid_mode', why: `memory.auto_writeback is set to an unrecognized value, so writeback is off.`, fix: enable };
  if (wb.raw_mode === 'off') return { ...base, state: 'disabled_by_choice', reason: 'off_by_choice', why: 'Ambient memory writeback is turned off by choice.', fix: enable };
  return { ...base, state: 'missing', reason: 'not_configured', why: 'Ambient memory writeback has not been chosen; facts are saved only when asked.', fix: enable };
}

function toolSurfaceEntry(cfg: GBrainConfig): ReadinessEntry {
  const base = { capability: 'tool_surface' as const, tier: 'config' as const, http_visible: true, state: 'ok' as const };
  if (cfg.remote_mcp) return { ...base, state: 'not_applicable', reason: 'remote_brain', why: 'The tool surface is set by the remote brain host.' };
  const surface = cfg.mcp_surface ?? 'full';
  const why = surface === 'full' ? 'gbrain serve exposes every operation by default.'
    : surface === 'starter' ? 'gbrain serve defaults to the starter surface (the daily-driver tool set); `--surface full` exposes everything.'
      : 'gbrain serve defaults to the seven memory verbs; `--surface full` exposes everything.';
  return { ...base, reason: `surface_${surface}`, why };
}

function syncConfigEntry(cfg: GBrainConfig): ReadinessEntry | null {
  if (!cfg.remote_mcp) return null;
  return { capability: 'sync', tier: 'config', http_visible: false, state: 'not_applicable', reason: 'remote_brain', why: 'Sync runs on the remote brain host.' };
}

// ── lock ownership + exclusive fixes ───────────────────────────────────────

import { exclusiveFix } from './exclusive-fix.ts';

export { exclusiveFix };

let peekOverride: ((dataDir: string) => LockPeekResult) | null = null;
/** Test seam: count or fake the config plane's one lock read (null restores `peekLock`). */
export function __setLockPeekForTests(fn: ((dataDir: string) => LockPeekResult) | null): void { peekOverride = fn; }

function isServeProcess(): boolean {
  return parseGlobalFlags(process.argv.slice(2)).rest[0] === 'serve';
}

function lockOwnerFor(cfg: GBrainConfig): LockOwner | null {
  if (cfg.engine !== 'pglite' || cfg.remote_mcp || cfg.database_url) return null;
  const dataDir = cfg.database_path ?? gbrainPath('brain.pglite');
  const self = heldLockFor(dataDir);
  if (self) {
    if (!isServeProcess()) return null;
    return { pid: process.pid, transport: process.argv.includes('--http') ? 'http' : 'stdio',
      ...(self.acquiredAt ? { started_at: new Date(self.acquiredAt).toISOString() } : {}), is_self: true };
  }
  const peek = (peekOverride ?? peekLock)(dataDir);
  if (!peek.held || !peek.isServe || peek.pid === undefined) return null;
  return { pid: peek.pid, transport: peek.http ? 'http' : 'stdio',
    ...(peek.acquiredAt ? { started_at: new Date(peek.acquiredAt).toISOString() } : {}), is_self: peek.pid === process.pid };
}

// ── harness wiring ─────────────────────────────────────────────────────────

export type ReadinessHarness = 'claude-code' | 'codex' | 'opencode';
export interface HarnessWiringInput {
  transport: Transport;
  /** Harnesses detected on this machine (config plane: from process-scoped agent markers). */
  harnesses: readonly ReadinessHarness[];
  lockOwner: LockOwner | null;
  /** Absolute gbrain binary; null when it cannot be resolved (never registered bare). */
  gbrainBin: string | null;
}

const HARNESS_LABEL: Record<ReadinessHarness, string> = { 'claude-code': 'Claude Code', codex: 'Codex', opencode: 'opencode' };
const HARNESS_DESTINATION: Record<ReadinessHarness, string> = {
  'claude-code': 'the Claude Code MCP config (~/.claude.json)',
  codex: 'the Codex config (~/.codex/config.toml)',
  opencode: 'the opencode config (opencode.json)',
};
const MEMORY_VERBS_INSTALL = 'docs/protocol/MEMORY_VERBS_v1.md#install-the-4-command-quickstart';

function stdioRegistration(h: ReadinessHarness, bin: string): Action {
  const argv = h === 'claude-code' ? ['claude', 'mcp', 'add', 'gbrain', '--', bin, 'serve', '--surface', 'verbs']
    : h === 'codex' ? ['codex', 'mcp', 'add', 'gbrain', '--', bin, 'serve', '--surface', 'verbs']
      : ['gbrain', 'bootstrap', 'hooks', '--harness', 'opencode', '--no-hooks'];
  const hooks = h === 'opencode' ? ' No lifecycle hooks are installed (--no-hooks); it must run inside an initialized agent workspace.' : ' No hooks, tool pre-approvals or tokens are added.';
  return {
    argv, consent: ['persistent_install'], actor: 'agent', requires_exclusive: false,
    why: `Registers gbrain as a stdio MCP server (${bin} serve --surface verbs, the seven memory verbs) in ${HARNESS_DESTINATION[h]}, so new ${HARNESS_LABEL[h]} sessions get memory tools.${hooks}`,
    user_message: `I'd like to add gbrain's memory tools to ${HARNESS_LABEL[h]} by writing one MCP server entry to ${HARNESS_DESTINATION[h]}. OK?`,
    verify: VERIFY('harness_wiring'), docs: MEMORY_VERBS_INSTALL,
  };
}

function sharedHttpWiring(selector: ReadinessHarness | 'all'): Action {
  const names = selector === 'all' ? 'each detected harness' : HARNESS_LABEL[selector];
  return {
    argv: ['gbrain', 'bootstrap', 'harness', '--harness', selector, '--yes'],
    consent: ['persistent_install', 'credentials'], actor: 'agent', requires_exclusive: false,
    why: `Wires ${names} to the shared \`gbrain serve --http\` on this machine (it must be running): mints one bearer token per harness (scopes read+write), writes an HTTP MCP entry with that token to the harness config (Claude Code: ~/.claude.json plus a permissions.allow 'mcp__gbrain' pre-approval and lifecycle hooks in ~/.claude/settings.json; Codex: ~/.codex/config.toml; opencode: its user config), so several sessions share one brain without lock contention.`,
    user_message: `To let several agent sessions share this brain, I'd connect ${names} to the local gbrain HTTP server. That stores an access token in the harness config, pre-approves gbrain's tools and installs its session hooks. OK?`,
    verify: VERIFY('harness_wiring'), docs: 'docs/guides/remote-mcp.md',
  };
}

/** `harness_wiring` for a concrete detection result. Doctor (Lane E) passes filesystem-detected harnesses. */
export function harnessWiringEntry(input: HarnessWiringInput): ReadinessEntry {
  const base = { capability: 'harness_wiring' as const, tier: 'config' as const, http_visible: false };
  if (input.transport === 'stdio') return { ...base, state: 'ok', reason: 'wired_running', why: 'An agent harness launched this gbrain MCP server over stdio.' };
  if (input.transport === 'http') return { ...base, state: 'not_applicable', reason: 'remote_transport', why: 'Harness wiring is a property of the brain host.' };
  const { harnesses, lockOwner } = input;
  if (harnesses.length === 0) {
    return { ...base, state: 'missing', reason: 'no_harness_detected', why: 'No agent harness was detected.',
      fix: { consent: ['persistent_install'], actor: 'user', requires_exclusive: false, docs: MEMORY_VERBS_INSTALL,
        why: 'Register `<absolute path to gbrain> serve --surface verbs` as a stdio MCP server in your agent host; the install section lists the exact command per harness (Claude Code, Codex, Grok Build, opencode, OpenClaw).',
        user_message: 'Which agent app should get gbrain memory? The install guide has a one-line command for each.' } };
  }
  if (lockOwner?.transport === 'http') {
    return { ...base, state: 'unknown', reason: 'http_serve_running', why: 'A shared `gbrain serve --http` is running; harnesses should connect to it instead of starting their own stdio server.', fix: sharedHttpWiring(harnesses.length > 1 ? 'all' : harnesses[0]) };
  }
  if (lockOwner && !lockOwner.is_self) {
    return { ...base, state: 'degraded', reason: 'multiple_sessions', why: `Another gbrain serve (PID ${lockOwner.pid}) holds this brain, so a second stdio server cannot open it; sessions must share one \`gbrain serve --http\`.`, fix: sharedHttpWiring(harnesses.length > 1 ? 'all' : harnesses[0]) };
  }
  if (harnesses.length > 1) {
    return { ...base, state: 'unknown', reason: 'multiple_harnesses', why: `Several harnesses are installed (${harnesses.map(h => HARNESS_LABEL[h]).join(', ')}); they share one brain through \`gbrain serve --http\`.`, fix: sharedHttpWiring('all') };
  }
  const h = harnesses[0];
  if (!input.gbrainBin) {
    return { ...base, state: 'missing', reason: 'binary_unresolved', why: 'The gbrain binary is not on PATH as an absolute path, and harness registrations never use a bare `gbrain` (GUI hosts inherit no PATH).',
      fix: { consent: ['persistent_install'], actor: 'user', requires_exclusive: false, docs: 'INSTALL_FOR_AGENTS.md',
        why: 'Install gbrain globally (`bun install -g github:garrytan/gbrain`) so `gbrain` resolves to an absolute path, then re-run readiness.' } };
  }
  return { ...base, state: 'unknown', reason: 'registration_unverified', why: `${HARNESS_LABEL[h]} is the active harness; its gbrain registration has not been verified from this process.`, fix: stdioRegistration(h, input.gbrainBin) };
}

const MARKER_HARNESS: Record<string, ReadinessHarness> = {
  CLAUDECODE: 'claude-code', CLAUDE_CODE_ENTRYPOINT: 'claude-code', CODEX_SANDBOX: 'codex', CODEX_CI: 'codex', OPENCODE: 'opencode', OPENCODE_PID: 'opencode',
};

let cachedBin: { value: string | null } | null = null;

function harnessConfigEntry(transport: Transport, lockOwner: LockOwner | null): ReadinessEntry {
  if (transport !== 'cli') return harnessWiringEntry({ transport, harnesses: [], lockOwner, gbrainBin: null });
  const marker = agentProcessMarker();
  const harness = marker ? MARKER_HARNESS[marker] : undefined;
  cachedBin ??= { value: resolveGbrainBin() };
  return harnessWiringEntry({ transport, harnesses: harness ? [harness] : [], lockOwner, gbrainBin: cachedBin.value });
}

// ── config plane ───────────────────────────────────────────────────────────

const configMemo = new WeakMap<GBrainConfig, Map<Transport, ConfigReadiness>>();
const lockMemo = new WeakMap<GBrainConfig, LockOwner | null>();

/** Forget memoized config-plane results (status-mode re-probe, config reload). */
export function resetReadinessMemo(cfg?: GBrainConfig): void {
  if (cfg) { configMemo.delete(cfg); lockMemo.delete(cfg); }
  cachedBin = null;
}

/** The HTTP view: drop `http_visible: false` entries, then one redaction pass. */
export function readinessHttpView(entries: readonly ReadinessEntry[]): ReadinessEntry[] {
  return redactForTransport(entries.filter(e => e.http_visible), 'http');
}

export function configReadiness(cfg: GBrainConfig, ctx: { transport: Transport }): ConfigReadiness {
  const memo = configMemo.get(cfg)?.get(ctx.transport);
  if (memo) return memo;
  if (!lockMemo.has(cfg)) lockMemo.set(cfg, lockOwnerFor(cfg));
  const lockOwner = lockMemo.get(cfg) ?? null;
  const entries: ReadinessEntry[] = [embeddingsEntry(cfg), chatEntry(cfg), writebackEntry(cfg), toolSurfaceEntry(cfg)];
  const sync = syncConfigEntry(cfg);
  if (sync) entries.push(sync);
  entries.push(harnessConfigEntry(ctx.transport, lockOwner));
  const result: ConfigReadiness = ctx.transport === 'http'
    ? { entries: readinessHttpView(entries), lock_owner: null }
    : { entries: entries.map(e => (e.fix ? { ...e, fix: exclusiveFix(e.fix, lockOwner) } : e)), lock_owner: lockOwner };
  const byTransport = configMemo.get(cfg) ?? new Map<Transport, ConfigReadiness>();
  byTransport.set(ctx.transport, result);
  configMemo.set(cfg, byTransport);
  return result;
}

// ── probed tier ────────────────────────────────────────────────────────────

export const PROBED_TTL_MS = 60_000;
export const PROBE_TIMEOUT_MS = 2_000;
export const INITIALIZE_TAIL_MS = 250;

class MapCache implements ReadinessCache {
  private readonly m = new Map<string, { at: number; value: ReadinessEntry[] }>();
  get(key: string) { return this.m.get(key); }
  set(key: string, value: { at: number; value: ReadinessEntry[] }) { this.m.set(key, value); }
}
/** A fresh cache (one per ServeHttpContext on HTTP). */
export function createReadinessCache(): ReadinessCache { return new MapCache(); }
const processCache = createReadinessCache();

const engineIds = new WeakMap<object, number>();
let nextEngineId = 1;
function cacheKey(engine: BrainEngine): string {
  let id = engineIds.get(engine);
  if (id === undefined) { id = nextEngineId++; engineIds.set(engine, id); }
  return `probed:${id}`;
}
const inflight = new WeakMap<ReadinessCache, Map<string, Promise<ReadinessEntry[]>>>();

type ProbeResult = ReadinessEntry | ReadinessEntry[];
type Prober = { capability: CapabilityId; run(engine: BrainEngine): Promise<ProbeResult> };

function failedEntry(capability: CapabilityId, reason: 'probe_failed' | 'probe_timeout' | 'engine_unreachable'): ReadinessEntry {
  const why = reason === 'probe_timeout' ? `The ${capability} probe did not answer within ${PROBE_TIMEOUT_MS / 1000}s.`
    : reason === 'engine_unreachable' ? 'The database is unreachable, so this was not probed.'
      : `The ${capability} probe failed.`;
  return { capability, state: 'unknown', reason, why, tier: 'probed', http_visible: false,
    fix: { argv: ['gbrain', 'doctor', '--json'], consent: [], actor: 'agent', why: 'Doctor reports the underlying failure.', requires_exclusive: false } };
}

async function bounded(probe: Prober, engine: BrainEngine): Promise<ReadinessEntry[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), PROBE_TIMEOUT_MS); });
  try {
    const out = await Promise.race([probe.run(engine), timeout]);
    if (out === 'timeout') return [failedEntry(probe.capability, 'probe_timeout')];
    return Array.isArray(out) ? out : [out];
  } catch {
    return [failedEntry(probe.capability, 'probe_failed')];
  } finally {
    clearTimeout(timer);
  }
}

async function countWaitingJobs(engine: BrainEngine): Promise<number> {
  const [row] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM minion_jobs WHERE status = 'waiting'`);
  return Number(row?.n ?? 0);
}

const workerProbe: Prober = {
  capability: 'worker',
  async run(engine) {
    const base = { capability: 'worker' as const, tier: 'probed' as const, http_visible: false };
    const { readWorkers } = await import('./minions/worker-registry.ts');
    const live = readWorkers(() => null);
    if (live.length > 0) return { ...base, state: 'ok', reason: 'worker_running', why: `${live.length} job worker(s) are running.` };
    const waiting = await countWaitingJobs(engine);
    if (waiting === 0) return { ...base, state: 'ok', reason: 'no_pending_jobs', why: 'No job worker is running and no jobs are waiting.' };
    const pglite = engine.kind === 'pglite';
    return {
      ...base, state: 'missing', reason: 'no_worker',
      why: `${waiting} job(s) are waiting and no worker is running${pglite ? ' (PGLite has no background worker; jobs run with --follow or while a worker holds the brain)' : ''}.`,
      fix: pglite
        ? { argv: ['gbrain', 'jobs', 'work'], consent: [], actor: 'agent', requires_exclusive: true, why: 'Runs the waiting jobs in this process; stop it once the queue drains.', verify: VERIFY('queue_health') }
        : { argv: ['gbrain', 'jobs', 'supervisor', 'start'], consent: [], actor: 'agent', requires_exclusive: false, why: 'Starts the job supervisor, which keeps a worker running for this Postgres brain.', verify: VERIFY('queue_health') },
    };
  },
};

const migrationsProbe: Prober = {
  capability: 'migrations',
  async run(engine) {
    const base = { capability: 'migrations' as const, tier: 'probed' as const, http_visible: false };
    const { LATEST_VERSION } = await import('./migrate.ts');
    const current = parseInt((await engine.getConfig('version')) || '1', 10);
    if (current >= LATEST_VERSION) return { ...base, state: 'ok', reason: 'current', why: `Schema is at v${current}.` };
    return {
      ...base, state: 'degraded', reason: 'pending',
      why: `Schema is at v${current}; v${LATEST_VERSION} is available, so newer features may refuse until migrations run.`,
      fix: { argv: ['gbrain', 'apply-migrations', '--yes', '--no-autopilot-install'], consent: [], actor: 'agent', requires_exclusive: true,
        why: 'Applies the pending schema migrations without installing background services.', verify: VERIFY('schema_version') },
    };
  },
};

const BACKUP_STATE_MAP: Record<string, { state: ReadinessState; reason: (typeof BACKUP_REASONS)[number] }> = {
  ok: { state: 'ok', reason: 'covered' }, info: { state: 'ok', reason: 'info' },
  no_remote: { state: 'degraded', reason: 'no_remote' }, unpushed: { state: 'degraded', reason: 'unpushed' },
  dirty: { state: 'degraded', reason: 'dirty' }, failing: { state: 'degraded', reason: 'failing' },
  unknown: { state: 'unknown', reason: 'unverified' },
};

function backupFix(argv: string[] | null | undefined): Action | undefined {
  if (!argv?.length) return undefined;
  const filled = argv.map(a => a.replace(/^BACKUP_DIR\//, '<BACKUP_DIR>/'));
  const egress: Effect[] = argv[1] === 'bootstrap' || (argv[1] === 'sources' && argv[2] === 'push') ? ['credentials', 'egress'] : [];
  return {
    argv: filled, consent: egress, actor: 'agent', requires_exclusive: argv[1] === 'export',
    why: 'Puts this asset under a backup that survives losing this machine.',
    ...(filled.some(a => a.includes('<BACKUP_DIR>')) ? { inputs: [{ name: 'BACKUP_DIR', how: 'Ask the user where backups should live (a directory outside the brain).' }] } : {}),
    verify: VERIFY('backup_coverage'),
  };
}

const backupProbe: Prober = {
  capability: 'backup',
  async run(engine) {
    const { getBackupStatus } = await import('./backup/coverage.ts');
    const status = await getBackupStatus(engine, { localGitProbes: false, computedBy: 'doctor' });
    return status.assets.map(a => {
      const mapped = a.state === 'ok' && a.verification?.state === 'verified' ? { state: 'ok' as const, reason: 'verified' as const } : BACKUP_STATE_MAP[a.state] ?? BACKUP_STATE_MAP.unknown;
      const fix = backupFix(a.fix_argv);
      return { capability: 'backup' as const, tier: 'probed' as const, http_visible: false, asset: `${a.kind}:${a.id}`, ...mapped,
        why: a.kind === 'db_only' ? 'DB-only pages and facts exist only in the database; git evidence does not cover them.' : `Backup state of ${a.kind} '${a.id}': ${a.state}.`,
        ...(fix ? { fix } : {}) };
    });
  },
};

const syncProbe: Prober = {
  capability: 'sync',
  async run(engine) {
    const base = { capability: 'sync' as const, tier: 'probed' as const, http_visible: false };
    const rows = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM sources WHERE NOT archived AND local_path IS NOT NULL AND local_path <> ''`);
    const n = Number(rows[0]?.n ?? 0);
    if (n === 0) return { ...base, state: 'not_applicable', reason: 'no_repo_sources', why: 'No source is bound to a local repository, so `gbrain sync` has nothing to pull; pages arrive through gbrain writes and imports.' };
    return { ...base, state: 'ok', reason: 'git_sources', why: `${n} source(s) are bound to local repositories that \`gbrain sync\` reads.` };
  },
};

const transcriptsProbe: Prober = {
  capability: 'local_transcripts',
  async run(engine) {
    const base = { capability: 'local_transcripts' as const, tier: 'probed' as const, http_visible: false };
    const { localTranscriptsFix, recentTranscriptPresence } = await import('./transcripts.ts');
    const p = await recentTranscriptPresence(engine);
    if (p.count === 0) {
      return { ...base, state: 'not_applicable', reason: 'no_transcripts',
        why: 'No session transcripts from the last 7 days in a configured transcript directory (dream.synthesize.session_corpus_dir, dream.synthesize.meeting_transcripts_dir).' };
    }
    return { ...base, state: 'ok', reason: 'transcripts_cli_only',
      why: `${p.count} recent session transcript(s) exist on this host: read them with \`gbrain transcripts recent --json\` (page search never returns them; get_recent_transcripts is local-only on MCP). Files: ${p.dirs.join(', ')}.`,
      fix: localTranscriptsFix() };
  },
};

const PROBERS: readonly Prober[] = [workerProbe, backupProbe, migrationsProbe, syncProbe, transcriptsProbe];

async function runProbes(engine: BrainEngine): Promise<ReadinessEntry[]> {
  if (isEngineDegraded(engine)) return PROBERS.map(p => failedEntry(p.capability, 'engine_unreachable'));
  return (await Promise.all(PROBERS.map(p => bounded(p, engine)))).flat();
}

function refresh(engine: BrainEngine, cache: ReadinessCache, key: string): Promise<ReadinessEntry[]> {
  const flights = inflight.get(cache) ?? new Map<string, Promise<ReadinessEntry[]>>();
  inflight.set(cache, flights);
  const existing = flights.get(key);
  if (existing) return existing;
  const p = runProbes(engine).then(value => {
    cache.set(key, { at: Date.now(), value });
    return value;
  }).finally(() => flights.delete(key));
  flights.set(key, p);
  return p;
}

export async function probedReadiness(engine: BrainEngine, opts: { cache?: ReadinessCache } = {}): Promise<ReadinessEntry[]> {
  const cache = opts.cache ?? processCache;
  const key = cacheKey(engine);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < PROBED_TTL_MS) return hit.value;
  const pending = refresh(engine, cache, key);
  if (hit) {
    pending.catch(() => {});
    return hit.value;
  }
  return pending;
}

/**
 * MCP initialize's readiness tail: best-effort within 250 ms; undefined on
 * throw or timeout (the probe keeps filling the cache in the background).
 */
export async function readinessTail(engine: BrainEngine, opts: { cache?: ReadinessCache; timeoutMs?: number } = {}): Promise<ReadinessEntry[] | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), opts.timeoutMs ?? INITIALIZE_TAIL_MS); });
    const probe = probedReadiness(engine, { cache: opts.cache });
    probe.catch(() => {});
    return await Promise.race([probe, timeout]);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
