#!/usr/bin/env bun
/**
 * check:public-surface: stable's promise (docs/STABILITY.md "What stays the same on stable"), checked against the
 * base branch on every pull request.
 *
 *   bun scripts/check-public-surface.ts
 *
 * Against the merge base with the base ref ($GBRAIN_SURFACE_BASE_REF, default origin/master; a shallow clone is
 * deepened until it has one) it refuses:
 *   1. an entry of docs/contracts/public-surface.json that the base has and this tree drops (or an exit code whose
 *      number changed), unless deprecations.d/<id>.md names it (same surface and name, or the command or MCP tool a
 *      dropped flag or parameter belongs to) and its remove_after date has passed. Exempt: an entry the manifest at the
 *      stable release ($GBRAIN_SURFACE_STABLE_REF, default refs/tags/stable; fetched from origin when the clone lacks
 *      it, and under CI=true a fetch that fails or times out refuses) lacks, every drop when a new kind: breaking row
 *      has exception: security or data-loss, and, while no stable manifest can be read (it is said so), every drop
 *      when one has exception: revert;
 *   2. a deprecations.d record added here whose remove_after is less than 14 days away, a record whose remove_after
 *      moved earlier or whose surface or name changed, or any record with a bad field;
 *   3. a behavior-changes.d fragment added here with no `kind:`, or with `kind: breaking` and neither
 *      `exception: security|data-loss` nor `deprecation: <id>` naming a record whose remove_after has passed;
 *   4. a change to the CLI or agent-contract goldens with no new behavior-changes.d fragment and no changelog.d line
 *      `<!-- public-surface: no-behavior-change: <reason> -->`.
 * The manifest's freshness is regen:all's (scripts/build-public-surface.ts --check). Dates are UTC days;
 * GBRAIN_SURFACE_TODAY (YYYY-MM-DD) overrides today for tests. When the base ref, a merge base or a file on the merge
 * base is unavailable the check fails under CI=true and skips locally. Fetches (the stable ref, deepening a shallow
 * clone with --filter=blob:none, since GitHub's pack-objects crashes on tree:0 for a shallow clone that is not partial) stop after
 * 20 s and 30 s, or $GBRAIN_SURFACE_FETCH_TIMEOUT_S; a failed fetch prints git's own error. Exit: 0 ok or skipped,
 * 1 refused.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHANGELOG_FRAGMENT_DIR, FRAGMENT_DIR, ID, parseNoticeFragment } from './build-behavior-changes.ts';
import { MANIFEST, SURFACES, type PublicSurface, type Surface } from './build-public-surface.ts';

export const DEPRECATION_DIR = 'deprecations.d';
export const GOLDEN_DIRS = ['test/fixtures/goldens/cli/', 'test/fixtures/agent-contract/'];
export const NO_BEHAVIOR_CHANGE = /<!--\s*public-surface:\s*no-behavior-change:\s*\S[^>]*-->/;
const NOTICE_DAYS = 14;
const SEE = 'See:  docs/STABILITY.md#what-stays-the-same-on-stable and deprecations.d/README.md';
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const RECORD_SURFACES: readonly string[] = [...SURFACES, 'page-format', 'bundled-skill'];

export interface Deprecation { id: string; surface: string; name: string; owner: string; remove_after: string }

const frontOf = (raw: string) => {
  const out: Record<string, string> = {};
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  for (const line of (m?.[1] ?? '').split(/\r?\n/)) {
    const kv = /^([a-z_]+)\s*:\s*(.*?)\s*$/.exec(line);
    if (kv) out[kv[1]!] = kv[2]!.replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
};
const addDays = (day: string, n: number) => new Date(Date.parse(day + 'T00:00:00Z') + n * 86_400_000).toISOString().slice(0, 10);

/** Entries the base has and the head lacks, as surface + name (an exit code whose number changed counts). */
export function droppedEntries(base: PublicSurface, head: PublicSurface): Array<{ surface: string; name: string }> {
  const out: Array<{ surface: string; name: string }> = [];
  for (const surface of SURFACES) {
    if (surface === 'exit-code') {
      for (const [code, exit] of Object.entries(base['exit-code'] ?? {})) if (head['exit-code']?.[code] !== exit) out.push({ surface, name: code });
      continue;
    }
    const kept = new Set(head[surface] ?? []);
    for (const name of base[surface] ?? []) if (!kept.has(name)) out.push({ surface, name });
  }
  return out;
}

