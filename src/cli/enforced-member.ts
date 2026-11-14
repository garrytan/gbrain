/**
 * GST-2476 G2: enforced member mode. When GBRAIN_ENFORCED_MEMBER is set, the CLI acts as that member: the gate in
 * src/cli/main.ts classifies the command (src/cli/enforced-member-classes.ts) before any other work, reads run as the
 * in-process stdio MCP server bound to the member would answer them (remote: true, privacy always hidden, other
 * members' personal sources out of scope), and writes stay trusted local writes that land exactly where they land
 * without the mode, after the checks here refuse a target the member cannot read and every label change. The mode binds
 * only a caller whose launcher pins the variable; unsetting it or opening the database directly is out of scope.
 * Guide: docs/guides/enforced-member.md.
 */
import type { BrainEngine } from '../core/engine.ts';
import type { CallerAccess } from '../core/search/private-visibility.ts';
import { ACCESS_ID_RE } from '../core/access/principals.ts';
import { opError } from '../core/ops/contract.ts';
import { writeCliError } from './cli-error.ts';
import { CLI_COMMAND_CLASSES, OPERATION_CLASSES, OPERATION_SUBCOMMANDS, enforcedClassOf, type EnforcedClass } from './enforced-member-classes.ts';

export const ENFORCED_MEMBER_ENV = 'GBRAIN_ENFORCED_MEMBER';
export const ENFORCED_REFUSED_TAG = 'GBRAIN_ENFORCED_REFUSED';
export const ENFORCED_DOCS = 'docs/guides/enforced-member.md#refused';

export type EnforcedReason = 'command_not_allowed' | 'member_not_usable' | 'target_not_readable' | 'label_change' | 'thin_client'
  | 'as_flag' | 'arguments_not_allowed' | 'remember_needs_entity' | 'writes_off';

const REASON_TEXT: Record<EnforcedReason, string> = {
  command_not_allowed: 'This command is not on the enforced member allow-list.',
  member_not_usable: 'The variable is empty or names no enabled member this mode can act as.',
  target_not_readable: 'A page or source this command would write or read is outside what this member may read.',
  label_change: 'This write would change an access or privacy label.',
  thin_client: 'A thin client reads as its own credential, so it cannot act as one member.',
  as_flag: '--as is refused under this mode.',
  arguments_not_allowed: 'These arguments are not allowed under this mode.',
  remember_needs_entity: 'remember needs --entity naming the exact slug of a page this member reads.',
  writes_off: 'This brain turned off member writes under this mode: its config access.enforced_member_writes is refuse (or a value other than checked and refuse_pages), or could not be read.',
};

/** The mode's member value, or undefined when the mode is off (the variable unset). */
export function enforcedMemberValue(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[ENFORCED_MEMBER_ENV];
}

export function enforcedModeOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return enforcedMemberValue(env) !== undefined;
}

/** The value as printed: a well-formed member id as is, anything else never echoed. */
export function enforcedMemberLabel(value = enforcedMemberValue() ?? ''): string {
  return value === '' ? '' : ACCESS_ID_RE.test(value) ? value : '<invalid>';
}

function commandLabel(command: string): string {
  return command.split(' ').every(part => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(part)) ? command : '<command>';
}

/** The one constant stderr line every read-filtered command prints, whether or not anything was hidden. */
export function filteredNotice(): string {
  return 'gbrain: results limited to what GBRAIN_ENFORCED_MEMBER=' + enforcedMemberLabel() + ' may read\n';
}

let noticeWritten = false;

/** Writes the constant line once per process (a read may dispatch more than once). */
export function emitFilteredNotice(): void {
  if (noticeWritten) return;
  noticeWritten = true;
  try { process.stderr.write(filteredNotice()); } catch { /* stderr gone */ }
}

/** A refusal whose first line says what to do instead of naming the command (the prefix and tag stay the same). */
const REASON_HEADLINE: Partial<Record<EnforcedReason, string>> = {
  remember_needs_entity: 'remember saves a fact only with --entity <slug of a page you can read>; nothing was saved',
  writes_off: 'writes are off for members on this brain; nothing was saved',
};

const REASON_NEXT: Partial<Record<EnforcedReason, { fix: string; recovery: string }>> = {
  remember_needs_entity: { fix: 'run the Retry command with --entity set to the exact slug of a page you can read.', recovery: 'nothing was saved, so retrying with --entity is safe.' },
  writes_off: { fix: 'ask the brain owner to save it in a direct session (one without ' + ENFORCED_MEMBER_ENV + ').', recovery: 'nothing was saved; the same call refuses every time, so do not retry here.' },
};

const OWNER_FIX = 'ask the brain owner to run this in a direct session (one without ' + ENFORCED_MEMBER_ENV + ').';
const NOTHING_CHANGED = 'do not retry here; nothing was changed.';

