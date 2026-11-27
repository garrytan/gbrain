/**
 * Where an owned-folder source's pages go (GST-3022): files under `.gbrain-owned/<id>/` in the default source's Git
 * checkout, or database-only with a reason. Every check fails closed to database-only and runs at the start of every
 * sync, so a brain that stops qualifying stops writing to Git on its next run and leaves its committed files alone.
 *
 * The checkout qualifies when it is the default source's anchor (its local_path, else sync.repo_path), absolute, the
 * work tree's own top level, writable (not a read-only mirror or a URL clone), on an unmanaged brain that is personal
 * (classifyBrainAudience personal, fewer than two enabled members, access.serves not several), and Git neither
 * ignores the folder nor filters it. The push destination's collaborators cannot be seen from the checkout, so the
 * branch's push URLs are recorded at the first write; a later run whose URLs differ (compared normalized: no
 * credentials, no `.git` suffix, case-folded host) writes nothing more until the owner re-binds it
 * (`gbrain sources rebind <id>`), which records the new destination and changes no file. A push destination that is
 * not proven private (public, or not checkable) is database-only too (`not_private`), and rebind refuses it.
 */
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { git } from '../git/git-run.ts';
import { classifyBrainAudience } from '../facts/writeback-audience.ts';
import { brainServes } from '../access/serves.ts';
import { managedPersistenceEnabled } from '../persistence/ownership.ts';
import { readCachedPrivateVerdict, verifyRepoVisibility, writeVisibilityCache } from '../repo-visibility.ts';
import { parseSourceConfig } from '../sources-load.ts';
import { ownedFolderRel } from './paths.ts';

export type OwnedDatabaseOnlyReason = 'no_repository' | 'not_personal' | 'managed' | 'ignored' | 'remote_changed' | 'not_private' | 'read_only_root' | 'conflict' | 'git_error';

export type OwnedDestination =
  | { record: 'folder'; root: string; rel: string; folder: string; pushUrls: string[] }
  | { record: 'database'; reason: OwnedDatabaseOnlyReason; detail: string; root: string | null; pushUrls?: string[] };

const db = (reason: OwnedDatabaseOnlyReason, detail: string, root: string | null = null, pushUrls?: string[]): OwnedDestination =>
  ({ record: 'database', reason, detail, root, ...(pushUrls ? { pushUrls } : {}) });

/** A push URL as compared across runs: no credentials or query, scp form as ssh, case-folded host, no `.git` or trailing slash. */
export function normalizePushUrl(url: string): string {
  let u = url.trim();
  const scp = /^([^@/:\s]+@)?([^/:\s]+):(?!\/\/)(.+)$/.exec(u);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = `ssh://${scp[2]}/${scp[3]}`;
  try {
    const parsed = new URL(u);
    if (parsed.protocol === 'file:') return `file://${parsed.pathname.replace(/\/+$/, '').replace(/\.git$/, '')}`;
    return `${parsed.host.toLowerCase()}${parsed.pathname.replace(/\/+$/, '').replace(/\.git$/, '')}`;
  } catch {
    return u.replace(/\/+$/, '').replace(/\.git$/, '');
  }
}

/** The push URLs, as configured, of the remote gbrain's publish pushes the current branch to (commit-push.ts resolveCtx: the branch remote, else origin); [] when none. */
function rawPushUrls(root: string): string[] {
  const cfg = (key: string) => git(root, ['config', '--get', key]).stdout.trim();
  const branch = git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']).stdout.trim();
  const remote = (branch && cfg(`branch.${branch}.remote`)) || 'origin';
  const out = git(root, ['remote', 'get-url', '--push', '--all', remote]);
  return out.code === 0 ? out.stdout.split('\n').map(s => s.trim()).filter(Boolean) : [];
}

/** Those push URLs normalized, deduplicated and sorted. */
export function branchPushUrls(root: string): string[] {
  return [...new Set(rawPushUrls(root).map(normalizePushUrl))].sort();
}

/**
 * Why the push destination is not proven private, or null when it is. A path on this machine is as private as the
 * checkout; any other URL needs a private verdict from the repo-visibility ladder (repo-visibility.ts, cached for an
 * hour), so a public remote and one that cannot be checked (offline, an unknown host) both keep the pages out of Git.
 */
