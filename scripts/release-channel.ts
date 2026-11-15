#!/usr/bin/env bun
/**
 * GitHub release state for the stable channel (docs/RELEASING.md#which-release-github-calls-latest).
 *
 *   bun scripts/release-channel.ts backfill [--apply]
 *   bun scripts/release-channel.ts undo [--apply]
 *   bun scripts/release-channel.ts preview-promotion [--version <v>]
 *
 * release.yml publishes every batch release as a pre-release and promote-stable.ts marks the stable release
 * "Latest". This script brings releases published before that rule in line, takes the rule back out, or shows what a
 * promotion would write, without promoting anything. backfill and undo only print their plan unless --apply is given.
 *
 * - backfill: every published release newer than the current stable becomes a pre-release, and the stable release
 *   becomes Latest with notes rolled up since the previous stable (a rollback stable keeps its notes). Releases older
 *   than stable are left alone. It is also the repair when a promotion moved stable but could not mark it Latest.
 * - undo: every pre-release with a v<VERSION> tag goes back to a normal release, then the newest release by version
 *   becomes Latest, which is how releases looked before. Notes are left as they are. No tag or user data moves.
 * - preview-promotion: which release would become Latest (the newest published release unless --version names one)
 *   and the notes promote-stable.ts would write for it against the current stable. Writes nothing.
 *
 * Runs from a checkout with gh signed in to an account that can edit releases (apply only) and git able to fetch tags.
 */
import { compareVersions, latestReleaseVersion, parseTagMessage, processDeps, Refusal, rolledUpNotes, type PromoteDeps } from './promote-stable.ts';

export type ReleaseDeps = Pick<PromoteDeps, 'repo' | 'ghApi' | 'ghApiWrite' | 'git' | 'log'>;
export interface ReleaseRow { id: number; tag_name: string; draft: boolean; prerelease: boolean }
export interface Target { id: number; version: string }

const RELEASE_TAG = /^v(\d+\.\d+\.\d+(?:\.\d+)?)$/;
const versionOf = (r: ReleaseRow) => RELEASE_TAG.exec(r.tag_name)?.[1] ?? null;
const published = (rows: readonly ReleaseRow[]) =>
  rows.filter(r => !r.draft && versionOf(r)).map(r => ({ ...r, version: versionOf(r)! })).sort((a, b) => compareVersions(b.version, a.version));

/** Releases newer than stable that are not pre-releases yet, and the stable release itself (null when it has no published release). */
export function planBackfill(rows: readonly ReleaseRow[], stable: string): { latest: Target | null; markPrerelease: Target[]; olderUntouched: number } {
  const all = published(rows);
  const hit = all.find(r => r.version === stable);
  return {
    latest: hit ? { id: hit.id, version: hit.version } : null,
    markPrerelease: all.filter(r => compareVersions(r.version, stable) > 0 && !r.prerelease).map(r => ({ id: r.id, version: r.version })),
    olderUntouched: all.filter(r => compareVersions(r.version, stable) < 0).length,
  };
}

/** Every v<VERSION> pre-release goes back to a normal release, and the newest release becomes Latest. */
export function planUndo(rows: readonly ReleaseRow[]): { latest: Target | null; clearPrerelease: Target[] } {
  const all = published(rows);
  return {
    latest: all[0] ? { id: all[0].id, version: all[0].version } : null,
    clearPrerelease: all.filter(r => r.prerelease).map(r => ({ id: r.id, version: r.version })),
  };
}

export async function listReleases(deps: ReleaseDeps): Promise<ReleaseRow[]> {
  const out: ReleaseRow[] = [];
  for (let page = 1; page <= 50; page++) {
    const rows = await deps.ghApi(`repos/${deps.repo}/releases?per_page=100&page=${page}`) as ReleaseRow[];
    out.push(...rows.map(r => ({ id: r.id, tag_name: r.tag_name, draft: r.draft, prerelease: r.prerelease })));
    if (rows.length < 100) break;
  }
  return out;
}

/** The current stable version, the stable before it and whether it was a rollback, from the `stable` tag's message. */
export async function readStable(deps: ReleaseDeps): Promise<{ version: string; previous: string | null; rollback: boolean }> {
  const ref = await deps.ghApi(`repos/${deps.repo}/git/ref/tags/stable`) as { object?: { sha?: string; type?: string } };
  if (ref.object?.type !== 'tag' || !ref.object.sha) throw new Refusal('refs/tags/stable is not an annotated tag, so the current stable cannot be read; repair it by hand (docs/RELEASING.md#stable-channel-promotion).');
  const tag = await deps.ghApi(`repos/${deps.repo}/git/tags/${ref.object.sha}`) as { message?: string };
  const fields = parseTagMessage(tag.message ?? '');
  if (!fields) throw new Refusal('The stable tag message is not a promotion record, so the current stable cannot be read; repair it by hand (docs/RELEASING.md#stable-channel-promotion).');
  return { version: fields.version, previous: fields.previous, rollback: fields.rollback };
}

async function changelogAt(deps: ReleaseDeps, version: string): Promise<string> {
  const fetched = await deps.git(['fetch', '--no-tags', 'origin', `refs/tags/v${version}`]);
  if (fetched.code !== 0) throw new Refusal(`Could not fetch the tag v${version} (${fetched.stderr.trim().split('\n').at(-1)}); check the remote, then re-run.`);
  const shown = await deps.git(['show', 'FETCH_HEAD:CHANGELOG.md']);
  if (shown.code !== 0) throw new Refusal(`Could not read CHANGELOG.md at v${version} (${shown.stderr.trim().split('\n').at(-1)}); re-run.`);
  return shown.stdout;
}