/** The refusal's stderr text: the exact first line, the retry shape, the fix, the recovery and the docs anchor; no secret values. */
export function refusalText(command: string, reason: EnforcedReason, retry?: string, why?: string): string {
  return ['gbrain: refused under ' + ENFORCED_MEMBER_ENV + '=' + enforcedMemberLabel() + ': ' + (REASON_HEADLINE[reason] ?? commandLabel(command)) + ' [' + ENFORCED_REFUSED_TAG + ']',
    ...(retry ? ['Retry: ' + retry] : []),
    'Why: ' + (why ?? REASON_TEXT[reason]),
    'Fix: ' + (REASON_NEXT[reason]?.fix ?? OWNER_FIX),
    'Recovery: ' + (REASON_NEXT[reason]?.recovery ?? NOTHING_CHANGED),
    'Docs: ' + ENFORCED_DOCS, ''].join('\n');
}

export function enforcedRefusalError(command: string, reason: EnforcedReason, why?: string) {
  const next = REASON_NEXT[reason];
  return opError('enforced_member_refused', 'Refused under ' + ENFORCED_MEMBER_ENV + ': ' + (REASON_HEADLINE[reason] ?? commandLabel(command)) + '. ' + (why ?? REASON_TEXT[reason]),
    next ? next.recovery + ' Fix: ' + next.fix : 'Do not retry here; nothing was changed. Ask the brain owner to run it in a direct session.', { reason, docs: ENFORCED_DOCS });
}

/** Refuses and exits: the exact stderr text, and under --json the envelope on stdout; exit 3. */
export async function refuseEnforced(command: string, reason: EnforcedReason, opts: { engine?: BrainEngine | null; retry?: string; why?: string } = {}): Promise<never> {
  try { process.stderr.write(refusalText(command, reason, opts.retry, opts.why)); } catch { /* stderr gone */ }
  const code = writeCliError(enforcedRefusalError(command, reason, opts.why), command, { stderr: false });
  const { finishCliTeardown, setCliExitVerdict, flushThenExit } = await import('../core/cli-force-exit.ts');
  if (opts.engine) await finishCliTeardown({ engine: opts.engine }).catch(() => {});
  setCliExitVerdict(code);
  flushThenExit(code);
  return await new Promise<never>(() => {});
}

/** The subcommand-qualified label of a mixed command (sources refresh, git commit-push), else the command. */
export function enforcedCommandLabel(command: string, args: readonly string[]): string {
  const spec = CLI_COMMAND_CLASSES[command] ?? OPERATION_SUBCOMMANDS[command];
  const first = args.find(a => !a.startsWith('-'));
  if (!spec || typeof spec === 'string' || !first || !/^[a-z][a-z-]*$/.test(first)) return command;
  return spec.default === 'refused' || spec.sub[first] !== undefined ? command + ' ' + first : command;
}

export interface EnforcedGateInput {
  command: string;
  args: readonly string[];
  opName: string | undefined;
  helpRequested: boolean;
  asFlag: boolean;
  thinClient: boolean;
}

/**
 * The gate: undefined when the mode is off; otherwise the command's class, after refusing (and exiting) anything
 * refused or unclassified, --as, a thin client and an empty or ill-formed value. Help always prints (it is static).
 * hook is answered here: nothing on stdout, the constant line on stderr, exit 0 (the one deliberate success).
 */
export async function enforcedGate(input: EnforcedGateInput): Promise<EnforcedClass | undefined> {
  const value = enforcedMemberValue();
  if (value === undefined) return undefined;
  const label = enforcedCommandLabel(input.command, input.args);
  process.env.GBRAIN_NO_SOLE_NON_DEFAULT_NUDGE = '1';
  if (input.asFlag) return refuseEnforced(label, 'as_flag');
  const cls = enforcedClassOf(input.command, input.args, input.opName);
  if (cls === 'silent') {
    const { setCliExitVerdict, flushThenExit } = await import('../core/cli-force-exit.ts');
    try { process.stderr.write(filteredNotice()); } catch { /* stderr gone */ }
    setCliExitVerdict(0);
    flushThenExit(0);
    return await new Promise<never>(() => {});
  }
  if (cls === 'refused') return refuseEnforced(label, 'command_not_allowed');
  if (input.helpRequested) return cls;
  if (cls === 'allowed' && (input.command === 'errors' || input.command === 'protocol')) return cls;
  if (input.thinClient) return refuseEnforced(label, 'thin_client');
  if (value === '' || !ACCESS_ID_RE.test(value)) return refuseEnforced(label, 'member_not_usable');
  return cls;
}

export interface EnforcedAccess {
  member: string;
  access: Partial<CallerAccess> & { identity: string[]; satisfiedRuleIds: string[] };
  /** Other members' personal sources: outside this member's reads and writes. */
  hiddenSources: Set<string>;
}

const ACCESS_CACHE = new WeakMap<BrainEngine, EnforcedAccess>();

/**
 * The member's live read record, refusing (and exiting) when the value names no enabled member or names the owner
 * (config access.owner_member). Never falls back to the trusted caller.
 */
