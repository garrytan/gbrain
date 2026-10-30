/**
 * `gbrain embeddings enable`: turn on embeddings for a brain in place,
 * including a mounted brain (`--brain <id>`), where `init --force` cannot be
 * used because it would repoint the host config at the mount's datastore.
 *
 * It opens the selected datastore, reads its vector column width and stored
 * embedding identity, refuses a width the model cannot produce or vectors
 * from another model (clear next step, nothing changed), then writes the
 * host file-plane embedding model and dimensions and clears the keyless
 * marker. Pages, facts and keyword search are untouched; chunks and facts
 * without vectors stay queued for `gbrain embed --stale`.
 *
 * `gbrain embeddings prewarm`: load a Postgres brain's HNSW indexes into
 * shared_buffers when they fit (core/vector-prewarm.ts). It lives here because
 * this is the command group for a brain's vector side that opens the selected
 * brain's own engine and that thin clients already refuse; `gbrain search`
 * takes a free-text query, so `search prewarm` would be a search.
 */
import { existsSync } from 'node:fs';
import { loadConfigFileOnly, saveConfig, toEngineConfig, type GBrainConfig } from '../core/config.ts';
import { createEngine } from '../core/engine-factory.ts';
import type { BrainEngine } from '../core/engine.ts';
import { getCliOptions } from '../core/cli-options.ts';
import { resolveBrainId } from '../core/brain-resolver.ts';
import { loadMounts } from '../core/brain-registry.ts';
import { readContentChunksEmbeddingDim, resolveSchemaEmbeddingDim } from '../core/embedding-dim-check.ts';
import { readPrimaryEmbeddingStores, readStoredEmbeddingIdentity } from '../core/stored-embedding-identity.ts';
import { countStaleFactEmbeddings } from '../core/facts/embedding-identity.ts';
import { opError, OperationError } from '../core/ops/contract.ts';
import { renderCliError, type Action } from '../core/agent-output.ts';
import { recordAgentContractEvent } from '../core/agent-contract-log.ts';
import { setCliExitVerdict, writeStdoutFinal } from '../core/cli-force-exit.ts';
import { runVectorPrewarm, vectorPrewarmUnsupported } from '../core/vector-prewarm.ts';

const USAGE = `Usage: gbrain embeddings enable --embedding-model <provider:model> [--embedding-dimensions <N>] [--brain <id>] [--json]
       gbrain embeddings prewarm [--dry-run] [--brain <id>] [--json]

Turn on embeddings for the selected brain in place. Pages, facts and keyword
search are kept; chunks and facts without vectors stay queued for
\`gbrain embed --stale\`. Width defaults to the brain's existing vector column.
The embedding model is host-wide: a mounted brain and the host brain share it.
Refuses (changing nothing) when the model cannot produce the column's width or
the brain holds vectors from another model.

Effects: writes ~/.gbrain/config.json; later embedding calls use the provider
key (paid). Needs the brain's single-writer lock (stop a running gbrain serve).

prewarm (Postgres): load the brain's HNSW vector indexes into shared_buffers
with pg_prewarm, so the first searches after a restart skip their cold index
reads. Refuses before reading anything when the indexes exceed half of
shared_buffers (effective_cache_size is reported, never used: it is a planner
hint) or the pg_prewarm extension is missing. --dry-run prints the fit only.
\`gbrain config set serve.vector_prewarm true\` runs it once at each serve start.
`;

interface EnableOpts { model: string; dims?: number; json: boolean }

function parseEnableArgs(args: string[]): EnableOpts {
  let model: string | undefined;
  let dims: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') continue;
    if (a !== '--embedding-model' && a !== '--embedding-dimensions') {
      throw opError('invalid_params', `Unknown option '${a}' for gbrain embeddings enable.`, 'Run `gbrain embeddings --help` for the accepted options.');
    }
    const value = args[++i];
    if (!value || value.startsWith('-')) throw opError('invalid_params', `${a} requires a value.`, a === '--embedding-model'
      ? 'Pass the model as provider:model right after --embedding-model; `gbrain providers list` shows the embedding models whose key is configured.'
      : 'Pass the vector width as a positive integer, e.g. `--embedding-dimensions 1536`, or omit the flag to keep the brain\'s width.');
    if (a === '--embedding-model') model = value;
    else if (/^\d+$/.test(value) && Number(value) > 0) dims = Number(value);
    else throw opError('invalid_params', '--embedding-dimensions must be a positive integer.', 'Pass the width of the brain\'s vector column, or omit it to use that width.');
  }
  if (!model) throw opError('invalid_params', '--embedding-model <provider:model> is required.', 'Run `gbrain providers list` to see embedding models whose key is configured.');
  return { model, dims, json: args.includes('--json') };
}

