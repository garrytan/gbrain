/**
 * GBRA-218 (PR A2): `gbrain access rule|apply|resume`, the operator surface for folder rules.
 *
 *   gbrain access rule add --prefix <folder/> --readers a,group:b [--id <rule>] [--source <id>] [--yes] [--expect <rev>] [--operation <id>]
 *   gbrain access rule rm <rule> [--source <id>] [--yes] [--expect <rev>] [--operation <id>]
 *   gbrain access rule list|status|history [--source <id>] [--operation <id>] [--limit <n>]
 *   gbrain access rule revert --to <revision> [--source <id>] [--yes]
 *   gbrain access rule export [--source <id>] [--approved]
 *   gbrain access rule import --file <access.yml> [--source <id>] [--yes]
 *   gbrain access rule migrate [--source <id>] [--yes]
 *   gbrain access apply [--source <id>] [--revision <n>] [--yes --expect <plan_hash>]
 *   gbrain access resume [--source <id>]
 *
 * The source's persisted store decides where an edit lands: the database
 * revision log (repo-less sources, the default keyless install) or
 * `.gbrain/access.yml` committed through the git door (git-backed sources). Every
 * edit previews first; narrowing applies at once, widening waits for
 * `gbrain access apply`. Trusted local CLI only.
 */
import { readFileSync } from 'node:fs';
import type { BrainEngine } from '../core/engine.ts';
import { usageError } from '../cli/cli-error.ts';
import { opError } from '../core/ops/contract.ts';
import { classifyRulebook, folderRulesAllow, normalizeRule, parsePolicyYaml, serializePolicyYaml, sortRules, type FolderRule, type RuleChange } from '../core/access/folder-rules.ts';
import { identityFor } from '../core/access/principals.ts';
import { boundCredentials, listGroups, listMembers } from '../core/access/members.ts';
import {
  appliedRules, applyApproved, getRevision, listRevisions, newOperationId, policyStatus, previewApply, proposeRevision, readAccessStore, resumePolicy,
  writeAccessStore, ensurePolicyState, type AccessStore, type ProposalResult, type RestampProgress,
} from '../core/access/policy.ts';
import {
  APPROVED_FILE, isGitWorkTree, POLICY_FILE, sourcePolicyRoot, syncGitPolicy, workingTreeRules, writeApprovedFile, writeGitRules, type GitPolicyReceipt,
} from '../core/access/policy-git.ts';

const VALUE_FLAGS = new Set(['--source', '--prefix', '--readers', '--id', '--expect', '--operation', '--to', '--revision', '--file', '--limit']);

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return args.find(a => a.startsWith(`${name}=`))?.slice(name.length + 1);
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) throw usageError(`${name} requires a value.`, `Put the value right after the flag, as in ${name} VALUE.`);
  return v;
}

function positionals(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (VALUE_FLAGS.has(args[i]!)) { i++; continue; }
    if (!args[i]!.startsWith('--')) out.push(args[i]!);
  }
  return out;
}

function intFlag(args: string[], name: string): number | undefined {
  const raw = flag(args, name);
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) throw usageError(`${name} takes a whole number.`, `For example ${name} 3.`);
  return Number(raw);
}

function print(json: boolean, value: unknown, human: () => string[]): void {
  console.log(json ? JSON.stringify(value, null, 2) : human().join('\n'));
}

function progressLogger(json: boolean): (p: RestampProgress) => void {
  let last = 0;
  return p => {
    if (Date.now() - last < 1000) return;
    last = Date.now();
    process.stderr.write(`[access] restamping: ${p.pages_scanned} pages scanned, ${p.pages_restamped} restamped` + '\n');
    void json;
  };
}

const reader = (p: string) => (p.startsWith('member:') ? p.slice(7) : p);
const ruleLine = (r: FolderRule) => `  ${r.id}  ${r.prefix}  readable by ${r.readable_by.map(reader).join(', ') || 'nobody'}`;

function changeLine(c: RuleChange): string {
  const what = c.kind === 'added' ? 'add rule' : c.kind === 'removed' ? 'remove rule' : c.kind === 'prefix_moved' ? `move rule to ${c.prefix}` : c.kind === 'prefix_released' ? 'release the old prefix of moved rule'
    : c.kind === 'readers_removed' ? `remove readers ${(c.readers ?? []).map(reader).join(', ')} from` : `add readers ${(c.readers ?? []).map(reader).join(', ')} to`;
  return `  ${what} ${c.rule} (${c.prefix}): ${c.narrowing ? 'narrowing, applies at once' : 'widening, held until gbrain access apply'}`;
}

