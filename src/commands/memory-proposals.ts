/**
 * `gbrain memory-proposals` (GST-1158, GBRA-284): the brain owner's review of QM's proposed timeline entries and
 * links (memory_propose). Trusted local CLI; the owner session reaches the same library calls over HTTP
 * (serve-http-access.ts, gbrain mcp admin memory-proposals). Never an MCP operation.
 *
 *   gbrain memory-proposals list [--source <id>] [--all] [--limit N] [--json]
 *   gbrain memory-proposals show <request_id> [--json]
 *   gbrain memory-proposals approve <request_id> [--dry-run] [--json]
 *   gbrain memory-proposals deny <request_id> --reason "<why>" [--dry-run] [--json]
 *
 * The proposed text comes from a system credential, so list and show print it inside the transcript fence (quoted:
 * transcript) and approve takes exactly one request id.
 */
import type { BrainEngine } from '../core/engine.ts';
import { OperationError, type OperationContext } from '../core/ops/contract.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { intFlagValue } from '../cli/flag-values.ts';
import { MEMORY_PROPOSALS_SUBCOMMANDS, ROUTERS, subcommandHelpRequested } from '../cli/subcommands.ts';
import type { MemoryProposal } from '../core/persistence/memory-proposals.ts';

export { MEMORY_PROPOSALS_SUBCOMMANDS as SUBCOMMANDS } from '../cli/subcommands.ts';

function usage(): string {
  return [
    'Usage: gbrain memory-proposals <list|show|approve|deny> [args]',
    '  list [--source <id>] [--all] [--limit N] [--json]   awaiting your decision, oldest first (--all: closed ones too)',
    '  show <request_id> [--json]',
    '  approve <request_id> [--dry-run]                   re-check the person, the grant and the page, then write it',
    '  deny <request_id> --reason "<why>" [--dry-run]     the proposer reads the reason on its receipt',
  ].join('\n');
}

export function printUsage(): void {
  console.log(usage());
}

/** The owner's view of one proposal: the proposed text fenced as untrusted transcript text. */
export async function ownerView(row: MemoryProposal): Promise<Record<string, unknown>> {
  const { fenceTranscriptText } = await import('../core/search/transcript-quote.ts');
  const payload = Object.fromEntries(Object.entries(row.payload ?? {}).map(([k, v]) =>
    [k, typeof v === 'string' && ['summary', 'detail', 'source', 'context'].includes(k) && v ? fenceTranscriptText(v, row.slug) : v]));
  return {
    request_id: row.request_id, state: row.state, kind: row.kind, source_id: row.source_id, target: row.slug, ...(row.to_slug ? { to: row.to_slug } : {}),
    member_id: row.member_id, system: row.system, external_id: row.external_id, principal_kind: row.principal_kind, principal_id: row.principal_id,
    created_at: row.created_at, expires_at: row.expires_at, ...(row.decided_at ? { decided_at: row.decided_at, decided_by: row.decided_by } : {}),
    ...(row.reason ? { reason: row.reason } : {}), ...(row.error_code ? { error_code: row.error_code } : {}),
    payload: row.payload === null ? null : payload, quoted: 'transcript',
  };
}

function line(view: Record<string, any>): string {
  const what = view.kind === 'timeline' ? `${view.payload?.date ?? ''} ${view.payload?.summary ?? ''}` : `-> ${view.to} ${view.payload?.link_type ?? ''}`;
  return `${view.request_id} [${view.state}] ${view.kind} on ${view.source_id}:${view.target} for member:${view.member_id}\n  ${what}`;
}

/** The owner's trusted context for approve and deny, shared by this command and the owner HTTP routes (serve-http-access.ts). */
export async function ownerContext(engine: BrainEngine, dryRun: boolean): Promise<OperationContext> {
  const { loadConfig } = await import('../core/config.ts');
  return { engine, config: loadConfig() ?? { engine: engine.kind }, remote: false, dryRun, logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
}

async function decidedBy(engine: BrainEngine): Promise<string> {
  try { return `cli:${(await (await import('../core/persistence/identity.ts')).readLocalWriter(engine, 'cli')).id}`; } catch { return 'cli'; }
}

export async function runMemoryProposals(engine: BrainEngine, args: string[]): Promise<void> {
  if (subcommandHelpRequested(args, ROUTERS['memory-proposals'])) { printUsage(); return; }
  const [sub, ...rest] = args as [(typeof MEMORY_PROPOSALS_SUBCOMMANDS)[number] | undefined, ...string[]];
  const json = rest.includes('--json');
  const dryRun = rest.includes('--dry-run');
  const flag = (name: string) => {
    const at = rest.findIndex(a => a === name || a.startsWith(`${name}=`));
    if (at < 0) return undefined;
    return rest[at] === name ? rest[at + 1] ?? '' : rest[at]!.slice(name.length + 1);
  };
  const id = rest.find(a => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(a));
  const out = (value: unknown, text: string) => console.log(json ? JSON.stringify(value, null, 2) : text);
  const lib = await import('../core/persistence/memory-proposals.ts');
  if (!sub) { printUsage(); return; }
  try {
    if (sub === 'list') {
      const rawLimit = flag('--limit');
      const limit = rawLimit === undefined ? 50 : intFlagValue(rawLimit, '--limit', { min: 1, example: 50 });
      const rows = await lib.listMemoryProposals(engine, { sourceId: flag('--source'), all: rest.includes('--all'), limit });
      const views = await Promise.all(rows.map(ownerView));
      out({ proposals: views }, views.length ? views.map(line).join('\n') + '\n\nNext: gbrain memory-proposals show <request_id>, then approve <request_id> or deny <request_id> --reason "<why>"'
        : 'No memory proposals await your decision.');
      return;
    }
    if (!id) { console.error(`${usage()}\n\nA request id is required (gbrain memory-proposals list shows them).`); setCliExitVerdict(2); return; }
    if (sub === 'show') {
      const view = await ownerView(await lib.ownerProposal(engine, id));
      out(view, `${line(view)}\n${JSON.stringify(view.payload, null, 2)}`);
      return;
    }
    const ctx = await ownerContext(engine, dryRun);
    if (sub === 'approve') {
      const result = await lib.approveMemoryProposal(ctx, id, { decidedBy: await decidedBy(engine) });
      out(result, result.dry_run ? `${id}: would be ${result.would}${result.error_code ? ` (${result.error_code}: ${result.reason})` : ''}`
        : `${id}: ${result.status}${result.error_code ? ` (${result.error_code}: ${result.reason})` : ''}${(result.write_request as { state?: string } | undefined)?.state ? `; write ${(result.write_request as { state: string }).state}` : ''}`);
      if (lib.approveFailed(result)) setCliExitVerdict(1);
      return;
    }
    if (sub === 'deny') {
      const reason = flag('--reason');
      if (reason === undefined) { console.error('deny needs --reason "<why>": the proposer reads it on the receipt.'); setCliExitVerdict(2); return; }
      const result = await lib.denyMemoryProposal(ctx, id, reason, { decidedBy: await decidedBy(engine) });
      out(result, result.dry_run ? `${id}: would be denied` : `${id}: denied`);
      return;
    }
  } catch (error) {
    if (!(error instanceof OperationError)) throw error;
    console.error(`${error.code}: ${error.message}\n${error.suggestion}`);
    setCliExitVerdict(error.code === 'invalid_params' ? 2 : 1);
    return;
  }
  console.error(usage());
  setCliExitVerdict(2);
}