function targetConfig(host: GBrainConfig, brainId: string): GBrainConfig {
  if (brainId === 'host') return host;
  const mount = loadMounts().find(m => m.id === brainId || m.alias === brainId);
  if (!mount || mount.enabled === false) {
    throw opError('not_found', `Brain '${brainId}' is not an enabled mount.`, 'Run `gbrain mounts list` to see mounted brains.');
  }
  return { ...host, engine: mount.engine, database_path: mount.database_path, database_url: mount.database_url };
}

function brainArgs(brainId: string): string[] {
  return brainId === 'host' ? [] : ['--brain', brainId];
}

async function assertSameIdentity(engine: BrainEngine, model: string): Promise<void> {
  const stored = await readStoredEmbeddingIdentity(engine);
  if (stored?.model === model) return;
  for (const table of await readPrimaryEmbeddingStores(engine)) {
    const [row] = await engine.executeRaw<{ present: boolean }>(`SELECT EXISTS (SELECT 1 FROM ${table} WHERE embedding IS NOT NULL) AS present`);
    if (row?.present) {
      throw opError('embedding_model_mismatch', 'This brain already holds vectors from a different or unrecorded embedding model; enabling cannot change their identity.',
        'Read `gbrain migrate embeddings --status --json`, then preview an explicit migration with --dry-run.',
        { fix: { argv: ['gbrain', 'migrate', 'embeddings', '--status', '--json'], consent: [], actor: 'agent', requires_exclusive: false, why: 'A model switch with existing vectors is a re-embed migration, previewed first.' } });
    }
  }
}

function resolveWidth(model: string, requested: number | undefined, column: number | null, brainId: string): number {
  const check = resolveSchemaEmbeddingDim({ embedding_model: model, embedding_dimensions: requested ?? column ?? undefined });
  if (check.ok && (column === null || check.dim === column)) return check.dim;
  const fitsColumn = column !== null && resolveSchemaEmbeddingDim({ embedding_model: model, embedding_dimensions: column }).ok;
  const fix: Action = fitsColumn
    ? { argv: ['gbrain', 'embeddings', 'enable', ...brainArgs(brainId), '--embedding-model', model, '--embedding-dimensions', String(column)],
      consent: ['credentials', 'paid'], actor: 'agent', requires_exclusive: true, why: `Uses the brain's existing ${column}d width, which ${model} supports.` }
    : { argv: ['gbrain', 'migrate', 'embeddings', '--status', '--json'], consent: [], actor: 'agent', requires_exclusive: false,
      why: `Changing the vector width is a re-embed through \`gbrain migrate embeddings --to <provider:model> --dim <N> --dry-run\` (pages and facts are kept); read the status first.` };
  throw opError('embedding_width_mismatch',
    column !== null
      ? `This brain's vector column is ${column}d; ${model}${requested !== undefined ? ` at ${requested}d` : ''} cannot fill it.${check.ok ? '' : ` ${check.error}`}`
      : `${model} cannot be used: ${check.ok ? 'unknown width' : check.error}`,
    fitsColumn ? `Use --embedding-dimensions ${column}.` : 'Pick a model that supports the column width, or migrate the width explicitly.',
    { fix });
}

async function enable(opts: EnableOpts): Promise<Record<string, unknown>> {
  const host = loadConfigFileOnly();
  if (!host) throw opError('config_error', 'No gbrain config file found.', 'Run `gbrain init` first.');
  if (host.remote_mcp) throw opError('config_error', 'This is a thin-client install; embeddings are configured on the remote brain host.', 'Run this command on the brain host.');
  const brainId = resolveBrainId(getCliOptions().brain);
  const target = targetConfig(host, brainId);
  const hostModel = host.embedding_disabled ? undefined : host.embedding_model?.trim();
  if (brainId !== 'host' && hostModel && hostModel !== opts.model) {
    throw opError('embedding_model_mismatch', `The host already embeds with ${hostModel}; the embedding model is host-wide, so a mount cannot use ${opts.model}.`,
      `Re-run with --embedding-model ${hostModel}.`);
  }
  if (target.engine === 'pglite' && (!target.database_path || !existsSync(target.database_path))) {
    throw opError('not_found', `No PGLite brain exists at the selected datastore${target.database_path ? ` (${target.database_path})` : ''}.`, 'Run `gbrain init` (or check `gbrain mounts list`).');
  }
  const engine = await createEngine(toEngineConfig(target));
  await engine.connect(toEngineConfig(target));
  try {
    const column = await readContentChunksEmbeddingDim(engine);
    const width = resolveWidth(opts.model, opts.dims, column.exists ? column.dims : null, brainId);
    await assertSameIdentity(engine, opts.model);
    const fileCfg = loadConfigFileOnly() ?? host;
    fileCfg.embedding_model = opts.model;
    fileCfg.embedding_dimensions = width;
    delete fileCfg.embedding_disabled;
    saveConfig(fileCfg);
    await engine.unsetConfig('embedding_disabled');
    const queuedChunks = await engine.countStaleChunks();
    const queuedFacts = (await countStaleFactEmbeddings(engine, opts.model, width)).count;
    return {
      status: 'enabled', brain: brainId, embedding_model: opts.model, embedding_dimensions: width,
      queued_chunks: queuedChunks, queued_facts: queuedFacts,
      next_command: ['gbrain', 'embed', '--stale', ...brainArgs(brainId)],
    };
  } finally {
    await engine.disconnect().catch(() => {});
  }
}