/** The store an edit lands in: the persisted one, else git when the source root is a git work tree, else the database. */
async function resolveStore(engine: BrainEngine, sourceId: string): Promise<{ store: AccessStore; persisted: boolean; root: string | null }> {
  const persisted = await readAccessStore(engine, sourceId);
  const root = await sourcePolicyRoot(engine, sourceId);
  const gitRoot = root && isGitWorkTree(root) ? root : null;
  if (persisted === 'git' && !gitRoot) {
    throw opError('access_policy_store_mismatch', `Source ${sourceId} keeps its folder rules in git, but this host sees no git work tree at its root (${root ?? 'no local path'}); nothing was written.`,
      `Run gbrain access rule migrate --source ${sourceId} to move the rules into the database (preview first), or run this on the host that holds the checkout.`,
      { fix: { argv: ['gbrain', 'access', 'rule', 'migrate', '--source', sourceId], consent: [], actor: 'user', requires_exclusive: false, why: 'Previews moving the applied rulebook into the database store; writes nothing without --yes.',
        verify: { argv: ['gbrain', 'access', 'rule', 'status', '--source', sourceId, '--json'] } } });
  }
  if (persisted) return { store: persisted, persisted: true, root: gitRoot };
  return { store: gitRoot ? 'git' : 'database', persisted: false, root: gitRoot };
}

/** The desired rulebook an edit starts from: the working tree's access.yml on git, the latest revision (else the applied rules) on the database. */
async function baseRules(engine: BrainEngine, sourceId: string, store: AccessStore, root: string | null): Promise<FolderRule[]> {
  if (store === 'git') return workingTreeRules(root!, sourceId);
  return (await getRevision(engine, sourceId))?.rules ?? await appliedRules(engine, sourceId);
}

export interface RulePreview {
  source_id: string;
  store: AccessStore;
  store_persisted: boolean;
  expect: number;
  desired: FolderRule[];
  changes: RuleChange[];
  held: RuleChange[];
  matched_pages: Record<string, number>;
  unknown_readers: string[];
  members_losing: string[];
  credentials_losing: Array<{ member: string; kind: string; name: string }>;
}

async function previewRules(engine: BrainEngine, sourceId: string, store: AccessStore, persisted: boolean, desired: FolderRule[]): Promise<RulePreview> {
  const current = await appliedRules(engine, sourceId);
  const cls = classifyRulebook(current, desired);
  const expect = (await getRevision(engine, sourceId))?.revision ?? 0;
  const prefixes = [...new Set(cls.changes.map(c => c.prefix).concat(cls.changes.map(c => current.find(r => r.id === c.rule)?.prefix ?? c.prefix)))];
  const matched: Record<string, number> = {};
  for (const prefix of prefixes) {
    const [row] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages WHERE source_id = $1 AND deleted_at IS NULL AND starts_with(slug, $2)', [sourceId, prefix]);
    matched[prefix] = Number(row?.n ?? 0);
  }
  const members = await listMembers(engine, { includeRemoved: true });
  const groups = new Set((await listGroups(engine)).map(g => g.id));
  const known = (p: string) => p.startsWith('group:') ? groups.has(p.slice(6)) : members.some(m => m.id === p.slice(7) && m.status !== 'removed');
  const unknown = [...new Set(desired.flatMap(r => r.readable_by))].filter(p => !known(p)).map(reader).sort();
  const slugs = prefixes.length ? (await engine.executeRaw<{ slug: string }>(
    'SELECT slug FROM pages WHERE source_id = $1 AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM unnest($2::text[]) AS pfx WHERE starts_with(slug, pfx))', [sourceId, prefixes])).map(r => r.slug) : [];
  const losing: string[] = [];
  for (const m of members.filter(x => x.status === 'enabled')) {
    const identity = identityFor(m.id, m.groups);
    if (slugs.some(s => folderRulesAllow(s, current, identity) && !folderRulesAllow(s, cls.target, identity))) losing.push(m.id);
  }
  const credentials: RulePreview['credentials_losing'] = [];
  for (const m of losing) for (const c of await boundCredentials(engine, m)) credentials.push({ member: m, kind: c.kind, name: c.name });
  return { source_id: sourceId, store, store_persisted: persisted, expect, desired, changes: cls.changes, held: cls.held, matched_pages: matched,
    unknown_readers: unknown, members_losing: losing, credentials_losing: credentials };
}

