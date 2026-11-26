/**
 * `gbrain profile`: the caller's own portable profile (lane 3 P1), read through context_pack {profile: true}. On a
 * thin client it calls the remote brain's context_pack; locally it runs the same operation as the trusted CLI.
 */
import type { BrainEngine } from '../core/engine.ts';
import type { OperationContext } from '../core/ops/contract.ts';
import type { ProfileBlock, ProfileFact } from '../core/profile/read.ts';

interface Flags { json: boolean; budget?: number }

const HELP = `Usage: gbrain profile [--json] [--budget-tokens <n>]
       gbrain profile import <file> [--yes --preview <hash>]   (gbrain profile import --help)
       gbrain profile export --format memory-text|muse-memory|markdown   (gbrain profile export --help)

Your own profile: the facts remember saved with a facet (diet, allergy, size.<item>, brand, style, constraint,
schedule, household, other), relationships from your page's links, and unfaceted preferences. The brain owner reads
the owner's profile; a member credential reads its own. Read-only, zero model calls.

Options:
  --json               Print the profile block as one JSON document.
  --budget-tokens <n>  Pack the profile into this many tokens; the rest is counted as withheld.

Examples:
  gbrain profile
  gbrain profile --json --budget-tokens 400

Guide: docs/guides/profile.md`;

export function parseProfileArgs(args: string[]): Flags | { error: string } {
  const flags: Flags = { json: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--json') flags.json = true;
    else if (a === '--budget-tokens') {
      const raw = args[++i];
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) return { error: `--budget-tokens takes a positive whole number of tokens; got ${JSON.stringify(raw ?? '')}.` };
      flags.budget = n;
    } else return { error: `Unknown argument ${JSON.stringify(a)}.` };
  }
  return flags;
}

const line = (f: ProfileFact, label: string) =>
  `  - [${label}] ${f.claim.replace(/\s+/g, ' ')} (${[f.visibility, f.content_origin, 'fact ' + f.fact_id].filter(Boolean).join(', ')})`;

export function renderProfile(block: ProfileBlock): string {
  if (!block.entity) return 'This credential has no profile: it speaks for no member and is not the brain owner.';
  const out = [`Profile of ${block.entity.slug ?? 'your own page, in a source this credential cannot read'} (${block.entity.basis})`];
  const section = (title: string, rows: string[]) => { if (rows.length) out.push('', title, ...rows); };
  section('Constraints:', block.constraints.map(f => line(f, f.facet!)));
  section('Facets:', block.facets.map(f => line(f, f.facet!)));
  section('Preferences:', block.preferences.map(f => line(f, 'preference')));
  section('Relationships:', block.relationships.map(r => `  - ${r.type} ${r.direction === 'out' ? '→' : '←'} ${r.slug}${r.context ? ` — ${r.context.replace(/\s+/g, ' ')}` : ''}`));
  if (out.length === 1) out.push('', 'No profile facts yet. Save one with: gbrain remember "<fact>" --facet diet --provenance "<where, with the date>"');
  if (block.withheld) out.push('', `${block.withheld} more left out by --budget-tokens, or private and not readable by this credential.`);
  if (block.partial) out.push('', 'This profile may be incomplete: some of it could not be read (too many facts on your page, or a failed read).');
  return out.join('\n');
}

type MakeContext = (engine: BrainEngine, params: Record<string, unknown>) => Promise<OperationContext>;

/** The brain a local import writes: its id, a digest of its database target (never the target itself) and the source. */
export async function localPrincipal(ctx: OperationContext): Promise<string> {
  const { createHash } = await import('node:crypto');
  const cfg = ctx.config as { database_url?: string; database_path?: string };
  const db = createHash('sha256').update(String(cfg.database_url ?? cfg.database_path ?? ctx.engine.kind)).digest('hex').slice(0, 12);
  return `local:${ctx.brainId ?? 'host'}:${db}#${ctx.sourceId}`;
}

