/**
 * GBRA-218 (A2) folder-rule doctor checks. Each reads the policy tables once,
 * names the source, and fixes with a read-only, preview-first or
 * narrowing-only command whose `verify` is the check itself.
 *
 *  - access_policy_pending: prefixes still reading as nobody because a
 *    narrowing was not finished, or pages whose stamp drifted from the
 *    applied rulebook; `gbrain access resume` restamps toward the applied rules.
 *  - access_policy_widening_held: a desired revision widens the applied rules
 *    and waits for `gbrain access apply` (preview, then the user's approval).
 *  - access_policy_invalid: a committed policy file that does not validate;
 *    the prefixes it names read as nobody.
 *  - access_policy_store_mismatch: the persisted store disagrees with this
 *    host's filesystem (a git store without a visible work tree, a database
 *    store whose root became a repository); `gbrain access rule migrate`.
 *
 * Not applicable on a brain where no source has ever had a folder rule.
 */
import type { Check } from '../../doctor.ts';
import type { BrainEngine } from '../../../core/engine.ts';
import { agentFix, checkError, doctorVerify, infoCheck } from '../check-fix.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { classifyRulebook } from '../../../core/access/folder-rules.ts';
import { appliedRules, coverageRows, getRevision, readAccessStore } from '../../../core/access/policy.ts';
import { isGitWorkTree, sourcePolicyRoot } from '../../../core/access/policy-git.ts';

const DOCS = 'docs/guides/write-refusals.md#access_policy_pending';

async function policySources(engine: BrainEngine): Promise<string[]> {
  return (await engine.executeRaw<{ source_id: string }>('SELECT source_id FROM access_policy_state ORDER BY source_id')).map(r => r.source_id);
}

async function pending(engine: BrainEngine, sources: string[]): Promise<Check> {
  const name = 'access_policy_pending';
  const found: Array<{ source: string; prefixes: string[]; drifted: number }> = [];
  for (const source of sources) {
    const prefixes = (await coverageRows(engine, source)).filter(c => c.reason === 'pending').map(c => c.prefix || '(whole source)');
    const [row] = await engine.executeRaw<{ n: number }>(
      'SELECT count(*)::int AS n FROM pages WHERE source_id = $1 AND folder_rule_ids IS DISTINCT FROM gbrain_access_folder_rules(source_id, slug)', [source]);
    if (prefixes.length || row?.n) found.push({ source, prefixes, drifted: Number(row?.n ?? 0) });
  }
  if (!found.length) return { name, status: 'ok', details: { sources: [] }, message: 'Every folder rule is fully applied: no prefix is pending and every page is stamped from the applied rules.' };
  const first = found[0]!;
  return { name, status: 'warn', details: { sources: found },
    message: `Folder rules are not fully applied in ${found.map(f => `${f.source} (${f.prefixes.length ? `pending: ${f.prefixes.join(', ')}` : ''}${f.prefixes.length && f.drifted ? '; ' : ''}${f.drifted ? `${f.drifted} page(s) stamped from other rules` : ''})`).join('; ')}. `
      + 'Pending prefixes read as nobody for remote callers until the apply finishes; resume restamps toward the applied rules and never widens.',
    fix: agentFix(['gbrain', 'access', 'resume', '--source', first.source], 'Restamps pages toward the applied folder rules and clears the pending prefixes; narrowing only, idempotent.', name, { docs: DOCS }) };
}

async function held(engine: BrainEngine, sources: string[]): Promise<Check> {
  const name = 'access_policy_widening_held';
  const found: Array<{ source: string; revision: number; proposed_by: string | null; at: string; changes: string[] }> = [];
  for (const source of sources) {
    const desired = await getRevision(engine, source);
    if (!desired) continue;
    const h = classifyRulebook(await appliedRules(engine, source), desired.rules).held;
    if (h.length) found.push({ source, revision: desired.revision, proposed_by: desired.proposed_by, at: desired.created_at, changes: h.map(c => `${c.kind} ${c.rule} (${c.prefix})`) });
  }
  if (!found.length) return { name, status: 'ok', details: { sources: [] }, message: 'No folder-rule widening is waiting for approval.' };
  const first = found[0]!;
  return { name, status: 'warn', details: { sources: found },
    message: `Widening changes to folder rules are held: ${found.map(f => `${f.source} revision ${f.revision} by ${f.proposed_by ?? 'an unrecorded actor'} at ${f.at}: ${f.changes.join(', ')}`).join('; ')}. `
      + 'The previous rules stay in force until the user approves the previewed plan.',
    fix: agentFix(['gbrain', 'access', 'apply', '--source', first.source, '--json'], 'Previews the pages and members that would gain access and prints the plan hash an approval binds; changes nothing. Ask the user before approving.', name,
      { ask_user: true, docs: 'docs/guides/error-codes.md#access_policy_widening_held' }) };
}