function previewLines(p: RulePreview, rerun: string): string[] {
  return [
    `Source ${p.source_id} (${p.store} store${p.store_persisted ? '' : ', chosen now: set with the first rule'}), desired revision ${p.expect}`,
    ...(p.changes.length ? p.changes.map(changeLine) : ['  no change']),
    ...Object.entries(p.matched_pages).map(([prefix, n]) => `  ${prefix}: ${n} page(s) match`),
    ...(p.unknown_readers.length ? [`  Unknown readers (no such member or group; they match nobody): ${p.unknown_readers.join(', ')}`] : []),
    ...(p.members_losing.length ? [`  Members losing access: ${p.members_losing.join(', ')}`] : []),
    ...(p.credentials_losing.length ? [`  Credentials losing access: ${p.credentials_losing.map(c => `${c.kind} ${c.name} (${c.member})`).join(', ')}`] : []),
    'Pages under no rule are unchanged; unbound credentials and stdio read no page under a rule.',
    `Nothing written. To approve, add --yes --expect ${p.expect} (${rerun}).`,
  ];
}

interface EditResult {
  source_id: string;
  store: AccessStore;
  operation_id: string;
  applied: boolean;
  state: ProposalResult['state'] | 'invalid';
  revision: number | null;
  change_kind: string;
  changes: RuleChange[];
  held: RuleChange[];
  pages_restamped: number;
  git?: GitPolicyReceipt;
  note?: string;
}

/** Writes a desired rulebook through the source's store (after the caller's preview) and reports the result. */
async function writeRules(engine: BrainEngine, sourceId: string, desired: FolderRule[], opts: { expect?: number; operation?: string; message: string; json: boolean }): Promise<EditResult> {
  const { store, root } = await resolveStore(engine, sourceId);
  const operationId = opts.operation ?? newOperationId();
  if (!opts.json) process.stderr.write(`[access] operation ${operationId} (if this reply is lost: gbrain access rule status --source ${sourceId} --operation ${operationId})` + '\n');
  if (store === 'database') {
    const r = await proposeRevision(engine, sourceId, desired, { origin: 'cli', operationId, expectDesired: opts.expect, store: 'database', onProgress: progressLogger(opts.json) });
    return { source_id: sourceId, store, operation_id: operationId, applied: r.state === 'applied' || r.state === 'unchanged', state: r.state, revision: r.revision,
      change_kind: r.change_kind, changes: r.changes, held: r.held, pages_restamped: r.pages_restamped, ...(r.reconciled ? { note: 'This operation was already recorded; nothing new was written.' } : {}) };
  }
  if (opts.expect !== undefined) {
    const latest = (await getRevision(engine, sourceId))?.revision ?? 0;
    if (latest !== opts.expect) throw opError('preview_changed', `Source ${sourceId}'s folder rules changed since the preview (previewed revision ${opts.expect}, now ${latest}); nothing was written.`, 'Preview again and rerun with the new --expect value.');
  }
  await ensurePolicyState(engine, sourceId);
  if (!(await readAccessStore(engine, sourceId))) await writeAccessStore(engine, sourceId, 'git');
  const { receipt, sync } = await writeGitRules(engine, sourceId, root!, desired, opts.message, progressLogger(opts.json));
  const p = sync.proposal;
  return { source_id: sourceId, store, operation_id: operationId, applied: sync.state === 'applied' || sync.state === 'unchanged', state: sync.state === 'skipped' ? 'unchanged' : sync.state,
    revision: p?.revision ?? null, change_kind: p?.change_kind ?? 'unchanged', changes: p?.changes ?? [], held: p?.held ?? [], pages_restamped: p?.pages_restamped ?? 0, git: receipt,
    ...(receipt.note ? { note: receipt.note } : {}) };
}

