/**
 * `gbrain engine swap --to rust --plan [--json]` (PR S5a): the read-only swap plan.
 *
 * Dispatched before connectEngine() from `gbrain engine` (src/cli/commands/engine.ts); it opens the brain itself with a
 * plain connect (no schema migration) and writes nothing. The run (`--yes --expect <hash>`), `--resume`, `--status`
 * and failback (`--to postgres|pglite`) come with S5b; this build refuses them with `invalid_params`.
 *
 * Exit codes: 0 plan shown (READY or NOT READY); 1 `engine_swap_refused` before any criterion (`refresh_unsettled`);
 * 3 `engine_swap_refused` for a mounted brain (`team_brain`) or managed storage (`managed_storage`);
 * 2 usage. `--json` prints one document on stdout.
 */
import { existsSync, readdirSync, readFileSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import { writeCliError } from '../cli/cli-error.ts';
import { writeJsonDocument } from '../core/cli-force-exit.ts';
import { loadConfig, toEngineConfig } from '../core/config.ts';
import { getCliOptions } from '../core/cli-options.ts';
import type { BrainEngine } from '../core/engine.ts';
import { noBrainError } from '../core/engine-connect.ts';
import { opError } from '../core/ops/contract.ts';
import { ENGINE_SELECTING_ENV, planEngineSwap, type ServiceDefinition, type SwapPlan, type SwapPlanInputs } from '../core/engine-swap/plan.ts';
import { mountedBrainError, SWAP_RECOVERY } from '../core/engine-swap/refusals.ts';
import { HOST_BRAIN_ID } from '../core/brain-registry.ts';
import { resolveBrainId } from '../core/brain-resolver.ts';

export interface EngineSwapArgs { to?: string; brain?: string; plan: boolean; json: boolean; help: boolean; unsupported: string[] }

export function parseEngineSwapArgs(args: readonly string[]): EngineSwapArgs {
  const out: EngineSwapArgs = { plan: false, json: false, help: false, unsupported: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === 'swap') continue;
    if (a === '--to') { out.to = args[++i]; continue; }
    if (a === '--plan' || a === '--dry-run') { out.plan = true; continue; }
    if (a === '--json') { out.json = true; continue; }
    if (a === '--brain') { out.brain = args[++i]; continue; }
    if (a === '--help' || a === '-h') { out.help = true; continue; }
    if (a === '--expect') { out.unsupported.push(a); i++; continue; }
    out.unsupported.push(a);
  }
  return out;
}

const HELP = `gbrain engine swap — preview moving this brain to the Rust engine (read only)

  gbrain engine swap --to rust --plan [--json]   the verdict, each readiness criterion, routes and disk; writes nothing

The run (--yes --expect <hash>), --resume, --status and failback (--to postgres|pglite)
arrive in a later release. See docs/guides/engine-swap.md.
`;

function usage(message: string): ReturnType<typeof opError> {
  return opError('invalid_params', message, 'Run `gbrain engine swap --to rust --plan` to read the plan; the run arrives in a later release.',
    { docs: 'docs/guides/engine-swap.md#plan' });
}

export function renderPlanText(p: SwapPlan): string {
  const lines = [
    `Engine swap plan: ${p.from} -> ${p.to}   verdict: ${p.verdict}${p.reason ? ` (${p.reason})` : ''}   plan ${p.plan_hash}`,
    p.shadow ? '' : 'No shadow runs for this brain, so there is no readiness evidence yet (gbrain engine shadow, S3).',
    'Worktree refreshes: none unfinished.',
    'Readiness:',
    ...p.criteria.map(c => `  ${String(c.n).padStart(2)}. [${c.state}] ${c.name}: ${c.detail}`),
    `Engine-selecting variables set (names only): ${p.routes.env.length ? p.routes.env.join(', ') : 'none'}`,
    `Service definitions: ${p.routes.services.length ? p.routes.services.map(s => `${s.name} (${s.kind}${s.unread ? '; unreadable, names unknown' : s.sets.length ? `; sets ${s.sets.join(', ')}` : ''})`).join('; ') : 'none found'}`,
    `Free disk at ${p.disk.path || '(unknown)'}: ${p.disk.free_bytes === null ? 'unknown' : `${(p.disk.free_bytes / 2 ** 30).toFixed(1)} GiB`}`,
    `Capability report: ${p.deferred.capability_report}`,
    `Expected write pause: ${p.deferred.expected_write_pause}`,
    p.reason ? `A run would refuse with engine_swap_refused (${p.reason}): ${SWAP_RECOVERY[p.reason].blocker}` : 'READY is evidence, not permission: the swap needs its own approval.',
    'Nothing was written.',
  ];
  return lines.filter(Boolean).join('\n');
}

