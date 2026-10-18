/**
 * #6743: shared-skills cleanup convergence for `gbrain bootstrap harness`.
 *
 * A rotation leaves each old shared-skills enrollment with that enrollment's
 * own credential, then revokes the credential (leave before revoke:
 * `leave_brain` is principal-owned, so a revoked token can never leave). Two
 * rules keep a re-run converging:
 *
 * - An enrollment whose credential is already revoked is inert remotely: its
 *   leave still runs locally (adapter receipt deactivation, native-router
 *   removal, owned-file cleanup that keeps edited files) and the entry is
 *   recorded as left with reason `credential_revoked`.
 * - Each carried token id is revoked and cleared on its own. Only an id that a
 *   not-yet-left enrollment still holds stays on the receipt.
 *
 * Whatever is still pending is reported per id: the apply exits
 * `bootstrap_cleanup_pending` (14) instead of 0, with a fix that re-runs the
 * command when every id can converge and names the owner's step when one
 * cannot. `--status` and doctor read the same items.
 */
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { cliRenderContext, renderAction, type Action, type RenderedAction } from '../agent-output.ts';
import { loadConfig, toEngineConfig } from '../config.ts';
import type { BrainEngine } from '../engine.ts';
import { createEngine } from '../engine-factory.ts';
import { TOKEN_ID_RE } from '../token-mint.ts';
import type { HarnessReceipt } from './format.ts';
import { probeLivePgliteHolder } from './uninstall.ts';
import type { resolveHarnessDeps } from './harness.ts';

type SkillsEntry = NonNullable<HarnessReceipt['shared_skills']>[number];
type Deps = ReturnType<typeof resolveHarnessDeps>;

export type TokenState = 'active' | 'revoked' | 'missing' | 'unknown';
export type TokenStateLookup = (ids: string[]) => Promise<Record<string, TokenState>>;

export const BOOTSTRAP_CLEANUP_PENDING = 'bootstrap_cleanup_pending';
export const HARNESS_CLEANUP_DOCS = 'docs/guides/bootstrap.md#cleanup-pending';

export interface CleanupItem {
  /** The carried token id; null for an enrollment that used a supplied credential. */
  token_id: string | null;
  host: string | null;
  token: TokenState;
  state: 'revoke_pending' | 'leave_pending' | 'enrollment_retained' | 'credential_unreadable';
  /** True when a plain re-run of the bootstrap command can finish this id. */
  converges: boolean;
  /** The owner's step when a re-run cannot finish it. */
  user_message?: string;
}

/** Read-only: each id's row state in access_tokens. */
export async function tokenStatesWith(engine: Pick<BrainEngine, 'executeRaw'>, ids: string[]): Promise<Record<string, TokenState>> {
  const valid = ids.filter(id => TOKEN_ID_RE.test(id));
  const rows = valid.length === 0 ? [] : await engine.executeRaw<{ id: string; revoked: boolean }>(
    'SELECT id::text AS id, revoked_at IS NOT NULL AS revoked FROM access_tokens WHERE id::text = ANY($1::text[])', [valid]);
  return Object.fromEntries(ids.map(id => {
    const row = rows.find(r => r.id.toLowerCase() === id.toLowerCase());
    return [id, !row ? 'missing' : row.revoked ? 'revoked' : 'active'];
  }));
}

export async function defaultTokenStates(ids: string[]): Promise<Record<string, TokenState>> {
  const cfg = loadConfig();
  if (!cfg) throw new Error('no brain configured');
  // A live serve holds the PGLite single-writer lock (the normal state for --status): the states read unknown.
  if (cfg.database_path && probeLivePgliteHolder(cfg.database_path) !== null) throw new Error('a live gbrain serve holds this PGLite brain');
  const engineConfig = toEngineConfig(cfg);
  const engine = await createEngine(engineConfig);
  await engine.connect(engineConfig);
  try {
    return await tokenStatesWith(engine, ids);
  } finally {
    await engine.disconnect();
  }
}

/** A lookup that cannot reach the brain reads every id as unknown, never as revoked. */
async function lookupStates(lookup: TokenStateLookup, ids: string[]): Promise<Record<string, TokenState>> {
  if (ids.length === 0) return {};
  const states = await lookup(ids).catch(() => ({} as Record<string, TokenState>));
  return Object.fromEntries(ids.map(id => [id, states[id] ?? 'unknown']));
}

