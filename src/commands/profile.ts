/**
 * `gbrain profile`: the caller's own portable profile (lane 3 P1), read through context_pack {profile: true}. On a
 * thin client it calls the remote brain's context_pack; locally it runs the same operation as the trusted CLI.
 */
import type { BrainEngine } from '../core/engine.ts';
import type { OperationContext } from '../core/ops/contract.ts';
import type { ProfileBlock, ProfileFact } from '../core/profile/read.ts';

const HELP = `Usage: gbrain profile [--json] [--budget-tokens N]

Shows your own profile: the facts saved with remember --facet (diet, allergy, size.<item>, brand, style,
constraint, schedule, household, other), relationships from your page's links, and unfaceted preferences.
The brain owner reads the owner's profile; a member credential reads its own. Zero model calls.

  --json              Print the profile block as JSON.
  --budget-tokens N   Pack the profile into N tokens; the rest is counted as withheld.

Save a profile fact: gbrain remember "Allergic to peanuts" --facet allergy --provenance "<where, with the date>"
Guide: docs/guides/profile.md`;

interface Flags { json: boolean; budget?: number }

export function parseProfileArgs(args: string[]): Flags | { help: true } | { error: string } {
  const flags: Flags = { json: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--help' || a === '-h') return { help: true };
    if (a === '--json') flags.json = true;
    else if (a === '--budget-tokens' || a.startsWith('--budget-tokens=')) {
      const raw = a.includes('=') ? a.slice(a.indexOf('=') + 1) : args[++i];
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
  if (block.withheld) out.push('', `${block.withheld} more left out by --budget-tokens.`);
  if (block.partial) out.push('', 'Only the newest facts on your page were scanned; older profile facts may be missing.');
  return out.join('\n');
}

export async function runProfile(engine: BrainEngine | null, args: string[]): Promise<void> {
  const flags = parseProfileArgs(args);
  if ('help' in flags) { console.log(HELP); return; }
  if ('error' in flags) { console.error(flags.error + '\n\n' + HELP); process.exit(2); }
  const params: Record<string, unknown> = { profile: true, ...(flags.budget !== undefined ? { budget_tokens: flags.budget } : {}) };
  const { loadConfig, isThinClient } = await import('../core/config.ts');
  const cfg = loadConfig();
  let result: { profile?: ProfileBlock };
  if (isThinClient(cfg)) {
    const { callRemoteTool, unpackToolResult } = await import('../core/mcp-client.ts');
    result = unpackToolResult(await callRemoteTool(cfg!, 'context_pack', params, { timeoutMs: 30_000 }));
  } else {
    const { operationsByName } = await import('../core/operations.ts');
    const ctx = { engine: engine!, config: cfg ?? { engine: engine!.kind }, logger: { info() {}, warn: console.error, error: console.error }, dryRun: false,
      remote: false, sourceId: 'default' } as unknown as OperationContext;
    result = await operationsByName.context_pack!.handler(ctx, params) as { profile?: ProfileBlock };
  }
  const block = result.profile;
  if (!block) { console.error('The brain did not return a profile: it may predate context_pack {profile: true}; upgrade it with gbrain upgrade.'); process.exit(1); }
  console.log(flags.json ? JSON.stringify(block, null, 2) : renderProfile(block));
}
