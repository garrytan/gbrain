/**
 * `gbrain profile`: the caller's own portable profile (lane 3 P1), read through context_pack {profile: true}. On a
 * thin client it calls the remote brain's context_pack; locally it runs the same operation as the trusted CLI.
 */
import type { BrainEngine } from '../core/engine.ts';
import type { OperationContext } from '../core/ops/contract.ts';
import type { ProfileBlock, ProfileFact } from '../core/profile/read.ts';

interface Flags { json: boolean; budget?: number }

const HELP = `Usage: gbrain profile [--json] [--budget-tokens <n>]

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
  const out = [`Profile of ${block.entity.slug} (${block.entity.basis})`];
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

export async function runProfile(engine: BrainEngine | null, args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) { console.log(HELP); return; }
  const flags = parseProfileArgs(args);
  if ('error' in flags) {
    const { opError } = await import('../core/ops/contract.ts');
    throw opError('invalid_params', flags.error, 'Run gbrain profile [--json] [--budget-tokens <n>]; gbrain profile --help lists the flags.');
  }
  const params: Record<string, unknown> = { profile: true, ...(flags.budget !== undefined ? { budget_tokens: flags.budget } : {}) };
  const { loadConfig, isThinClient } = await import('../core/config.ts');
  const cfg = loadConfig();
  let result: { profile?: ProfileBlock };
  if (isThinClient(cfg)) {
    const { callRemoteTool, unpackToolResult } = await import('../core/mcp-client.ts');
    result = unpackToolResult(await callRemoteTool(cfg!, 'context_pack', params, { timeoutMs: 30_000 }));
  } else {
    const [{ operationsByName }, { resolveSourceId }] = await Promise.all([import('../core/operations.ts'), import('../core/source-resolver.ts')]);
    const ctx = { engine: engine!, config: cfg ?? { engine: engine!.kind }, logger: { info() {}, warn: console.error, error: console.error }, dryRun: false,
      remote: false, sourceId: await resolveSourceId(engine!, null) } as unknown as OperationContext;
    result = await operationsByName.context_pack!.handler(ctx, params) as { profile?: ProfileBlock };
  }
  const block = result.profile;
  if (!block) { console.error('The brain did not return a profile: it may predate context_pack {profile: true}; upgrade it with gbrain upgrade.'); process.exit(1); }
  if (!flags.json) { console.log(renderProfile(block)); return; }
  const { writeJsonDocument } = await import('../core/cli-force-exit.ts');
  await writeJsonDocument(JSON.stringify(block, null, 2));
}