export async function credentialRevoked(entry: SkillsEntry, d: Pick<Deps, 'tokenStates'>): Promise<boolean> {
  if (!entry.token_id) return false;
  return (await lookupStates(d.tokenStates, [entry.token_id]))[entry.token_id] === 'revoked';
}

/**
 * Leave an enrollment whose credential is already revoked. The local leave
 * runs with a caller that never contacts the host (a revoked bearer cannot
 * authenticate `leave_brain`), and the remote membership counts as inert.
 */
export async function leaveRevokedEnrollment(entry: SkillsEntry, d: Pick<Deps, 'installSharedSkills' | 'log' | 'logError'>): Promise<boolean> {
  const result = await d.installSharedSkills(
    { version: 1, mcp_url: entry.url, issuer_url: entry.url.replace(/\/mcp$/, ''), client_id: entry.token_id ?? `revoked-${entry.host}` },
    { harness: entry.host, root: entry.root, name: entry.name, remove: true,
      toolCaller: async () => { throw new Error('credential_revoked: the cleanup credential is revoked'); } },
  ).catch(() => ({ status: 'pending', retained_files: undefined }));
  if (result.status !== 'left' && result.status !== 'left_with_retained_files') {
    entry.status = 'pending';
    entry.reason = 'cleanup_unavailable';
    d.logError(`shared skills (${entry.host}): local cleanup of the enrollment for revoked token ${entry.token_id} did not finish; a re-run retries it.`);
    return false;
  }
  entry.status = result.status;
  entry.reason = 'credential_revoked';
  entry.retained_files = result.retained_files;
  rmSync(join(entry.root, 'credentials.json'), { force: true });
  d.log(`shared skills (${entry.host}): token ${entry.token_id} is already revoked, so its enrollment cannot leave remotely and is inert; ` +
    `local cleanup finished${result.retained_files?.length ? ` (edited files retained: ${result.retained_files.join(', ')})` : ''}.`);
  return true;
}

const isCurrentEntry = (receipt: HarnessReceipt, entry: SkillsEntry) =>
  entry.token_id === undefined || entry.token_id === receipt.harness_tokens?.[entry.host]?.id;

/** Not-yet-left enrollments other than this run's current ones (without a run: the receipt's harness tokens). */
function staleEntries(receipt: HarnessReceipt, current?: ReadonlySet<SkillsEntry>): SkillsEntry[] {
  return (receipt.shared_skills ?? []).filter(entry => !entry.status.startsWith('left') &&
    !(current ? current.has(entry) : isCurrentEntry(receipt, entry)));
}

const heldIds = (receipt: HarnessReceipt) =>
  new Set((receipt.shared_skills ?? []).filter(e => !e.status.startsWith('left')).flatMap(e => e.token_id ? [e.token_id] : []));

function idsToClassify(receipt: HarnessReceipt, current?: ReadonlySet<SkillsEntry>): string[] {
  return [...new Set([...(receipt.token.previous_ids ?? []), ...staleEntries(receipt, current).flatMap(e => e.token_id ? [e.token_id] : [])])];
}