function editLines(r: EditResult): string[] {
  return [
    `Source ${r.source_id} (${r.store} store): revision ${r.revision ?? '-'} ${r.state}`,
    ...r.changes.map(changeLine),
    ...(r.git ? [`  ${r.git.path} committed ${r.git.commit?.slice(0, 12) ?? '(nothing to commit)'} (${r.git.outcome})`] : []),
    ...(r.pages_restamped ? [`  ${r.pages_restamped} page(s) restamped`] : []),
    ...(r.held.length ? [`Held: preview with gbrain access apply --source ${r.source_id}`] : []),
    ...(r.state === 'pending' ? [`Still pending: finish with gbrain access resume --source ${r.source_id}`] : []),
    ...(r.note ? [r.note] : []),
  ];
}

async function ruleCmd(engine: BrainEngine, sub: string | undefined, args: string[], json: boolean): Promise<void> {
  const sourceId = flag(args, '--source') ?? 'default';
  const yes = args.includes('--yes');
  const expect = intFlag(args, '--expect');
  const operation = flag(args, '--operation');
  switch (sub) {
    case 'add':
    case 'rm':
    case 'revert':
    case 'import': {
      const { store, persisted, root } = await resolveStore(engine, sourceId);
      const base = await baseRules(engine, sourceId, store, root);
      let desired: FolderRule[];
      let message: string;
      if (sub === 'add') {
        const readers = flag(args, '--readers');
        const r = normalizeRule({ prefix: flag(args, '--prefix'), readable_by: readers === undefined ? undefined : readers.split(',').map(s => s.trim()).filter(Boolean), ...(flag(args, '--id') ? { id: flag(args, '--id') } : {}) });
        if ('problem' in r) {
          throw opError('access_rule_invalid', `The rule is invalid: ${r.problem}.`, 'Nothing was written. Example: gbrain access rule add --prefix partners/alice-example/ --readers alice-example,group:team-a');
        }
        const clash = base.find(b => b.prefix === r.rule.prefix && b.id !== r.rule.id);
        if (clash) throw opError('access_rule_invalid', `Rule "${clash.id}" already covers ${r.rule.prefix}.`, `Nothing was written. Change that rule's readers instead: gbrain access rule add --id ${clash.id} --prefix ${r.rule.prefix} --readers <list>.`);
        desired = sortRules([...base.filter(b => b.id !== r.rule.id), r.rule]);
        message = `access: rule ${r.rule.id} on ${r.rule.prefix} readable by ${r.rule.readable_by.map(reader).join(', ')}`;
      } else if (sub === 'rm') {
        const id = positionals(args)[0];
        if (!id) throw usageError('rule rm needs a rule id.', 'gbrain access rule rm <rule> --source <id> (gbrain access rule list shows the ids)');
        if (!base.some(b => b.id === id)) throw opError('not_found', `Source ${sourceId} has no rule "${id}".`, `List rules with gbrain access rule list --source ${sourceId}.`);
        desired = base.filter(b => b.id !== id);
        message = `access: remove rule ${id}`;
      } else if (sub === 'revert') {
        const to = intFlag(args, '--to');
        if (to === undefined) throw usageError('rule revert needs --to <revision>.', `gbrain access rule history --source ${sourceId} lists revisions.`);
        const rev = await getRevision(engine, sourceId, to);
        if (!rev) throw opError('not_found', `Source ${sourceId} has no folder-rule revision ${to}.`, `List revisions with gbrain access rule history --source ${sourceId}.`);
        desired = rev.rules;
        message = `access: revert folder rules to revision ${to}`;
      } else {
        const file = flag(args, '--file');
        if (!file) throw usageError('rule import needs --file <access.yml>.', 'gbrain access rule import --file access.yml --source <id>');
        const parsed = parsePolicyYaml(readFileSync(file, 'utf8'));
        if (!parsed.ok) throw opError('access_policy_invalid', `${file} does not validate: ${parsed.problems.map(p => `${p.line ? `line ${p.line}: ` : ''}${p.message}`).join('; ')}.`, 'Nothing was written. Fix the file and run the import again.');
        desired = parsed.rules;
        message = `access: import folder rules`;
      }
      const preview = await previewRules(engine, sourceId, store, persisted, desired);
      if (!yes) {
        return print(json, { ...preview, applied: false }, () => previewLines(preview, `gbrain access rule ${[sub, ...args.filter(a => a !== '--json')].join(' ')} --yes`));
      }
      const r = await writeRules(engine, sourceId, desired, { expect, operation, message, json });
      return print(json, r, () => editLines(r));
    }
    case 'list':
    case 'status': {
      const s = await policyStatus(engine, sourceId, operation);
      const { root } = await resolveStore(engine, sourceId).catch(() => ({ root: null }));
      const mismatch = s.store === 'database' && !!root ? 'This source now has a git work tree but keeps its rules in the database; gbrain access rule migrate moves them into .gbrain/access.yml.' : undefined;
      return print(json, { ...s, ...(mismatch ? { store_mismatch: mismatch } : {}) }, () => [
        `Source ${sourceId}: ${s.store ?? 'no folder rules yet'}${s.store === 'git' ? ` (${POLICY_FILE})` : s.store === 'database' ? ' (revision log)' : ''}`,
        `  Revisions: desired ${s.desired?.revision ?? '-'}, applied ${s.applied_revision ?? '-'}, approved ${s.approved_revision ?? '-'}`,
        ...(s.rules.length ? ['Applied rules:', ...s.rules.map(ruleLine)] : ['  No applied rule: no folder restricts reads.']),
        ...(s.held.length ? ['Held widening (gbrain access apply previews it):', ...s.held.map(changeLine)] : []),
        ...(s.pending.length ? [`Pending (reads as nobody until stamped; gbrain access resume --source ${sourceId}): ${s.pending.map(c => c.prefix || '(whole source)').join(', ')}`] : []),
        ...s.invalid.flatMap(c => {
          const detail = c.detail as { problems?: Array<{ line: number | null; message: string }>; commit?: string } | null;
          return [`Invalid policy file${detail?.commit ? ` at ${detail.commit}` : ''} (reads as nobody: ${c.prefix || 'the whole source'}):`,
            ...(detail?.problems ?? []).map(p => `  ${p.line ? `line ${p.line}: ` : ''}${p.message}`)];
        }),
        ...(s.operation ? [`Operation ${s.operation.operation_id}: ${s.operation.state}${s.operation.revision ? ` (revision ${s.operation.revision})` : ''}`] : []),
        ...(mismatch ? [mismatch] : []),
      ]);
    }
    case 'history': {
      const revisions = await listRevisions(engine, sourceId, intFlag(args, '--limit') ?? 50);
      return print(json, { source_id: sourceId, revisions }, () => revisions.length ? revisions.map(r =>
        `  ${r.revision}  ${r.created_at}  ${r.change_kind}  ${r.origin}  by ${r.proposed_by ?? '?'}${r.approved_at ? `  approved by ${r.approved_by}` : '  held'}${r.applied_at ? '' : '  (not yet applied)'}  ${r.rules.length} rule(s)`)
        : ['No folder-rule revisions.']);
    }
    case 'export': {
      const s = await policyStatus(engine, sourceId);
      const rules = args.includes('--approved') ? (await listRevisions(engine, sourceId, 500)).find(r => r.approved_at)?.rules ?? s.rules : s.desired?.rules ?? s.rules;
      if (json) return print(true, { source_id: sourceId, rules }, () => []);
      console.log(serializePolicyYaml(rules).trimEnd());
      return;
    }
    case 'migrate':
      return migrateCmd(engine, sourceId, yes, json);
    default:
      throw usageError(`Unknown access rule subcommand: ${sub ?? '(none)'}.`, 'Use add, rm, list, status, history, revert, export, import or migrate (gbrain access --help).');
  }
}