export async function runProfile(engine: BrainEngine | null, args: string[], makeContext?: MakeContext): Promise<void> {
  const sub = args[0] === 'import' || args[0] === 'export' ? args[0] : null;
  if (!sub && (args.includes('--help') || args.includes('-h'))) { console.log(HELP); return; }
  const { loadConfig, isThinClient, configDir } = await import('../core/config.ts');
  const cfg = loadConfig();
  const { getCliOptions, THIN_CLIENT_BRAIN_FLAG_MESSAGE } = await import('../core/cli-options.ts');
  const brain = getCliOptions().brain;
  const { parseImportArgs } = await import('./profile-import.ts');
  const importFlags = args[0] === 'import' ? parseImportArgs(args.slice(1)) : null;
  const source = importFlags && !('error' in importFlags) ? importFlags.source : undefined;
  if (isThinClient(cfg) && (brain || source)) {
    const { opError } = await import('../core/ops/contract.ts');
    throw brain ? opError('invalid_params', THIN_CLIENT_BRAIN_FLAG_MESSAGE, 'Remove --brain, or run from a machine with local mounts (`gbrain mounts list`).')
      : opError('invalid_params', 'profile import does not accept --source on a thin-client install: the server writes to the source your credential is granted.', 'Remove --source.');
  }
  let call: (tool: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;
  let ctx: OperationContext | null = null;
  if (isThinClient(cfg)) {
    const { callRemoteTool, unpackToolResult } = await import('../core/mcp-client.ts');
    call = async (tool, params) => unpackToolResult(await callRemoteTool(cfg!, tool, params, { timeoutMs: 30_000 }));
  } else if (!sub || !(args.includes('--help') || args.includes('-h'))) {
    const { operationsByName } = await import('../core/operations.ts');
    ctx = makeContext ? await makeContext(engine!, source ? { source } : {}) : await fallbackContext(engine!, cfg, source);
    const local = ctx;
    call = async (tool, params) => await operationsByName[tool]!.handler(local, params) as Record<string, unknown>;
  } else call = async () => ({});
  if (args[0] === 'import') {
    const { runProfileImport } = await import('./profile-import.ts');
    const principal = isThinClient(cfg) || !ctx ? `remote:${cfg?.remote_mcp?.mcp_url}#${cfg?.remote_mcp?.oauth_client_id}` : await localPrincipal(ctx);
    const target = async () => {
      const entity = ((await call('context_pack', { profile: true, budget_tokens: 1 })).profile as ProfileBlock | undefined)?.entity;
      if (!entity) {
        const { opError } = await import('../core/ops/contract.ts');
        throw opError('profile_entity_not_self', 'profile import: this credential has no profile (it speaks for no member and is not the brain owner); nothing was sent.',
          'Import from the brain owner\'s CLI or a member credential.');
      }
      return { principal, profile: entity.slug ?? `unreadable:${entity.basis}` };
    };
    await runProfileImport(args.slice(1), call, target, configDir(), brain ? ['--brain', brain] : []);
    return;
  }
  if (sub === 'export') {
    const { runProfileExport } = await import('./profile-export.ts');
    await runProfileExport(args.slice(1), call);
    return;
  }
  const flags = parseProfileArgs(args);
  if ('error' in flags) {
    const { opError } = await import('../core/ops/contract.ts');
    throw opError('invalid_params', flags.error, 'Run gbrain profile [--json] [--budget-tokens <n>]; gbrain profile --help lists the flags.');
  }
  const params: Record<string, unknown> = { profile: true, ...(flags.budget !== undefined ? { budget_tokens: flags.budget } : {}) };
  const result = await call('context_pack', params) as { profile?: ProfileBlock };
  const block = result.profile;
  if (!block) { console.error('The brain did not return a profile: it may predate context_pack {profile: true}; upgrade it with gbrain upgrade.'); process.exit(1); }
  if (!flags.json) { console.log(renderProfile(block)); return; }
  const { writeJsonDocument } = await import('../core/cli-force-exit.ts');
  await writeJsonDocument(JSON.stringify(block, null, 2));
}

/** The trusted-local context when no CLI dispatcher supplied one (tests): the user's own interactive writes. */
async function fallbackContext(engine: BrainEngine, cfg: unknown, source?: string): Promise<OperationContext> {
  const { resolveSourceId } = await import('../core/source-resolver.ts');
  return { engine, config: cfg ?? { engine: engine.kind }, logger: { info() {}, warn: console.error, error: console.error }, dryRun: false,
    remote: false, admissionOrigin: 'interactive', sourceId: await resolveSourceId(engine, source ?? null) } as unknown as OperationContext;
}
