/**
 * `gbrain claims check` (agent-platform C3): the CLI form of the check_claims op. It checks the numbers in a draft
 * against the allowed-claims pages (type: facts with claims: allowed) and prints, per claim, supported with the cited
 * dated line, conflicts with the lines that say otherwise, or not found. Trusted local op dispatch (handleToolCall).
 */
import { readFileSync } from 'node:fs';
import type { BrainEngine } from '../core/engine.ts';
import { handleToolCall } from '../mcp/server.ts';
import type { ClaimCheck } from '../core/claims/check.ts';
import type { SkipReason } from '../core/ops/claims.ts';

export const CLAIMS_USAGE = [
  'Usage: gbrain claims check "<draft text>" [--file <path>] [--source <id>] [--json]',
  '',
  'Checks every sentence with a number against the dated lines of your allowed-claims pages',
  '(a page with type: facts and claims: allowed, such as me/facts or company/facts).',
  'Reads the draft from the argument, --file, or stdin.',
  '  supported   a dated line says the same number (it is cited)',
  '  conflicts   a dated line about the same thing says another number',
  '  not found   no allowed claim covers it; that is not proof it is false',
].join('\n');

export { CLAIMS_SUBCOMMANDS as SUBCOMMANDS } from '../cli/subcommands.ts';
export function printUsage(): void { console.log(CLAIMS_USAGE); }

interface CheckResult {
  claims: ClaimCheck[];
  summary: { supported: number; conflicts: number; not_found: number };
  allowed_pages: number;
  skipped?: Array<{ slug: string; reason: SkipReason }>;
}

const SKIP_REASONS: Record<SkipReason, string> = {
  segmented: 'stored in segments',
  quarantined: 'quarantined',
  external: 'outside source',
  written_by_agent: 'written by an agent',
  not_approved: 'source is not approved or record',
};

const where = (l: { slug: string; line: number; date: string }) => `${l.slug}:${l.line} (${l.date})`;

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) { console.error(`${flag} needs a value.\n${CLAIMS_USAGE}`); process.exit(2); }
  return v;
}

export async function runClaims(engine: BrainEngine, args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (sub === 'help' || args.includes('--help') || args.includes('-h')) { console.log(CLAIMS_USAGE); return; }
  if (sub !== 'check') { console.error(CLAIMS_USAGE); process.exit(2); }
  const json = rest.includes('--json');
  const file = flagValue(rest, '--file');
  const source = flagValue(rest, '--source');
  const valued = new Set([file, source].filter(Boolean));
  const positional = rest.filter((a, i) => !a.startsWith('--') && !(valued.has(a) && rest[i - 1]?.startsWith('--')));
  const text = file !== undefined ? readFileSync(file, 'utf8')
    : positional.length ? positional.join(' ')
    : process.stdin.isTTY ? '' : readFileSync(0, 'utf8');
  if (!text.trim()) { console.error(CLAIMS_USAGE); process.exit(2); }
  const result = await handleToolCall(engine, 'check_claims', { text, ...(source ? { source_id: source } : {}) }) as CheckResult;
  if (json) { console.log(JSON.stringify(result, null, 2)); return; }
  for (const c of result.claims) {
    if (c.status === 'supported') console.log(`supported  "${c.claim}"  ${where(c.cited!)}`);
    else if (c.status === 'conflicts') {
      console.log(`conflicts  "${c.claim}"`);
      for (const l of c.conflicting ?? []) console.log(`           ${where(l)}: ${l.text}`);
    } else console.log(`not found  "${c.claim}"  (no allowed claim covers this; not proof it is false)`);
  }
  if (result.skipped?.length) console.log(`Skipped ${result.skipped.map(s => `${s.slug} (${SKIP_REASONS[s.reason]})`).join(', ')}.`);
  const { supported, conflicts, not_found } = result.summary;
  console.log(`${result.claims.length} claim(s): ${supported} supported, ${conflicts} conflicts, ${not_found} not found (${result.allowed_pages} allowed-claims page(s) read).`);
  if (result.allowed_pages === 0) console.log('No allowed-claims page is readable. Add "claims: allowed" to the frontmatter of a type: facts page, such as me/facts or company/facts, from this machine (gbrain put or an edit in the brain repo); a page an agent wrote over MCP, or an outside sender\'s page, never counts.');
}