export async function enforcedAccess(engine: BrainEngine, command: string): Promise<EnforcedAccess> {
  const cached = ACCESS_CACHE.get(engine);
  if (cached) return cached;
  const member = enforcedMemberValue() ?? '';
  let resolved: EnforcedAccess | null = null;
  try {
    if (member && ACCESS_ID_RE.test(member)) {
      const [{ memberIdentity }, { ownerMemberId }, { remoteCallerAccess }, { hiddenPersonalSources }] = await Promise.all([
        import('../core/access/members.ts'), import('../core/access/owner.ts'), import('../core/access/caller.ts'), import('../core/access/member-sources.ts')]);
      const { member: id } = await memberIdentity(engine, member);
      if (id === member && await ownerMemberId(engine) !== member) {
        const base = await remoteCallerAccess(engine, undefined, [], 'stdio', null, member);
        const sources = await engine.executeRaw<{ id: string }>('SELECT id FROM sources');
        resolved = {
          member,
          access: { ...base, identity: [...base.identity ?? []], satisfiedRuleIds: [...base.satisfiedRuleIds ?? []], hidePrivate: true, owner: false, privateReadableSources: [], applyRemoteReadPolicy: false },
          hiddenSources: await hiddenPersonalSources(engine, sources.map(s => s.id), member, false),
        };
      }
    }
  } catch { resolved = null; }
  if (!resolved) return refuseEnforced(command, 'member_not_usable', { engine });
  ACCESS_CACHE.set(engine, resolved);
  return resolved;
}

/** Refuses a named source the member cannot read: another member's personal source, or one that is not registered (the same refusal, so the two read alike). */
export async function checkEnforcedSource(engine: BrainEngine, command: string, sourceId: string): Promise<void> {
  const ea = await enforcedAccess(engine, command);
  const [row] = ea.hiddenSources.has(sourceId) ? [] : await engine.executeRaw<{ id: string }>('SELECT id FROM sources WHERE id = $1 AND archived = false', [sourceId]);
  if (!row) await refuseEnforced(command, 'target_not_readable', { engine });
}

/** Every source an operation's arguments name: --source (unless the operation owns a param called source), --source-id, --source-ids. */
function namedSources(op: { params: Record<string, unknown> }, params: Record<string, unknown>): string[] {
  const out: string[] = [];
  const add = (v: unknown) => { for (const s of Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : []) if (typeof s === 'string' && s.trim()) out.push(s.trim()); };
  if (!('source' in op.params)) add(params.source);
  add(params.source_id);
  add(params.source_ids);
  return out;
}

export const ENFORCED_MEMBER_WRITES_KEY = 'access.enforced_member_writes';

export type EnforcedWritesMode = 'checked' | 'refuse_pages' | 'refuse';

/**
 * The brain's switch for writes under the mode, read from the database config (never the environment): unset or checked
 * keeps writes checked; refuse_pages refuses page-write operations and leaves named-path git commit-push to its checks;
 * refuse, any other value and a failed read refuse both.
 */
export async function enforcedWritesMode(engine: BrainEngine): Promise<EnforcedWritesMode> {
  try {
    const value = (await engine.getConfig(ENFORCED_MEMBER_WRITES_KEY))?.trim().toLowerCase() ?? null;
    if (value === null || value === 'checked') return 'checked';
    return value === 'refuse_pages' ? 'refuse_pages' : 'refuse';
  } catch { return 'refuse'; }
}

const PAGE_WRITES_OFF_WHY = 'This brain turned off member page writes under this mode: its config access.enforced_member_writes is refuse_pages.';

/** Refuses a write the brain's switch turned off: the same headline for every target, the Why naming what the mode turned off. */
export async function refuseWritesOff(engine: BrainEngine, command: string, mode: Exclude<EnforcedWritesMode, 'checked'>): Promise<never> {
  return refuseEnforced(command, 'writes_off', { engine, ...(mode === 'refuse_pages' ? { why: PAGE_WRITES_OFF_WHY } : {}) });
}

/**
 * An operation's argument checks before its context is built: a write refuses first when the brain turned member writes
 * off (before any member, page or source lookup, so every target answers alike; get_write_request only reads a receipt),
 * then the member resolves, every source it names is one the member reads (the federated __all__ stays: the read scope
 * already drops hidden sources), and get_stats only with --by.
 */
export async function checkEnforcedOpArgs(engine: BrainEngine, command: string, op: { name: string; params: Record<string, unknown> }, params: Record<string, unknown>): Promise<void> {
  if (OPERATION_CLASSES[op.name] === 'write' && op.name !== 'get_write_request') {
    const mode = await enforcedWritesMode(engine);
    if (mode !== 'checked') await refuseWritesOff(engine, command, mode);
  }
  await enforcedAccess(engine, command);
  for (const s of namedSources(op, params)) if (s !== '__all__') await checkEnforcedSource(engine, command, s);
  if (op.name === 'get_stats' && params.by === undefined) await refuseEnforced(command, 'arguments_not_allowed', { engine });
}

/**
 * A classified CLI-only command under the mode. recall reads through the member filter inside its own handler
 * (commands/recall.ts); sync, sources refresh, git commit-push and doctor validate the member (and commit-push its
 * paths) on a short probe connection, then run with their output withheld (doctor: names, statuses and counts only).
 */