export function main(opts: { cwd?: string; env?: Record<string, string | undefined>; log?: (line: string) => void } = {}): number {
  const root = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((line: string) => console.log(line));
  const today = env.GBRAIN_SURFACE_TODAY || new Date().toISOString().slice(0, 10);
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return { ok: r.status === 0, out: r.stdout ?? '', err: (r.stderr ?? '').trim() };
  };
  const fetchTimeout = (seconds: number) => Number(env.GBRAIN_SURFACE_FETCH_TIMEOUT_S) || seconds;
  let fetchError = '';
  const fetch = (seconds: number, ...args: string[]): 'ok' | 'timeout' | 'failed' => {
    fetchError = '';
    const r = spawnSync('git', ['fetch', '--no-tags', '--quiet', ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'], timeout: fetchTimeout(seconds) * 1000, killSignal: 'SIGKILL' });
    if (r.status === 0) return 'ok';
    if ((r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') return 'timeout';
    fetchError = (r.stderr ?? '').split('\n').map(l => l.trim()).filter(Boolean).slice(-4).join(' / ').slice(-600);
    return 'failed';
  };
  const logFetchError = (result: string | null) => { if (result === 'failed' && fetchError) log(`git: ${fetchError}`); };
  const ref = env.GBRAIN_SURFACE_BASE_REF || 'origin/master';
  if (!git('rev-parse', '--verify', '-q', `${ref}^{commit}`).ok) {
    if (env.CI === 'true') {
      log(`FAIL: check-public-surface: base ref ${ref} is not available.`);
      log('Fix:  fetch it in the workflow (git fetch --no-tags --depth=1 origin +refs/heads/master:refs/remotes/origin/master)');
      return 1;
    }
    log(`GBRAIN_CHECK_SKIPPED: base ref ${ref} unavailable`);
    return 0;
  }
  let mergeBase = git('merge-base', ref, 'HEAD');
  let deepened: ReturnType<typeof fetch> | null = null;
  if (!mergeBase.ok && git('rev-parse', '--is-shallow-repository').out.trim() === 'true') {
    const tip = git('rev-parse', `${ref}^{commit}`).out.trim();
    const parents = git('cat-file', '-p', 'HEAD').out.split('\n').filter(l => l.startsWith('parent ')).map(l => l.slice('parent '.length));
    if (parents.includes(tip)) mergeBase = { ok: true, out: tip, err: '' };
    for (const depth of [200, 2000]) {
      if (mergeBase.ok || deepened === 'timeout') break;
      deepened = fetch(30, '--filter=blob:none', `--deepen=${depth}`, 'origin', git('rev-parse', 'HEAD').out.trim(), tip);
      mergeBase = git('merge-base', ref, 'HEAD');
    }
  }
  if (!mergeBase.ok) {
    if (env.CI === 'true') {
      log(`FAIL: check-public-surface: no merge base between HEAD and ${ref}, ${deepened === 'timeout' ? `because the fetch that deepens the clone timed out after ${fetchTimeout(30)} s` : 'even after deepening the clone'}.`);
      logFetchError(deepened);
      log('Fix:  fetch more history in the workflow (actions/checkout fetch-depth: 0)');
      return 1;
    }
    log(`GBRAIN_CHECK_SKIPPED: no merge base between HEAD and ${ref}`);
    return 0;
  }
  const base = mergeBase.out.trim();
  let unreadable: { path: string; error: string } | null = null;
  const onBase = (path: string) => {
    const listed = git('ls-tree', '-z', '--name-only', base, '--', path);
    if (!listed.ok) unreadable ??= { path, error: listed.err };
    return listed.ok && listed.out === `${path}\0`;
  };
  const readBase = (path: string) => {
    if (!onBase(path)) return null;
    const shown = git('show', `${base}:${path}`);
    if (!shown.ok) unreadable ??= { path, error: shown.err };
    return shown.ok ? shown.out : null;
  };
  const listDir = (dir: string) => (existsSync(join(root, dir)) ? readdirSync(join(root, dir)).filter(f => f.endsWith('.md') && f !== 'README.md').sort() : []);
  const problems: string[] = [];

  const records = new Map<string, Deprecation>();
  for (const f of listDir(DEPRECATION_DIR)) {
    const id = f.replace(/\.md$/, '');
    const path = `${DEPRECATION_DIR}/${f}`;
    const front = frontOf(readFileSync(join(root, path), 'utf8'));
    const record = { id, surface: front.surface ?? '', name: front.name ?? '', owner: front.owner ?? '', remove_after: front.remove_after ?? '' };
    const bad = [
      !ID.test(id) && 'its file name is not an id (lowercase letters, digits and _, starting with a letter)',
      !RECORD_SURFACES.includes(record.surface) && `surface: must be one of ${RECORD_SURFACES.join(', ')}`,
      !record.name && 'name: is missing',
      !record.owner && 'owner: is missing',
      !DATE.test(record.remove_after) && 'remove_after: must be a date (YYYY-MM-DD)',
    ].filter(Boolean);
    for (const b of bad) problems.push(`${path}: ${b}`);
    const baseText = readBase(path);
    const baseFront = baseText === null ? null : frontOf(baseText);
    const baseDate = baseFront ? baseFront.remove_after ?? '' : null;
    if (!bad.length && baseFront?.surface && baseFront.name && (baseFront.surface !== record.surface || baseFront.name !== record.name)) {
      problems.push(`${path}: it named ${baseFront.surface} \`${baseFront.name}\` on ${ref}; a record keeps the surface and name it was announced with, so add a new record for ${record.surface} \`${record.name}\``);
    }
    if (!bad.length && baseDate !== null && DATE.test(baseDate) && record.remove_after < baseDate) {
      problems.push(`${path}: remove_after moves from ${baseDate} to ${record.remove_after}; an announced date can move later, never earlier`);
    }
    if (!bad.length && baseDate === null && record.remove_after < addDays(today, NOTICE_DAYS)) {
      problems.push(`${path}: remove_after ${record.remove_after} is less than ${NOTICE_DAYS} days away; a removal is announced at least ${NOTICE_DAYS} days ahead (${addDays(today, NOTICE_DAYS)} or later)`);
    }
    records.set(id, record);
  }
  const matured = (r: Deprecation | undefined) => !!r && DATE.test(r.remove_after) && r.remove_after <= today;

  const newNotices = listDir(FRAGMENT_DIR).filter(f => !onBase(`${FRAGMENT_DIR}/${f}`))
    .map(f => ({ path: `${FRAGMENT_DIR}/${f}`, ...parseNoticeFragment(readFileSync(join(root, FRAGMENT_DIR, f), 'utf8')) }));
  const exceptions = new Set(newNotices.filter(n => n.front.kind === 'breaking' && n.front.exception).map(n => n.front.exception));

  const unreadableBase = (): number | null => {
    if (!unreadable) return null;
    const { path, error } = unreadable;
    if (env.CI === 'true') {
      log(`FAIL: check-public-surface: ${path} could not be read at ${ref}'s merge base ${base.slice(0, 12)}, so the check cannot compare with it.`);
      if (error) log(`git: ${error.split('\n').filter(Boolean).slice(-4).join(' / ').slice(-600)}`);
      log('Fix:  rerun once origin answers, or fetch full history in the workflow (actions/checkout fetch-depth: 0)');
      return 1;
    }
    log(`GBRAIN_CHECK_SKIPPED: ${path} could not be read at the merge base ${base.slice(0, 12)}`);
    return 0;
  };

  const baseManifest = readBase(MANIFEST);
  const manifestUnread = unreadableBase();
  if (manifestUnread !== null) return manifestUnread;
  if (baseManifest !== null && existsSync(join(root, MANIFEST))) {
    const head: PublicSurface = JSON.parse(readFileSync(join(root, MANIFEST), 'utf8'));
    const dropped = exceptions.has('security') || exceptions.has('data-loss') ? [] : droppedEntries(JSON.parse(baseManifest), head);
    const stableRef = env.GBRAIN_SURFACE_STABLE_REF || 'refs/tags/stable';
    const resolveStable = () => git('rev-parse', '--verify', '-q', `${stableRef}^{commit}`);
    let stableCommit = resolveStable();
    if (dropped.length && !stableCommit.ok && stableRef.startsWith('refs/')) {
      const shallow = git('rev-parse', '--is-shallow-repository').out.trim() === 'true';
      const fetched = fetch(20, ...(shallow ? ['--depth=1'] : []), 'origin', `+${stableRef}:${stableRef}`);
      stableCommit = resolveStable();
      if (!stableCommit.ok && env.CI === 'true') {
        log(`FAIL: check-public-surface: this change drops public entries, and the stable ref ${stableRef} could not be fetched from origin${fetched === 'timeout' ? ` (timed out after ${fetchTimeout(20)} s)` : ''}, so it cannot tell which of them reached stable.`);
        logFetchError(fetched);
        log(`Fix:  rerun once origin answers, or fetch it in the workflow (git fetch --no-tags --depth=1 origin +${stableRef}:${stableRef})`);
        return 1;
      }
    }
    const stableManifest = stableCommit.ok ? git('show', `${stableCommit.out.trim()}:${MANIFEST}`) : null;
    const stable: PublicSurface | null = stableManifest?.ok ? JSON.parse(stableManifest.out) : null;
    if (!stableCommit.ok) log(`check-public-surface: stable ref ${stableRef} is unavailable (a shallow clone or a missing tag), so every entry counts as on stable`);
    else if (!stable) log(`check-public-surface: stable (${stableRef}) has no ${MANIFEST} yet, so every entry counts as on stable`);
    const onStable = (surface: string, name: string) => !stable
      || (surface === 'exit-code' ? name in (stable['exit-code'] ?? {}) && stable['exit-code'][name] !== head['exit-code']?.[name] : (stable[surface as Exclude<Surface, 'exit-code'>] ?? []).includes(name));
    for (const { surface, name } of dropped) {
      if (!onStable(surface, name) || (exceptions.has('revert') && !stable)) continue;
      const coveredByParent = (r: Deprecation) => (r.surface === 'cli-command' && (surface === 'cli-command' || surface === 'cli-flag') && name.startsWith(`${r.name} `))
        || (r.surface === 'mcp-tool' && surface === 'mcp-param' && name.startsWith(`${r.name}.`));
      const record = [...records.values()].find(r => r.surface === surface && r.name === name)
        ?? [...records.values()].find(coveredByParent);
      if (!record) problems.push(`${surface} \`${name}\` is removed or changed with no ${DEPRECATION_DIR}/<id>.md naming it (surface: ${surface}, name: ${name})${exceptions.has('revert') ? '; it is on stable, so exception: revert does not cover it' : ''}`);
      else if (!matured(record)) problems.push(`${surface} \`${name}\` is removed before its record ${DEPRECATION_DIR}/${record.id}.md allows it (remove_after ${record.remove_after}); keep it working with a warning until then`);
    }
  } else if (baseManifest === null) {
    log(`check-public-surface: ${ref} has no ${MANIFEST} yet; the removal check starts once it does`);
  }

  for (const { path, front, problems: invalid } of newNotices) {
    for (const p of invalid) problems.push(`${path}: ${p}`);
    if (!front.kind) { problems.push(`${path}: a new behaviour-change row needs front matter with kind: breaking, action, default, fix or add (${FRAGMENT_DIR}/README.md)`); continue; }
    if (front.kind !== 'breaking' || front.exception) continue;
    const record = front.deprecation ? records.get(front.deprecation) : undefined;
    if (!front.deprecation) problems.push(`${path}: kind: breaking needs exception: security or data-loss, or deprecation: <id> naming a ${DEPRECATION_DIR} record whose remove_after has passed`);
    else if (!record) problems.push(`${path}: deprecation: ${front.deprecation} names no ${DEPRECATION_DIR}/${front.deprecation}.md`);
    else if (!matured(record)) problems.push(`${path}: deprecation: ${front.deprecation} has not matured (remove_after ${record.remove_after})`);
  }

  const goldenDiff = git('diff', '--name-only', base, '--', ...GOLDEN_DIRS);
  if (!goldenDiff.ok) unreadable ??= { path: GOLDEN_DIRS.join(', '), error: goldenDiff.err };
  const goldens = goldenDiff.out.split('\n').filter(Boolean);
  if (goldens.length && !newNotices.length) {
    const waived = listDir(CHANGELOG_FRAGMENT_DIR).some(f => !onBase(`${CHANGELOG_FRAGMENT_DIR}/${f}`) && NO_BEHAVIOR_CHANGE.test(readFileSync(join(root, CHANGELOG_FRAGMENT_DIR, f), 'utf8')));
    if (!waived) problems.push(`CLI or agent-contract goldens changed (${goldens.slice(0, 3).join(', ')}${goldens.length > 3 ? `, +${goldens.length - 3} more` : ''}) with no new ${FRAGMENT_DIR} row; add one with its kind, or put <!-- public-surface: no-behavior-change: <reason> --> in your ${CHANGELOG_FRAGMENT_DIR} fragment`);
  }

  const goldensUnread = unreadableBase();
  if (goldensUnread !== null) return goldensUnread;
  if (!problems.length) {
    log(`check-public-surface: ok against ${ref} (${records.size} deprecation record(s), ${newNotices.length} new behaviour-change row(s))`);
    return 0;
  }
  for (const p of problems) log(`FAIL: ${p}`);
  log('Why:  stable promises that documented commands, flags, tools, config keys and exit codes change only after a 14-day announced deprecation, except for security and data-loss fixes; what never reached stable can go at once.');
  log(SEE);
  return 1;
}

if (import.meta.main) process.exit(main());