/** The pending cleanup, one item per stale enrollment and per carried id no enrollment holds. */
export function harnessCleanupItems(receipt: HarnessReceipt, states: Record<string, TokenState>, current?: ReadonlySet<SkillsEntry>): CleanupItem[] {
  const items: CleanupItem[] = staleEntries(receipt, current).map(entry => {
    const token = entry.token_id ? states[entry.token_id] ?? 'unknown' : 'unknown';
    const base = { token_id: entry.token_id ?? null, host: entry.host, token };
    const id = entry.token_id ?? '(supplied)';
    if (entry.reason === 'cleanup_unavailable' && token !== 'revoked') {
      return { ...base, state: 'credential_unreadable', converges: false,
        user_message: `The cleanup credential of the old ${entry.host} enrollment (${join(entry.root, 'credentials.json')}) is unreadable, so it cannot leave. ` +
          `Restore that file, or revoke token ${id} by id (\`gbrain auth revoke\`): an enrollment whose credential is revoked counts as inert ` +
          'and the next re-run finishes its local cleanup.' };
    }
    if (entry.reason === 'remote_membership_pending' || entry.reason === 'cleanup_unavailable') {
      if (token !== 'missing') return { ...base, state: 'leave_pending', converges: true };
      return { ...base, state: 'leave_pending', converges: false,
        user_message: `Token ${id} is not in this brain's token table, so its ${entry.host} enrollment cannot leave. ` +
          'Check that this machine\'s brain config names the brain the harness serves (`gbrain auth list` shows its tokens).' };
    }
    return { ...base, state: 'enrollment_retained', converges: false,
      user_message: `The old ${entry.host} enrollment (token ${id}) is kept working because the current shared-skills enrollment is not ready ` +
        '(`gbrain bootstrap harness --status` shows why). Resolve that; the next re-run leaves the old enrollment, then revokes its token.' };
  });
  const held = heldIds(receipt);
  for (const id of receipt.token.previous_ids ?? []) {
    if (!held.has(id)) items.push({ token_id: id, host: null, token: states[id] ?? 'unknown', state: 'revoke_pending', converges: true });
  }
  return items;
}

/** Read-only report for `--status` and doctor. */
export async function harnessCleanupReport(receipt: HarnessReceipt, lookup: TokenStateLookup): Promise<CleanupItem[]> {
  return harnessCleanupItems(receipt, await lookupStates(lookup, idsToClassify(receipt)));
}

/**
 * Apply step 10: leave stale enrollments, then revoke each carried id that no
 * remaining enrollment holds. Returns what is still pending.
 */
export async function convergeHarnessCleanup(o: {
  receipt: HarnessReceipt;
  prior: HarnessReceipt | null | undefined;
  current: ReadonlySet<SkillsEntry>;
  wired: boolean;
  skillsReady: boolean;
  memoryOnly: boolean;
  leave: (entry: SkillsEntry, d: Deps) => Promise<boolean>;
  save: () => void;
}, d: Deps): Promise<CleanupItem[]> {
  const { receipt } = o;
  const states = await lookupStates(d.tokenStates, idsToClassify(receipt, o.current));
  const cached: Deps = { ...d, tokenStates: async ids => Object.fromEntries(ids.map(id => [id, states[id] ?? 'unknown'])) };
  // A working prior enrollment stays until the current one is ready (the follow-approval boundary);
  // one whose credential is revoked is already dead, so it always leaves.
  const priorEnrollment = (o.prior?.shared_skills ?? []).some(entry => !entry.status.startsWith('left') &&
    existsSync(join(entry.root, 'shared-skills', 'receipt.json')));
  const leaveAll = (o.wired && (o.skillsReady || !priorEnrollment)) || o.memoryOnly;
  for (const entry of staleEntries(receipt, o.current)) {
    if (!leaveAll && states[entry.token_id ?? ''] !== 'revoked') continue;
    await o.leave(entry, cached);
    o.save();
  }
  receipt.shared_skills = receipt.shared_skills?.filter(entry => entry.status !== 'left');
  o.save();
  if (o.wired && receipt.token.previous_ids?.length) {
    const held = heldIds(receipt);
    const remaining: string[] = [];
    for (const id of receipt.token.previous_ids) {
      if (held.has(id)) { remaining.push(id); continue; }
      try {
        const revoked = await d.revokeById(id);
        d.log(revoked ? `previous harness token revoked (id ${id}).` : `previous harness token was already revoked (id ${id}).`);
      } catch (e) {
        remaining.push(id);
        d.logError(`could not revoke a previous harness token (${e instanceof Error ? e.message : String(e)}); kept on the receipt (id ${id}) for the next re-run.`);
      }
    }
    if (remaining.length > 0) receipt.token.previous_ids = remaining;
    else delete receipt.token.previous_ids;
    o.save();
  }
  const items = harnessCleanupItems(receipt, states, o.current);
  if (items.length > 0) d.logError(`cleanup pending (${BOOTSTRAP_CLEANUP_PENDING}):\n${cleanupLines(items).join('\n')}`);
  return items;
}