export async function runEnforcedCliOnly(command: string, subArgs: string[], deps: {
  handleCliOnly: (command: string, args: string[]) => Promise<void>;
  connectEngine: () => Promise<BrainEngine>;
}): Promise<void> {
  const label = enforcedCommandLabel(command, subArgs);
  if (command === 'recall') {
    if (['--pending', '--supersessions', '--session', '--watch', '--since-last-run'].some(f => subArgs.some(a => a === f || a.startsWith(f + '=')))) await refuseEnforced(label, 'arguments_not_allowed');
    return deps.handleCliOnly(command, subArgs);
  }
  if (command === 'doctor' && subArgs.some(a => a !== '--json')) await refuseEnforced(label, 'arguments_not_allowed');
  const syncSource = command === 'sync' || command === 'sources' ? syncSourceArg(command, subArgs) : undefined;
  if (syncSource === null) await refuseEnforced(label, 'arguments_not_allowed');
  const probe = await deps.connectEngine();
  try {
    await enforcedAccess(probe, label);
    if (command === 'git') await (await import('./enforced-commit-push.ts')).checkEnforcedCommitPush(probe, subArgs);
    if (typeof syncSource === 'string') await checkEnforcedSource(probe, label, syncSource || await (await import('../core/source-resolver.ts')).resolveSourceId(probe, null));
  } finally {
    await probe.disconnect().catch(() => {});
  }
  if (command === 'doctor') return withDoctorCounts(subArgs.includes('--json'), () => deps.handleCliOnly('doctor', ['--json']));
  await withWithheldOutput(label, () => deps.handleCliOnly(command, subArgs));
}

const SYNC_FLAGS = new Set(['--no-pull', '--no-embed', '--json', '--dry-run']);

/**
 * The source a sync or sources refresh under the mode names, on its flag allow-list: sync takes --source <id> (or none:
 * '' then means the brain's resolved source) with --no-pull, --no-embed, --json and --dry-run; sources refresh exactly
 * one id with --json or --dry-run. null: an argument outside the list (--repo, --all, --full, --watch, a subcommand, ...).
 */
function syncSourceArg(command: string, args: readonly string[]): string | null {
  const rest = command === 'sources' ? args.slice(args.indexOf('refresh') + 1) : args;
  let source: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (command === 'sync' ? SYNC_FLAGS.has(a) : a === '--json' || a === '--dry-run') continue;
    if (command === 'sync' && (a === '--source' || a.startsWith('--source='))) {
      if (source !== undefined) return null;
      source = a === '--source' ? rest[++i] : a.slice('--source='.length);
      if (!source || source.startsWith('-')) return null;
      continue;
    }
    if (a.startsWith('-') || command === 'sync') return null;
    positional.push(a);
  }
  if (command === 'sources') return positional.length === 1 ? positional[0]! : null;
  return source ?? '';
}

export interface EnforcedScope { sourceId?: string; localFederatedSourceIds?: string[]; config?: import('../core/config.ts').GBrainConfig }

/**
 * A read answered as the in-process stdio MCP server bound to the member would answer it, unpacked to the operation's
 * result (or its error, rethrown as an OperationError). The scope is the CLI's own source resolution minus other
 * members' personal sources; a resolved source that is one of them refuses.
 */
export async function enforcedRead(engine: BrainEngine, command: string, opName: string, params: Record<string, unknown>, scope: EnforcedScope): Promise<unknown> {
  const { hiddenSources, member } = await enforcedAccess(engine, command);
  if (scope.sourceId && hiddenSources.has(scope.sourceId)) return refuseEnforced(command, 'target_not_readable', { engine });
  emitFilteredNotice();
  const federated = scope.localFederatedSourceIds?.filter(s => !hiddenSources.has(s));
  const [{ dispatchToolCall }, { loadOperation }] = await Promise.all([import('../mcp/dispatch.ts'), import('../core/operation-load.ts')]);
  const declared = (await loadOperation(opName))?.params ?? {};
  const wire = Object.fromEntries(Object.entries(params).filter(([k]) => k in declared));
  const out = await dispatchToolCall(engine, opName, wire, {
    remote: true, transport: 'stdio', stdioMember: member, enforcedMember: true, admissionOrigin: 'interactive',
    takesHoldersAllowList: ['world'],
    ...(scope.config ? { config: scope.config } : {}),
    ...(scope.sourceId ? { sourceId: scope.sourceId } : {}),
    ...(federated ? { localFederatedSourceIds: federated } : {}),
  });
  const text = out.content?.[0]?.text ?? '';
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  if (out.isError) {
    const { reviveOperationError } = await import('../core/cli-socket/protocol.ts');
    const env = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
    throw reviveOperationError({ code: env.code ?? env.error ?? 'internal_error', message: env.message ?? text, ...(typeof env.suggestion === 'string' ? { suggestion: env.suggestion } : {}),
      ...(typeof env.docs === 'string' ? { docs: env.docs } : {}), ...(env.reason ? { reason: env.reason } : {}) });
  }
  return withoutCoverageCounts(parsed);
}