async function invalid(engine: BrainEngine, sources: string[]): Promise<Check> {
  const name = 'access_policy_invalid';
  const found: Array<{ source: string; prefixes: string[]; problems: unknown }> = [];
  for (const source of sources) {
    const rows = (await coverageRows(engine, source)).filter(c => c.reason === 'invalid');
    if (rows.length) found.push({ source, prefixes: rows.map(r => r.prefix || '(whole source)'), problems: (rows[0]!.detail as { problems?: unknown } | null)?.problems ?? null });
  }
  if (!found.length) return { name, status: 'ok', details: { sources: [] }, message: 'Every committed folder-rule file validates.' };
  const first = found[0]!;
  return { name, status: 'fail', details: { sources: found },
    message: `The folder-rule file of ${found.map(f => `${f.source} does not validate (reads as nobody: ${f.prefixes.join(', ')})`).join('; ')}. The last applied rules stay in force. Fix .gbrain/access.yml, commit it and sync the source.`,
    fix: { ...agentFix(['gbrain', 'access', 'rule', 'list', '--source', first.source, '--json'], 'Lists each problem in the file with its line, read-only. Fix the file and commit it with gbrain git commit-push; then run gbrain sync --source <id> --no-pull.', name,
      { docs: 'docs/guides/write-refusals.md#access_policy_invalid' }), verify: doctorVerify(name) } };
}

async function storeMismatch(engine: BrainEngine, sources: string[]): Promise<Check> {
  const name = 'access_policy_store_mismatch';
  const found: Array<{ source: string; store: string; root: string | null; git: boolean }> = [];
  for (const source of sources) {
    const store = await readAccessStore(engine, source);
    if (!store) continue;
    const root = await sourcePolicyRoot(engine, source);
    const git = !!root && isGitWorkTree(root);
    if ((store === 'git') !== git) found.push({ source, store, root, git });
  }
  if (!found.length) return { name, status: 'ok', details: { sources: [] }, message: 'Every source keeps its folder rules in the store its filesystem matches.' };
  const first = found[0]!;
  return { name, status: 'warn', details: { sources: found },
    message: `${found.map(f => f.store === 'git' ? `${f.source} keeps its folder rules in git, but this host sees no git work tree at ${f.root ?? 'its root'}` : `${f.source} keeps its folder rules in the database, but its root is now a git work tree`).join('; ')}. `
      + 'The persisted store and its applied rules stay in force; only gbrain access rule migrate moves them, and neither direction widens.',
    fix: { argv: ['gbrain', 'access', 'rule', 'migrate', '--source', first.source, '--json'], consent: [], actor: 'user', ask_user: true, requires_exclusive: false,
      why: 'Previews moving the folder rules to the store this host sees; writes nothing without --yes.', verify: doctorVerify(name), docs: 'docs/guides/error-codes.md#access_policy_store_mismatch' } };
}

async function guarded(name: string, run: (engine: BrainEngine, sources: string[]) => Promise<Check>, engine: BrainEngine, sources: string[] | null): Promise<Omit<Check, 'name'>> {
  const { name: _name, ...check } = sources === null || sources.length
    ? await run(engine, sources ?? []).catch(error => checkError(name, `run ${name}`, error))
    : infoCheck(name, 'Not applicable: no source has a folder rule.', 'not_applicable');
  return check;
}

async function runFolderAccess(ctx: DoctorContext): Promise<Check[]> {
  const engine = connectedEngine(ctx);
  const sources = await policySources(engine).catch(() => null);
  const checks: Check[] = [];
  checks.push({ name: 'access_policy_pending', ...await guarded('access_policy_pending', pending, engine, sources) });
  checks.push({ name: 'access_policy_widening_held', ...await guarded('access_policy_widening_held', held, engine, sources) });
  checks.push({ name: 'access_policy_invalid', ...await guarded('access_policy_invalid', invalid, engine, sources) });
  checks.push({ name: 'access_policy_store_mismatch', ...await guarded('access_policy_store_mismatch', storeMismatch, engine, sources) });
  return checks;
}

export const folderAccessEntry: DoctorEntry = {
  name: 'access_policy_pending',
  emits: ['access_policy_pending', 'access_policy_widening_held', 'access_policy_invalid', 'access_policy_store_mismatch'],
  run: runFolderAccess,
};