async function migrateCmd(engine: BrainEngine, sourceId: string, yes: boolean, json: boolean): Promise<void> {
  const { migrateAccessStore, previewMigrate } = await import('../core/access/policy-migrate.ts');
  if (!yes) {
    const p = await previewMigrate(engine, sourceId);
    return print(json, { ...p, applied: false }, () => [
      `Source ${sourceId}: move folder rules from the ${p.from ?? 'unset'} store to the ${p.to} store`,
      ...(p.to === 'git' ? [`  Writes ${POLICY_FILE} (desired, ${p.desired.length} rule(s)) and ${APPROVED_FILE} (approved, ${p.approved.length} rule(s)) under ${p.root} and commits them through gbrain git commit-push.`]
        : ['  The applied rulebook, pending coverage and held widenings stay in the database, which becomes the record.']),
      '  The applied rules stay in force throughout; no rule is missing at any point.',
      ...(p.resume ? [`  Resumes migration ${p.resume.id} (phase ${p.resume.phase}).`] : []),
      'Nothing written. To apply, add --yes.',
    ]);
  }
  const r = await migrateAccessStore(engine, sourceId);
  return print(json, r, () => [`Source ${sourceId}: folder rules now in the ${r.to} store (migration ${r.id}, phase ${r.phase})`,
    ...Object.entries(r.receipts).map(([k, v]) => `  ${k}: ${typeof v === 'object' && v ? (v as { commit?: string }).commit ?? JSON.stringify(v) : String(v)}`)]);
}