const list = (targets: readonly Target[]) => targets.length ? targets.map(t => `v${t.version}`).join(', ') : 'none';

export async function run(deps: ReleaseDeps, argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  const apply = rest.includes('--apply');
  const latestVersion = await latestReleaseVersion(deps);
  const latestNow = latestVersion ? `v${latestVersion}` : 'none';

  if (command === 'backfill') {
    const stable = await readStable(deps);
    const plan = planBackfill(await listReleases(deps), stable.version);
    if (!plan.latest) throw new Refusal(`The stable release v${stable.version} has no published GitHub release; publish it before backfilling.`);
    if (latestVersion && compareVersions(latestVersion, stable.version) > 0) {
      throw new Refusal(`GitHub's Latest is v${latestVersion}, newer than stable v${stable.version}. Backfilling now would move Latest back, and binaries released before this change install whatever Latest is, so they would downgrade; run backfill after stable passes v${latestVersion}. Would mark pre-release: ${plan.markPrerelease.length} (${list(plan.markPrerelease)}).`);
    }
    const notes = stable.rollback ? null : rolledUpNotes(await changelogAt(deps, stable.version), stable.previous, stable.version, deps.repo);
    deps.log(`release-channel backfill (${apply ? 'apply' : 'preview: nothing written; re-run with --apply to write'})`);
    deps.log(`current Latest: ${latestNow}`);
    deps.log(`stable: v${stable.version} (previous stable ${stable.previous ? `v${stable.previous}` : 'none'}${stable.rollback ? ', a rollback' : ''})`);
    deps.log(`mark Latest: v${plan.latest.version} (${notes === null ? 'notes kept' : `notes rolled up, ${notes.length} characters`})`);
    deps.log(`mark pre-release: ${plan.markPrerelease.length} (${list(plan.markPrerelease)})`);
    deps.log(`older releases left alone: ${plan.olderUntouched}`);
    if (!apply) return;
    if ((await readStable(deps)).version !== stable.version) throw new Refusal('stable moved while the plan was being built (a promotion ran); nothing was written, re-run backfill.');
    await deps.ghApiWrite('PATCH', `repos/${deps.repo}/releases/${plan.latest.id}`, { prerelease: false, make_latest: 'true', ...(notes === null ? {} : { body: notes }) });
    for (const t of plan.markPrerelease) await deps.ghApiWrite('PATCH', `repos/${deps.repo}/releases/${t.id}`, { prerelease: true, make_latest: 'false' });
    deps.log(`applied: v${plan.latest.version} is Latest; ${plan.markPrerelease.length} marked pre-release`);
    return;
  }

  if (command === 'undo') {
    const plan = planUndo(await listReleases(deps));
    if (!plan.latest) throw new Refusal('There are no published releases, so there is nothing to undo.');
    deps.log(`release-channel undo (${apply ? 'apply' : 'preview: nothing written; re-run with --apply to write'})`);
    deps.log(`current Latest: ${latestNow}`);
    deps.log(`clear pre-release: ${plan.clearPrerelease.length} (${list(plan.clearPrerelease)})`);
    deps.log(`mark Latest: v${plan.latest.version} (the newest release)`);
    if (!apply) return;
    for (const t of plan.clearPrerelease) await deps.ghApiWrite('PATCH', `repos/${deps.repo}/releases/${t.id}`, { prerelease: false, make_latest: 'false' });
    await deps.ghApiWrite('PATCH', `repos/${deps.repo}/releases/${plan.latest.id}`, { prerelease: false, make_latest: 'true' });
    deps.log(`applied: ${plan.clearPrerelease.length} pre-releases cleared; v${plan.latest.version} is Latest`);
    return;
  }

  if (command === 'preview-promotion') {
    const flag = rest.indexOf('--version');
    const stable = await readStable(deps);
    const all = published(await listReleases(deps));
    const version = flag >= 0 ? (rest[flag + 1] ?? '').replace(/^v/, '') : all[0]?.version;
    if (!version || !all.some(r => r.version === version)) throw new Refusal(`v${version ?? '?'} has no published GitHub release; name one with --version.`);
    if (compareVersions(version, stable.version) <= 0) throw new Refusal(`v${version} is not newer than the current stable v${stable.version}; a forward promotion needs a newer release.`);
    const notes = rolledUpNotes(await changelogAt(deps, version), stable.version, version, deps.repo);
    deps.log(`release-channel preview-promotion (nothing written)`);
    deps.log(`current Latest: ${latestNow}; current stable: v${stable.version}`);
    deps.log(`promoting v${version} would make it Latest with these notes (${notes.length} characters):`);
    deps.log('-----');
    deps.log(notes.trimEnd());
    deps.log('-----');
    return;
  }

  throw new Refusal('usage: bun scripts/release-channel.ts backfill [--apply] | undo [--apply] | preview-promotion [--version <v>]');
}

if (import.meta.main) {
  const deps = processDeps();
  if (!deps.repo) deps.repo = 'garrytan/gbrain';
  try {
    await run(deps, process.argv.slice(2));
  } catch (e) {
    console.error(`release-channel: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