const TOKEN_WORDS: Record<TokenState, string> = {
  active: 'active', revoked: 'revoked', missing: "not in this brain's token table", unknown: 'status unknown',
};

function describeItem(item: CleanupItem): string {
  const who = item.token_id ?? `${item.host} (supplied credential)`;
  const what = item.state === 'revoke_pending'
    ? item.token === 'revoked' ? 'no enrollment holds it; a re-run clears it from the receipt' : 'no enrollment holds it; a re-run revokes it (or `gbrain auth revoke` by id)'
    : item.state === 'leave_pending'
      ? item.token === 'revoked' ? 'enrollment cleanup pending; a re-run finishes it locally' : 'enrollment leave pending'
      : item.state === 'credential_unreadable' ? 'its cleanup credential is unreadable' : 'kept for the previous enrollment until the current one is ready';
  return `${who}: ${TOKEN_WORDS[item.token]}; ${what}`;
}

export function cleanupLines(items: CleanupItem[]): string[] {
  return items.map(item => `  pending: ${describeItem(item)}${item.user_message ? ` — ${item.user_message}` : ''}`);
}

/** Doctor's wording: per id, a revoked credential awaiting cleanup reads apart from an active one. */
export function cleanupDoctorMessage(items: CleanupItem[]): string {
  return `shared-skills cleanup pending for ${items.length} previous harness credential(s): ${items.map(describeItem).join('; ')}. ` +
    'Leave before revoke: re-run `gbrain bootstrap harness`, which leaves each old enrollment and then revokes its token. ' +
    'Revoke a token by hand only after its enrollment has left, or when its cleanup credential is lost.';
}

/** The apply's re-run argv: this run's flags, the token value masked, `--yes` added. */
function rerunArgv(raw: readonly string[]): { argv: string[]; token: boolean } {
  const argv = ['gbrain', 'bootstrap', 'harness'];
  let token = false;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '--json') continue;
    if (raw[i] === '--token') { i++; token = true; argv.push('--token', '<TOKEN>'); continue; }
    argv.push(raw[i]!);
  }
  if (!argv.includes('--yes')) argv.push('--yes');
  return { argv, token };
}

export function harnessCleanupFix(items: CleanupItem[], raw: readonly string[]): Action {
  const rerun = rerunArgv(raw);
  const verify = { argv: ['gbrain', 'bootstrap', 'harness', '--status', '--json'] };
  const inputs = rerun.token ? [{ name: 'TOKEN', how: 'The same token this run was given with --token.' }] : undefined;
  const blocked = items.filter(item => !item.converges);
  if (blocked.length === 0) {
    return { argv: rerun.argv, ...(inputs ? { inputs } : {}), consent: [], actor: 'agent', verify, docs: HARNESS_CLEANUP_DOCS, requires_exclusive: false,
      why: 'The same approved command leaves each old shared-skills enrollment, then revokes its token; a leave that was offline is retried.' };
  }
  const first = blocked[0]!;
  const revokeStep = first.state === 'credential_unreadable' && first.token_id !== null;
  return {
    argv: revokeStep ? ['gbrain', 'auth', 'revoke', '--id', first.token_id!] : rerun.argv,
    ...(!revokeStep && inputs ? { inputs } : {}),
    consent: [], actor: 'user', verify, docs: HARNESS_CLEANUP_DOCS, requires_exclusive: false,
    why: 'A re-run alone cannot finish this cleanup; the owner of the old credential acts first.',
    user_message: `${blocked.map(item => item.user_message).join(' ')} Then re-run: ${rerun.argv.join(' ')}`,
  };
}

/** The apply/status `--json` fields: per-id items always; status, code and fix only when the run otherwise succeeded. */
export function cleanupOutcomeFields(items: CleanupItem[], ok: boolean, raw: readonly string[] | null):
  { cleanup?: CleanupItem[]; status?: string; code?: string; fix?: RenderedAction } {
  if (items.length === 0) return {};
  if (!ok) return { cleanup: items };
  return { status: 'cleanup_pending', code: BOOTSTRAP_CLEANUP_PENDING, cleanup: items,
    ...(raw ? { fix: renderAction(harnessCleanupFix(items, raw), cliRenderContext()) } : {}) };
}