async function applyCmd(engine: BrainEngine, args: string[], json: boolean): Promise<void> {
  const sourceId = flag(args, '--source') ?? 'default';
  const revision = intFlag(args, '--revision');
  if (!args.includes('--yes')) {
    const p = await previewApply(engine, sourceId, revision);
    return print(json, { ...p, applied: false }, () => [
      `Source ${sourceId}: ${p.desired ? `desired revision ${p.desired.revision} (${p.desired.origin}, by ${p.desired.proposed_by ?? '?'}, ${p.desired.created_at})` : 'no folder-rule revision'}`,
      ...(p.proposals.length ? [`  Proposals not yet approved: ${p.proposals.map(x => `${x.revision} (${x.change_kind})`).join(', ')}`] : []),
      ...(p.widening.length ? p.widening.flatMap(w => [changeLine(w.change),
        `    ${w.pages} page(s) gain readers${w.sample.length ? `: ${w.sample.slice(0, 5).join(', ')}${w.pages > 5 ? ', ...' : ''}` : ''}`,
        `    Gaining access: ${w.gains === 'every_source_reader' ? 'every caller entitled to the source, unbound credentials included' : w.gains.join(', ') || 'no enabled member'}`])
        : ['  Nothing is held: the applied rules already match.']),
      ...(p.plan_hash ? [`Nothing written; approve with gbrain access apply --source ${sourceId}${revision ? ` --revision ${revision}` : ''} --yes --expect ${p.plan_hash}`] : []),
    ]);
  }
  const expect = flag(args, '--expect');
  if (!expect) throw usageError('access apply --yes needs --expect <plan_hash> from the preview.', `Preview first: gbrain access apply --source ${sourceId}`);
  const r = await applyApproved(engine, sourceId, { revision, expect, onProgress: progressLogger(json) });
  let git: GitPolicyReceipt | undefined;
  if ((await readAccessStore(engine, sourceId)) === 'git') {
    const root = await sourcePolicyRoot(engine, sourceId);
    const approved = (await getRevision(engine, sourceId, r.revision ?? undefined))?.rules ?? [];
    if (!root || !isGitWorkTree(root)) {
      throw opError('access_policy_store_mismatch', `The widening is applied in the database, but ${APPROVED_FILE} could not be committed: this host sees no git work tree for source ${sourceId}.`,
        `Run gbrain access apply --source ${sourceId} on the host that holds the checkout, or gbrain access rule migrate --source ${sourceId} to keep the rules in the database.`);
    }
    git = await writeApprovedFile(root, approved, `access: approve folder rules revision ${r.revision}`);
    await syncGitPolicy(engine, sourceId, root);
  }
  return print(json, { ...r, ...(git ? { git } : {}) }, () => [`Source ${sourceId}: revision ${r.revision} approved and applied (${r.pages_restamped} page(s) restamped)`,
    ...(git ? [`  ${git.path} committed ${git.commit?.slice(0, 12) ?? '(unchanged)'} (${git.outcome})`] : []),
    ...(r.held.length ? [`A later revision still holds ${r.held.length} widening change(s); preview with gbrain access apply --source ${sourceId}`] : [])]);
}

/** Dispatches `gbrain access rule|apply|resume`; false when `cmd` is not one of them. */
export async function runAccessRules(engine: BrainEngine, cmd: string, rest: string[], json: boolean): Promise<boolean> {
  switch (cmd) {
    case 'rule': await ruleCmd(engine, rest[0], rest.slice(1), json); return true;
    case 'apply': await applyCmd(engine, rest, json); return true;
    case 'resume': {
      const sourceId = flag(rest, '--source') ?? 'default';
      const r = await resumePolicy(engine, sourceId, progressLogger(json));
      print(json, { source_id: sourceId, ...r }, () => [`Source ${sourceId}: ${r.pages_restamped} page(s) restamped${r.pending_before.length ? `; pending prefixes cleared: ${r.pending_before.map(p => p || '(whole source)').join(', ')}` : '; nothing was pending'}`]);
      return true;
    }
    default: return false;
  }
}