/** launchd and systemd user definitions with gbrain in the name, and the engine-selecting names each one sets. */
export function serviceDefinitions(home: string): ServiceDefinition[] {
  const dirs: Array<[string, ServiceDefinition['kind']]> = [
    [join(home, 'Library', 'LaunchAgents'), 'launchd'],
    [join(home, '.config', 'systemd', 'user'), 'systemd'],
  ];
  const out: ServiceDefinition[] = [];
  for (const [dir, kind] of dirs) {
    if (!existsSync(dir)) continue;
    let names: string[];
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names.filter(n => /gbrain/i.test(n)).sort()) {
      let text: string;
      try {
        text = readFileSync(join(dir, name), 'utf8');
      } catch {
        // Unreadable: the names it sets are unknown, so the plan says so instead of listing none.
        out.push({ name, kind, sets: [], unread: 'read_failed' });
        continue;
      }
      // Whole-word names only, by token set (no dynamic regular expression).
      const words = new Set(text.split(/[^A-Za-z0-9_]+/));
      out.push({ name, kind, sets: ENGINE_SELECTING_ENV.filter(v => words.has(v)) });
    }
  }
  return out;
}

function freeBytes(path: string): number | null {
  try { const s = statfsSync(path); return Number(s.bavail) * Number(s.bsize); } catch { return null; }
}

export interface EngineSwapCliDeps extends Pick<SwapPlanInputs, 'readShadowStatus' | 'now'> {
  env?: Readonly<Record<string, string | undefined>>;
  home?: string;
  /** Directory whose file system the plan reports free space for (default: home). */
  dataDir?: string;
  /** Opens the brain without migrating it (default: the configured engine). */
  openEngine?: () => Promise<BrainEngine>;
  /** Resolves the selected brain id (default: resolveBrainId, which reads --brain, GBRAIN_BRAIN_ID and .gbrain-mount). */
  resolveBrain?: (explicit: string | null) => string;
  /** The global --brain value (default: getCliOptions().brain). */
  cliBrain?: string | null;
  out?: (text: string) => void;
  writeError?: (e: unknown, opts: { json: boolean }) => number;
}

async function openConfiguredEngine(): Promise<BrainEngine> {
  const config = loadConfig();
  if (!config) throw noBrainError();
  // Read only: PGLite creates a database at a missing path on connect, so a missing store is refused, never made.
  const engineConfig = toEngineConfig(config);
  // A brain with no server URL is a file datastore: its path must already exist.
  // An existing directory is not enough: PGLite runs initdb on a directory with no PG_VERSION.
  if (!engineConfig.database_url && (!engineConfig.database_path || !existsSync(join(engineConfig.database_path, 'PG_VERSION')))) {
    throw opError('no_brain', `No brain exists at ${engineConfig.database_path ?? '(no path configured)'}; the swap plan creates nothing.`,
      'Check the configured path with `gbrain engine status --json`; nothing was created.', { docs: 'docs/guides/engine-swap.md#plan' });
  }
  const { createEngine } = await import('../core/engine-factory.ts');
  const engine = await createEngine(engineConfig);
  await engine.connect(engineConfig);
  return engine;
}

/** Runs the command; returns the exit code. */
export async function runEngineSwap(args: readonly string[], deps: EngineSwapCliDeps = {}): Promise<number> {
  const parsed = parseEngineSwapArgs(args);
  const out = deps.out ?? ((t: string) => { void writeJsonDocument(t, s => { process.stdout.write(`${s}\n`); }); });
  const writeError = deps.writeError ?? ((e: unknown, o: { json: boolean }) => writeCliError(e, 'engine swap', o));
  if (parsed.help) { out(HELP.trimEnd()); return 0; }
  if (parsed.unsupported.length) return writeError(usage(`Only --to rust --plan is available in this build; not supported yet: ${parsed.unsupported.join(' ')}.`), parsed);
  if (parsed.to !== 'rust') return writeError(usage(`--to ${parsed.to ?? '(missing)'} is not available: this build previews a move to rust only.`), parsed);
  if (!parsed.plan) return writeError(usage('Only the read-only plan is available in this build: add --plan.'), parsed);
  let brainId: string;
  // The global --brain flag is stripped into getCliOptions() before dispatch; a local one wins.
  const explicitBrain = parsed.brain ?? (deps.cliBrain !== undefined ? deps.cliBrain : getCliOptions().brain) ?? null;
  try { brainId = (deps.resolveBrain ?? resolveBrainId)(explicitBrain); } catch (e) { return writeError(e, parsed); }
  if (brainId !== HOST_BRAIN_ID) return writeError(mountedBrainError(brainId), parsed);
  let engine: BrainEngine | null = null;
  try {
    engine = await (deps.openEngine ?? openConfiguredEngine)();
    const env = deps.env ?? process.env;
    const home = deps.home ?? env.HOME ?? '';
    const dataDir = deps.dataDir ?? home;
    const plan = await planEngineSwap(engine, {
      readShadowStatus: deps.readShadowStatus, now: deps.now,
      envNames: ENGINE_SELECTING_ENV.filter(v => (env[v] ?? '') !== ''),
      services: home ? serviceDefinitions(home) : [],
      disk: { path: dataDir, free_bytes: dataDir ? freeBytes(dataDir) : null },
    });
    out(parsed.json ? JSON.stringify(plan, null, 2) : renderPlanText(plan));
    return 0;
  } catch (e) {
    return writeError(e, parsed);
  } finally {
    if (engine) await engine.disconnect().catch(() => undefined);
  }
}
