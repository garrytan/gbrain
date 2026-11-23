/**
 * The census member-caller pass: every MCP tool runs a second time through a stdio `gbrain serve --stdio-member`
 * bound to a live member with a group (a reader list), on a brain with no access restrictions (`restricted: false`)
 * whose owner is another member. The anonymous stdio caller has no identity, so a policy that widens on the
 * caller's member pages, groups or grants is never rendered for it; this pass reaches those sites.
 *
 * Its results sit in their own column and section: the anonymous totals never include them.
 *
 * It also counts the "(option X)" refusals (src/core/rust-engine/store-members/common.ts takeOptions: the member is
 * served, one of its options is not) per tool, for each caller.
 */

export type CallerStatus = 'equal' | 'differs' | 'refused' | 'crash' | 'skipped';

/** What one MCP tool did for the member caller (rows[].member in the census JSON). */
export interface MemberResult {
  status: CallerStatus;
  /** The member the run ended on, as the refusal names it. */
  decisive?: string;
  endSite?: string;
  /** Every distinct refusal the run built, as member@site, minus the member serve's startup refusals. */
  sites?: string[];
  /** The run's "(option X)" refusals (optionRefusals), minus the member serve's startup refusals. */
  options?: string[];
  note: string;
}

/** The fields of a census row this module reads. */
export interface PassRow {
  surface: 'cli' | 'mcp';
  name: string;
  status: CallerStatus;
  decisive?: string;
  endSite?: string;
  sites?: string[];
  /** The run's "(option X)" refusals, minus the serve's startup refusals. */
  options?: string[];
  member?: MemberResult;
}

export const MEMBER_ID = 'census-reader';
export const MEMBER_GROUP = 'census-team';
export const OWNER_ID = 'census-owner';

/** The CLI steps that make a base brain serve a member caller; each must exit 0 on an arm for the pass to run there. */
export const MEMBER_SETUP: string[][] = [
  ['access', 'member', 'add', OWNER_ID, '--json'],
  ['access', 'member', 'add', MEMBER_ID, '--groups', MEMBER_GROUP, '--json'],
  ['access', 'owner', 'set', OWNER_ID, '--json'],
];

/** The serve arguments of the member caller. */
export const MEMBER_SERVE_ARGS = ['--stdio-member', MEMBER_ID];

const OPTION = /^(.+? \(option [^)]+\))@/;

/** The distinct "(option X)" refusals among a run's refusal sites, as `member (option X)`, in first-seen order. */
export function optionRefusals(sites: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const s of sites ?? []) {
    const m = OPTION.exec(s);
    if (m && !out.includes(m[1]!)) out.push(m[1]!);
  }
  return out;
}

/** A refusal whose text says the caller's policy widens past what the Rust store models. */
export const WIDENING = /widen/;

/** The member column of the MCP table: the status and, for a refusal, the member and site it ended on. */
export function memberCell(r: PassRow): string {
  if (!r.member) return '';
  const end = r.member.decisive ? ` ${r.member.decisive}${r.member.endSite ? ` @ ${r.member.endSite}` : ''}` : '';
  return `${r.member.status}${end}`;
}

const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
const STATUSES: CallerStatus[] = ['equal', 'differs', 'refused', 'crash', 'skipped'];

/** The member-caller section of the census report: totals, what changed from the anonymous run, and option refusals. */
export function renderMemberPass(rows: readonly PassRow[], setup: readonly string[]): string {
  const mcp = rows.filter((r) => r.surface === 'mcp');
  const ran = mcp.filter((r) => r.member);
  const lines: string[] = ['## Member-caller pass (MCP)', ''];
  lines.push(`Each MCP tool again, through \`serve ${MEMBER_SERVE_ARGS.join(' ')}\`: a live member with group \`${MEMBER_GROUP}\` on a brain with no access restrictions, whose owner is \`${OWNER_ID}\`. These counts are not in the totals above.`, '');
  if (setup.length) lines.push(...setup.map((s) => `- ${s}`), '');
  if (!ran.length) { lines.push('Not run.', ''); return lines.join('\n'); }
  const count = (pick: (r: PassRow) => CallerStatus | undefined, s: CallerStatus) => ran.filter((r) => pick(r) === s).length;
  lines.push('| caller | tools | ' + STATUSES.join(' | ') + ' |', '|---|---|' + STATUSES.map(() => '---|').join(''));
  lines.push(`| anonymous (same tools) | ${ran.length} | ${STATUSES.map((s) => count((r) => r.status, s)).join(' | ')} |`);
  lines.push(`| member | ${ran.length} | ${STATUSES.map((s) => count((r) => r.member?.status, s)).join(' | ')} |`, '');

  const widening = ran.filter((r) => r.member!.status !== 'equal' && WIDENING.test([r.member!.decisive ?? '', ...(r.member!.sites ?? [])].join(' ')));
  const skipped = ran.filter((r) => r.member!.status === 'skipped');
  if (skipped.length === ran.length) lines.push(`Every member cell is skipped: ${ran[0]!.member!.note}`, '');
  const changed = ran.filter((r) => r.member!.status !== 'skipped' && (r.member!.status !== r.status || (r.member!.decisive ?? '') !== (r.decisive ?? '')));
  lines.push(`Tools whose member-caller result differs from the anonymous one: ${changed.length}. Of those, or of any member refusal, ${widening.length} name a widening policy.`, '');
  if (changed.length) {
    lines.push('| tool | anonymous | member | member ended on |', '|---|---|---|---|');
    for (const r of changed) lines.push(`| ${esc(r.name)} | ${r.status} | ${r.member!.status} | ${esc(r.member!.decisive ? `${r.member!.decisive}${r.member!.endSite ? ` @ ${r.member!.endSite}` : ''}` : r.member!.note)} |`);
    lines.push('');
  }

  const clusters = new Map<string, string[]>();
  for (const r of ran) if (r.member!.decisive) clusters.set(`${r.member!.decisive} @ ${r.member!.endSite ?? ''}`, [...(clusters.get(`${r.member!.decisive} @ ${r.member!.endSite ?? ''}`) ?? []), r.name]);
  if (clusters.size) {
    lines.push('### Member-caller refusals (by the member the tool ended on)', '', '| member @ site | tools | names |', '|---|---|---|');
    for (const [k, names] of [...clusters.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))) lines.push(`| ${esc(k)} | ${names.length} | ${esc(names.join(', '))} |`);
    lines.push('');
  }

  const opt = mcp.map((r) => ({ name: r.name, anon: r.options ?? optionRefusals(r.sites), member: r.member?.options ?? optionRefusals(r.member?.sites) })).filter((o) => o.anon.length || o.member.length);
  lines.push('### "(option X)" refusals per tool (takeOptions: the member is served, the option is not)', '');
  const total = (k: 'anon' | 'member') => opt.reduce((n, o) => n + o[k].length, 0);
  lines.push(`Anonymous: ${total('anon')} across ${opt.filter((o) => o.anon.length).length} tools. Member: ${total('member')} across ${opt.filter((o) => o.member.length).length} tools.`, '');
  if (opt.length) {
    lines.push('| tool | anonymous | member | refusals |', '|---|---|---|---|');
    for (const o of opt) lines.push(`| ${esc(o.name)} | ${o.anon.length} | ${o.member.length} | ${esc([...new Set([...o.anon, ...o.member])].join('; '))} |`);
    lines.push('');
  }
  return lines.join('\n');
}