const COVERAGE_COUNT_RE = /\b\d+ page\(s\) have not been scanned/g;

/**
 * Mention coverage counts every page of a source, readable or not, so under the mode its pending_pages is dropped and the
 * notice that quotes it says "Some pages" instead.
 */
function withoutCoverageCounts(value: unknown, depth = 0): unknown {
  if (depth > 16) return value;
  if (typeof value === 'string') return value.replace(COVERAGE_COUNT_RE, 'Some pages have not been scanned');
  if (Array.isArray(value)) return value.map(v => withoutCoverageCounts(v, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const entries = Object.entries(value as Record<string, unknown>);
  const coverage = entries.some(([k]) => k === 'pending_pages') && entries.some(([k]) => k === 'state');
  return Object.fromEntries(entries.filter(([k]) => !(coverage && k === 'pending_pages')).map(([k, v]) => [k, withoutCoverageCounts(v, depth + 1)]));
}

type PageView = 'readable' | 'hidden' | 'missing';

/**
 * Whether the member reads a page: an existing row under the member's full read policy, a new slug under the folder rules it
 * would sit under. GBRA-108 design 1: a labelled-only member reads an existing row only when it names the member, and a
 * new slug only under a rule that lists it (the mode refuses label changes, so a rule is the only way a create names it).
 */
export async function memberPageView(engine: BrainEngine, ea: EnforcedAccess, sourceId: string, slug: string): Promise<PageView> {
  if (ea.hiddenSources.has(sourceId)) return 'hidden';
  const { withCallerAccess, readPolicyFragment, folderRulesAllowedSql, labelledOnlyForSql } = await import('../core/search/private-visibility.ts');
  const { access } = ea;
  const labelled = access.labelledOnly ? ' AND ' + labelledOnlyForSql('p', [access.identity], access.satisfiedRuleIds) : '';
  let view: PageView = 'missing';
  for (const candidate of [...new Set([slug, slug.toLowerCase()])]) {
    const policy = withCallerAccess(access, () => readPolicyFragment('p', access.identity, true, access.satisfiedRuleIds)) + labelled;
    const [row] = await engine.executeRaw<{ ok: boolean }>('SELECT (' + policy + ') AS ok FROM pages p WHERE p.source_id = $1 AND p.slug = $2 LIMIT 1', [sourceId, candidate]);
    if (row) { if (!row.ok) return 'hidden'; view = 'readable'; continue; }
    const folder = withCallerAccess(access, () => folderRulesAllowedSql('p', access.satisfiedRuleIds))
      + (access.labelledOnly ? ' AND ' + labelledOnlyForSql('p', [access.identity], access.satisfiedRuleIds, false) : '');
    const [rule] = await engine.executeRaw<{ ok: boolean }>('SELECT (' + folder + ') AS ok FROM (SELECT $1::text AS source_id, $2::text AS slug, gbrain_access_folder_rules($1, $2) AS folder_rule_ids) p', [sourceId, candidate]);
    if (!rule?.ok) return 'hidden';
  }
  return view;
}

const LABEL_KEYS = ['visibility', 'readable_by', 'access', 'confidentiality', 'pinned_question', 'derived_from'] as const;
/** A gbrain fence marker (<!--- gbrain:takes:begin -->, three dashes; any dash count and spacing). */
const FENCE_MARKER_RE = /<!--+\s*gbrain\s*:/i;
const LABEL_TEXT_RE = new RegExp(/readable_by|visibility|confidentiality|pinned_question|derived_from|\bprivate\b|^\s*(access|type)\s*:|^\s*---\s*$/.source + '|' + FENCE_MARKER_RE.source, 'im');

/** The protected-fence text a remote reader never sees (private fact rows and takes), which the member cannot change. */
async function hiddenResidue(body: string | null | undefined): Promise<string> {
  if (!body) return '';
  const [{ PROTECTED_PAIRS, renderFactsRegion }, { protectedRegions }, { sanitizeText }] = await Promise.all([
    import('../core/remote-body.ts'), import('../core/fence-scan.ts'), import('../core/batch-rows.ts')]);
  const text = sanitizeText(body);
  const { regions, truncatedAt } = protectedRegions(text, PROTECTED_PAIRS);
  const out = regions.filter(r => r.pair !== 0 || renderFactsRegion(text.slice(r.start, r.end), true) !== text.slice(r.start, r.end)).map(r => text.slice(r.start, r.end));
  if (truncatedAt !== -1) out.push(text.slice(truncatedAt));
  return out.join('\u0000');
}

/** Every access and privacy label of a page: label keys, normalised readers, derived privacy, and its hidden fence text. */
async function pageLabels(page: { type?: string | null; frontmatter?: unknown; compiled_truth?: string | null; timeline?: string | null } | null): Promise<string> {
  const { isPrivacyPrivatePage } = await import('../core/search/private-visibility.ts');
  const { hasReaders, normalizeReaders } = await import('../core/access/principals.ts');
  const fm = (page?.frontmatter && typeof page.frontmatter === 'object' ? page.frontmatter : {}) as Record<string, unknown>;
  return JSON.stringify({
    private: page ? isPrivacyPrivatePage({ type: page.type ?? null, frontmatter: fm }) : false,
    readers: hasReaders(fm) ? normalizeReaders(fm) ?? '!invalid' : null,
    keys: LABEL_KEYS.map(k => fm[k] ?? null),
    residue: [await hiddenResidue(page?.compiled_truth), await hiddenResidue(page?.timeline)],
  });
}

/** The labels of markdown content (a put, or a file in a commit), or of no page at all for null. */
export async function markdownLabels(content: string | null, slug: string): Promise<string> {
  if (content === null) return pageLabels(null);
  const { parseMarkdown } = await import('../core/markdown.ts');
  const parsed = parseMarkdown(content, slug + '.md');
  return pageLabels({ type: parsed.type, frontmatter: parsed.frontmatter, compiled_truth: parsed.compiled_truth, timeline: parsed.timeline });
}

/** The stored page a label check compares against; a segmented page (no body string) refuses, so the check never reads an empty body as no labels. */
async function storedPage(engine: BrainEngine, sourceId: string, slug: string) {
  const [row] = await engine.executeRaw<{ type: string | null; frontmatter: unknown; compiled_truth: string | null; timeline: string | null; body_storage: 'inline' | 'segmented' | null; body_bytes: number | null }>(
    'SELECT type, frontmatter, compiled_truth, timeline, body_storage, body_bytes FROM pages WHERE source_id = $1 AND slug = $2 LIMIT 1', [sourceId, slug.toLowerCase()]);
  if (row) (await import('../core/page-body/page-shape.ts')).assertInlineBody({ ...row, slug, source_id: sourceId }, 'enforced_member_label_check');
  return row ? { ...row, frontmatter: typeof row.frontmatter === 'string' ? JSON.parse(row.frontmatter) : row.frontmatter } : null;
}

/** The page targets of each write-checked operation. */
function writeTargets(opName: string, p: Record<string, unknown>): string[] {
  const s = (v: unknown) => (typeof v === 'string' ? [v] : []);
  return opName === 'add_link' || opName === 'remove_link' ? [...s(p.from), ...s(p.to)] : s(p.slug);
}

/**
 * The checks a write-checked operation passes before it runs as a trusted local write: its source and every target page
 * readable by the member, and no label change. remember: one fact on --entity, the exact slug of a page the member reads,
 * nothing inferred and no visibility or share label (params.infer_entity is set to false).
 */
export async function checkEnforcedWrite(engine: BrainEngine, command: string, opName: string, params: Record<string, unknown>, sourceId: string | undefined): Promise<void> {
  const ea = await enforcedAccess(engine, command);
  const source = typeof params.source_id === 'string' && params.source_id ? params.source_id : sourceId ?? 'default';
  if (ea.hiddenSources.has(source)) return refuseEnforced(command, 'target_not_readable', { engine });
  if (opName === 'remember') return checkEnforcedRemember(engine, command, ea, source, params);
  if (opName === 'get_write_request') {
    if (!await ownEnforcedReceipt(params.request_id)) params.request_id = (await import('node:crypto')).randomUUID();
    return;
  }
  for (const slug of writeTargets(opName, params)) {
    if (await memberPageView(engine, ea, source, slug) === 'hidden') return refuseEnforced(command, 'target_not_readable', { engine });
  }
  const slug = String(params.slug ?? '');
  if (opName === 'put_page') {
    const content = typeof params.content === 'string' ? params.content : '';
    if (await pageLabels(await storedPage(engine, source, slug)) !== await markdownLabels(content, slug)) return refuseEnforced(command, 'label_change', { engine });
  }
  if (opName === 'add_timeline_entry' && [params.summary, params.detail, params.source].some(t => typeof t === 'string' && FENCE_MARKER_RE.test(t))) {
    return refuseEnforced(command, 'label_change', { engine });
  }
  if (opName === 'edit_page' || opName === 'append_page') {
    const texts = opName === 'append_page' ? [params.text] : (Array.isArray(params.edits) ? params.edits as Record<string, unknown>[] : []).flatMap(e => [e?.old_text, e?.new_text]);
    const stored = await storedPage(engine, source, slug);
    const hidden = stored ? await hiddenResidue(stored.compiled_truth) + await hiddenResidue(stored.timeline) : '';
    if (hidden !== '' || texts.some(t => typeof t === 'string' && LABEL_TEXT_RE.test(t))) return refuseEnforced(command, 'label_change', { engine });
  }
}

export const REMEMBER_RETRY = 'gbrain remember "<one fact>" --entity <exact slug of a page you can read, from gbrain find or gbrain search> --provenance "<where you learned it>"';

/**
 * Where a remember may save under the mode, decided here and nowhere else: one fact on --entity, the exact slug of a
 * page the member reads, nothing inferred (params.infer_entity is set to false) and no visibility or share label.
 * Anything else refuses with the retry shape. A later no-entity form would be one branch here.
 */
async function checkEnforcedRemember(engine: BrainEngine, command: string, ea: EnforcedAccess, source: string, params: Record<string, unknown>): Promise<void> {
  if (params.items !== undefined || params.visibility !== undefined || params.share !== undefined || params.replaces !== undefined) return refuseEnforced(command, 'arguments_not_allowed', { engine });
  const entity = typeof params.entity === 'string' ? params.entity.trim() : '';
  if (!entity || entity !== entity.toLowerCase() || /\s/.test(entity) || await memberPageView(engine, ea, source, entity) !== 'readable') {
    return refuseEnforced(command, 'remember_needs_entity', { engine, retry: REMEMBER_RETRY });
  }
  params.infer_entity = false;
}

const RECEIPT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RECEIPT_LEDGER_MAX = 2000;

/** The member's receipt ledger: the request ids of writes this mode accepted for it, one per line, on this machine. */
async function receiptLedgerPath(): Promise<string> {
  const [{ join }, { configDir }] = await Promise.all([import('node:path'), import('../core/config.ts')]);
  return join(configDir(), 'enforced-member', enforcedMemberLabel() + '.receipts');
}

/**
 * Records the request ids an accepted write under the mode returned (its result, or the pending receipt on its error),
 * so gbrain write-request can answer the member's own receipts and nothing else. A failed record only makes the
 * receipt answer as unknown.
 */
export async function recordEnforcedReceipts(opName: string, value: unknown, params: Record<string, unknown>): Promise<void> {
  if (opName === 'get_write_request') return;
  const ids = new Set<string>();
  const add = (v: unknown) => { if (typeof v === 'string' && RECEIPT_ID_RE.test(v.trim().toLowerCase())) ids.add(v.trim().toLowerCase()); };
  const obj = (v: unknown) => (v && typeof v === 'object' ? v as Record<string, unknown> : {});
  add(obj(value).request_id); add(obj(obj(value).write_request).request_id); add(obj(obj(value).writeRequest).request_id);
  if (ids.size) add(params.request_id);
  if (!ids.size) return;
  try {
    const fs = await import('node:fs');
    const path = await receiptLedgerPath();
    fs.mkdirSync((await import('node:path')).dirname(path), { recursive: true, mode: 0o700 });
    const kept = fs.existsSync(path) ? fs.readFileSync(path, 'utf8').split('\n').filter(Boolean).slice(-(RECEIPT_LEDGER_MAX - ids.size)) : [];
    fs.writeFileSync(path, [...kept, ...ids].join('\n') + '\n', { mode: 0o600 });
  } catch { /* unrecorded: the receipt answers as unknown */ }
}

async function ownEnforcedReceipt(id: unknown): Promise<boolean> {
  if (typeof id !== 'string' || !RECEIPT_ID_RE.test(id.trim().toLowerCase())) return false;
  try {
    const text = (await import('node:fs')).readFileSync(await receiptLedgerPath(), 'utf8');
    return text.split('\n').includes(id.trim().toLowerCase());
  } catch { return false; }
}

/**
 * Output guard (defense in depth): true when any whole string in result is the slug of a page the member cannot read
 * and no page it reads carries the same slug. The caller then withholds the whole output. Pages are judged under the
 * record the read ran under (a read-only operation with the enforced overrides), so a derived page the member reads
 * through access.members_read_lineage is not withheld; when that record cannot be built, the output is withheld.
 */
export async function namesHiddenPage(engine: BrainEngine, command: string, result: unknown): Promise<boolean> {
  const strings = new Set<string>();
  const walk = (v: unknown, depth: number): void => {
    if (depth > 12 || strings.size > 5000) return;
    if (typeof v === 'string') { if (v.length > 0 && v.length <= 255 && !/\s/.test(v)) strings.add(v.toLowerCase()); return; }
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    if (v && typeof v === 'object') for (const x of Object.values(v as Record<string, unknown>)) walk(x, depth + 1);
  };
  walk(result, 0);
  if (!strings.size) return false;
  const ea = await enforcedAccess(engine, command);
  const [{ withCallerAccess, callerAccessAllowedSql, privacyPartSql }, { remoteCallerAccess }] = await Promise.all([
    import('../core/search/private-visibility.ts'), import('../core/access/caller.ts')]);
  const read = await remoteCallerAccess(engine, undefined, [], 'stdio', null, ea.member, true).catch(() => null);
  if (!read) return true;
  const policy = withCallerAccess({ ...read, hidePrivate: true, owner: false, privateReadableSources: [] }, () => '(' + callerAccessAllowedSql('p') + ' AND ' + privacyPartSql('p') + ')');
  const hidden = ea.hiddenSources.size ? '(NOT (' + policy + ') OR p.source_id = ANY($2::text[]))' : 'NOT (' + policy + ')';
  const rows = await engine.executeRaw<{ slug: string; hidden: boolean }>('SELECT p.slug, ' + hidden + ' AS hidden FROM pages p WHERE p.slug = ANY($1::text[])',
    ea.hiddenSources.size ? [[...strings], [...ea.hiddenSources]] : [[...strings]]);
  const visible = new Set(rows.filter(r => !r.hidden).map(r => r.slug));
  return rows.some(r => r.hidden && !visible.has(r.slug));
}

export const WITHHELD_LINE = (command: string) => 'gbrain: ' + commandLabel(command) + ' finished; its output is withheld under ' + ENFORCED_MEMBER_ENV + '\n';

/**
 * Runs an allowed operation (sync, sources refresh, git commit-push) with stdout and stderr withheld: it prints one
 * constant line, plus the bare error code (never a path or slug) on failure, and keeps the exit code.
 */
async function captureOutput(run: () => Promise<void>): Promise<{ stdout: string; all: string; exit: number }> {
  const { currentExitCode, setCliExitVerdict, setStdoutCapture } = await import('../core/cli-force-exit.ts');
  const all: string[] = [];
  const stdout: string[] = [];
  const stdoutWrite = process.stdout.write;
  const stderrWrite = process.stderr.write;
  const consoleFns = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  const swallow = (toStdout: boolean) => ((chunk: unknown, ...rest: unknown[]) => {
    const text = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    all.push(text);
    if (toStdout) stdout.push(text);
    const cb = rest.find(r => typeof r === 'function') as (() => void) | undefined;
    if (cb) cb();
    return true;
  }) as typeof process.stdout.write;
  const swallowConsole = (toStdout: boolean) => (...args: unknown[]) => {
    const text = args.map(String).join(' ') + '\n';
    all.push(text);
    if (toStdout) stdout.push(text);
  };
  setStdoutCapture(text => { all.push(text); stdout.push(text); });
  process.stdout.write = swallow(true);
  process.stderr.write = swallow(false);
  console.log = console.info = swallowConsole(true);
  console.warn = console.error = console.debug = swallowConsole(false);
  let failed = false;
  try {
    await run();
  } catch (e) {
    failed = true;
    const code = (e as { code?: unknown })?.code;
    if (typeof code === 'string') all.push('Error [' + code + ']');
  } finally {
    setStdoutCapture(null);
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
    Object.assign(console, consoleFns);
  }
  const exit = failed && currentExitCode() === 0 ? 1 : currentExitCode();
  if (failed) setCliExitVerdict(exit);
  return { stdout: stdout.join(''), all: all.join(''), exit };
}

function withheldFailureLine(command: string, text: string, exit: number): string {
  const code = /Error \[([a-z0-9_]+)\]/.exec(text)?.[1] ?? /"code"\s*:\s*"([a-z0-9_]+)"/.exec(text)?.[1];
  return 'gbrain: ' + commandLabel(command) + ' failed' + (code ? ' [' + code + ']' : '') + ' (exit ' + exit + '); its output is withheld under ' + ENFORCED_MEMBER_ENV + '\n';
}

export async function withWithheldOutput(command: string, run: () => Promise<void>): Promise<void> {
  const out = await captureOutput(run);
  process.stderr.write(out.exit === 0 ? WITHHELD_LINE(command) : withheldFailureLine(command, out.all, out.exit));
}

export const DOCTOR_COUNTS_LINE = 'gbrain: doctor shows check names, statuses and counts only under ' + ENFORCED_MEMBER_ENV + '\n';

/**
 * doctor under the mode: runs doctor --json with its output captured and prints only each check's name and status and
 * the count per status (no message, detail, fix, slug, path, title or source name). A name or status outside
 * [a-z0-9_] prints as "other". Keeps doctor's exit code.
 */
export async function withDoctorCounts(json: boolean, run: () => Promise<void>): Promise<void> {
  const out = await captureOutput(run);
  let report: Record<string, unknown> = {};
  try { report = JSON.parse(out.stdout.slice(out.stdout.indexOf('{'), out.stdout.lastIndexOf('}') + 1)) as Record<string, unknown>; } catch { /* no report */ }
  const checks = Array.isArray(report.checks) ? report.checks as Record<string, unknown>[] : [];
  if (!checks.length) {
    const { setCliExitVerdict } = await import('../core/cli-force-exit.ts');
    const exit = out.exit === 0 ? 1 : out.exit;
    setCliExitVerdict(exit);
    process.stderr.write(withheldFailureLine('doctor', out.all, exit));
    return;
  }
  const safe = (v: unknown) => (typeof v === 'string' && /^[a-z0-9_]{1,64}$/.test(v) ? v : 'other');
  const rows = checks.map(c => ({ name: safe(c.name), status: safe(c.status) }));
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
  const summary = { status: safe(report.status), checks: rows, counts };
  await (await import('../core/cli-force-exit.ts')).writeStdoutFinal(json ? JSON.stringify(summary, null, 2) + '\n'
    : rows.map(r => r.status + ' ' + r.name).join('\n') + '\n' + Object.entries(counts).map(([k, v]) => k + ': ' + v).join(', ') + '\n');
  process.stderr.write(DOCTOR_COUNTS_LINE);
}