async function notPrivate(root: string): Promise<string | null> {
  for (const url of rawPushUrls(root)) {
    if (/^file:\/\//i.test(url) || isAbsolute(url) || url.startsWith('./') || url.startsWith('../')) continue;
    if (readCachedPrivateVerdict(url)) continue;
    const verdict = await verifyRepoVisibility({ originUrl: url, repoDir: root, timeoutMs: 10_000 }).catch((e: Error) => ({ verdict: 'unverifiable' as const, detail: e.message, rungs: [] }));
    writeVisibilityCache(url, verdict);
    if (verdict.verdict !== 'private') return `the checkout pushes to ${normalizePushUrl(url)}, which is ${verdict.verdict === 'public' ? 'public' : 'not proven private'} (${verdict.detail})`;
  }
  return null;
}

export const samePushUrls = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);

/** The default source's checkout root when it qualifies as a place for files, else why not. */
export async function defaultCheckout(engine: Pick<BrainEngine, 'executeRaw'> & Partial<Pick<BrainEngine, 'getConfig'>>): Promise<{ root: string } | { reason: OwnedDatabaseOnlyReason; detail: string }> {
  const [row] = await engine.executeRaw<{ local_path: string | null; config: unknown }>("SELECT local_path, config FROM sources WHERE id = 'default'");
  const anchor = row?.local_path?.trim() || (await engine.getConfig?.('sync.repo_path').catch(() => null))?.trim() || '';
  if (!anchor) return { reason: 'no_repository', detail: 'the brain has no repository' };
  if (!isAbsolute(anchor) || !existsSync(anchor)) return { reason: 'no_repository', detail: `the default source's checkout ${anchor} is not an absolute path that exists` };
  const top = git(anchor, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0) return { reason: 'no_repository', detail: `${anchor} is not a Git checkout` };
  let root: string;
  try {
    root = realpathSync(anchor);
    if (realpathSync(top.stdout.trim()) !== root) return { reason: 'no_repository', detail: `${anchor} is inside the Git checkout ${top.stdout.trim()}, not its top level` };
  } catch {
    return { reason: 'no_repository', detail: `${anchor} could not be resolved` };
  }
  const config = parseSourceConfig(row?.config);
  if (config.mirror_read_only === true) return { reason: 'read_only_root', detail: 'the default source is a read-only mirror' };
  if (typeof config.remote_url === 'string' && config.remote_url) return { reason: 'read_only_root', detail: 'the default source is a clone gbrain pulls from a URL' };
  return { root };
}

/** A personal brain: the conversation archive's test (audience personal and proven, under two enabled members, not serving several). */
export async function brainIsPersonal(engine: BrainEngine): Promise<{ personal: boolean; detail: string }> {
  const [audience, serves] = await Promise.all([classifyBrainAudience(engine).catch(() => null), brainServes(engine).catch(() => null)]);
  if (!audience || audience.audience !== 'personal' || audience.unproven) return { personal: false, detail: `the brain is not personal (${audience?.audience ?? 'unknown'})` };
  if (!serves) return { personal: false, detail: 'who the brain serves could not be read' };
  if (serves.serves === 'several' || serves.enabled_members.length >= 2) return { personal: false, detail: 'the brain serves several people' };
  return { personal: true, detail: 'personal' };
}

/**
 * Where this run writes. `recordedPushUrls` is what the first write recorded (null before it), so a changed push
 * destination keeps the pages database-only until `gbrain sources rebind`.
 */
export async function resolveOwnedDestination(engine: BrainEngine, sourceId: string, recordedPushUrls: readonly string[] | null): Promise<OwnedDestination> {
  if (await managedPersistenceEnabled(engine).catch(() => true)) return db('managed', 'the brain is managed by its coordinator');
  const checkout = await defaultCheckout(engine);
  if ('reason' in checkout) return db(checkout.reason, checkout.detail);
  const { root } = checkout;
  const personal = await brainIsPersonal(engine);
  if (!personal.personal) return db('not_personal', personal.detail, root);
  const rel = ownedFolderRel(sourceId);
  for (const probe of [`${rel}/probe.md`, `${rel}/imessage/probe/2000-01-01.md`]) {
    if (git(root, ['check-ignore', '-q', '--no-index', '--', probe]).code === 0) return db('ignored', `Git ignores ${rel}/`, root);
    const attr = git(root, ['check-attr', 'filter', '--', probe]).stdout.trim();
    if (attr && !/: filter: (unspecified|unset)$/.test(attr)) return db('ignored', `a Git filter applies to ${rel}/`, root);
  }
  const pushUrls = branchPushUrls(root);
  if (recordedPushUrls && !samePushUrls(recordedPushUrls, pushUrls)) {
    return db('remote_changed', `the checkout now pushes to ${pushUrls.join(', ') || 'no remote'}, not ${recordedPushUrls.join(', ') || 'no remote'}`, root, pushUrls);
  }
  const why = await notPrivate(root);
  if (why) return db('not_private', why, root, pushUrls);
  return { record: 'folder', root, rel, folder: join(root, rel), pushUrls };
}