async function writePrewarm(args: string[], json: boolean): Promise<void> {
  const unknown = args.find(a => a !== '--json' && a !== '--dry-run');
  if (unknown) throw opError('invalid_params', `Unknown option '${unknown}' for gbrain embeddings prewarm.`, 'Run `gbrain embeddings --help` for the accepted options.');
  const host = loadConfigFileOnly();
  if (!host) throw opError('config_error', 'No gbrain config file found.', 'Run `gbrain init` first.');
  if (host.remote_mcp) throw opError('config_error', 'This is a thin-client install; prewarm runs on the brain host.', 'Run this command on the brain host.');
  const target = targetConfig(host, resolveBrainId(getCliOptions().brain));
  if (target.engine !== 'postgres') throw vectorPrewarmUnsupported();
  const engine = await createEngine(toEngineConfig(target));
  await engine.connect(toEngineConfig(target));
  try {
    const r = await runVectorPrewarm(engine, { dryRun: args.includes('--dry-run') });
    const mb = (bytes: number) => `${Math.ceil(bytes / (1024 * 1024))} MB`;
    const blocks = r.loaded.reduce((sum, l) => sum + l.blocks, 0);
    await writeStdoutFinal(json ? `${JSON.stringify(r, null, 2)}\n`
      : `Vector indexes: ${r.indexes.length}, ${mb(r.total_bytes)}; prewarm budget ${mb(r.budget_bytes)} (half of shared_buffers ${mb(r.shared_buffers_bytes)}${r.effective_cache_size_bytes === null ? '' : `; effective_cache_size ${mb(r.effective_cache_size_bytes)}, not used`}).\n` +
        (r.dry_run ? `Fits. Dry run: nothing read${r.extension_version ? '' : '; pg_prewarm is not created yet (CREATE EXTENSION IF NOT EXISTS pg_prewarm)'}.\n`
          : `Loaded ${mb(blocks * 8192)} into shared_buffers in ${(r.elapsed_ms / 1000).toFixed(1)} s.\n`));
  } finally {
    await engine.disconnect().catch(() => {});
  }
}

export async function runEmbeddings(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (!sub || sub === '--help' || sub === '-h' || sub === 'help' || rest.includes('--help')) {
    await writeStdoutFinal(USAGE);
    return;
  }
  const json = args.includes('--json');
  try {
    if (sub === 'prewarm') return await writePrewarm(rest, json);
    if (sub !== 'enable') throw opError('invalid_params', `Unknown embeddings subcommand '${sub}'.`, 'The subcommands are enable (`gbrain embeddings enable --embedding-model <provider:model>`) and prewarm.');
    const result = await enable(parseEnableArgs(rest));
    const next = (result.next_command as string[]).join(' ');
    await writeStdoutFinal(json ? `${JSON.stringify(result, null, 2)}\n`
      : `Embeddings enabled: ${result.embedding_model} (${result.embedding_dimensions}d) for brain '${result.brain}'.\n` +
        `Kept every page and fact; queued ${result.queued_chunks} chunk(s) and ${result.queued_facts} fact(s) for vectors.\n` +
        `Next: ${next}\n`);
  } catch (error) {
    const rendered = renderCliError(error, { json, command: 'embeddings', tty: process.stderr.isTTY === true });
    recordAgentContractEvent({ command: 'embeddings', transport: 'cli', code: error instanceof OperationError ? error.canonicalCode : 'internal_error', outcome: 'not_started' });
    if (rendered.stdout) await writeStdoutFinal(rendered.stdout);
    if (rendered.stderr) process.stderr.write(rendered.stderr);
    setCliExitVerdict(rendered.exitCode);
  }
}
