#!/usr/bin/env bun
/**
 * check:public-surface: stable's promise (docs/STABILITY.md "What stays the same on stable"), checked against the
 * base branch on every pull request.
 *
 *   bun scripts/check-public-surface.ts
 *
 * Against the base ref ($GBRAIN_SURFACE_BASE_REF, default origin/master) it refuses:
 *   1. an entry of docs/contracts/public-surface.json that the base has and this tree drops (or an exit code whose
 *      number changed), unless deprecations.d/<id>.md names it (same surface and name) and its remove_after date has
 *      passed;
 *   2. a deprecations.d record added here whose remove_after is less than 14 days away, or any record with a bad field;
 *   3. a behavior-changes.d fragment added here with no `kind:`, or with `kind: breaking` and neither
 *      `exception: security|data-loss` nor `deprecation: <id>` naming a record whose remove_after has passed;
 *   4. a change to the CLI or agent-contract goldens with no new behavior-changes.d fragment and no changelog.d line
 *      `<!-- public-surface: no-behavior-change: <reason> -->`.
 * The manifest's freshness is regen:all's (scripts/build-public-surface.ts --check). Dates are UTC days;
 * GBRAIN_SURFACE_TODAY (YYYY-MM-DD) overrides today for tests. When the base ref is unavailable the check fails under
 * CI=true and skips locally. Exit: 0 ok or skipped, 1 refused.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHANGELOG_FRAGMENT_DIR, FRAGMENT_DIR, ID, parseNoticeFragment } from './build-behavior-changes.ts';
import { MANIFEST, SURFACES, type PublicSurface } from './build-public-surface.ts';

export const DEPRECATION_DIR = 'deprecations.d';
export const GOLDEN_DIRS = ['test/fixtures/goldens/cli/', 'test/fixtures/agent-contract/'];
export const NO_BEHAVIOR_CHANGE = /<!--\s*public-surface:\s*no-behavior-change:\s*\S[^>]*-->/;
const NOTICE_DAYS = 14;
const SEE = 'See:  docs/STABILITY.md#what-stays-the-same-on-stable and deprecations.d/README.md';
const DATE = /^\d{4}-\d{2}-\d{2}$/;

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
    return { ok: r.status === 0, out: r.stdout ?? '' };
  };
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
  const onBase = (path: string) => git('cat-file', '-e', `${ref}:${path}`).ok;
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
      !(SURFACES as readonly string[]).includes(record.surface) && `surface: must be one of ${SURFACES.join(', ')}`,
      !record.name && 'name: is missing',
      !record.owner && 'owner: is missing',
      !DATE.test(record.remove_after) && 'remove_after: must be a date (YYYY-MM-DD)',
    ].filter(Boolean);
    for (const b of bad) problems.push(`${path}: ${b}`);
    if (!bad.length && !onBase(path) && record.remove_after < addDays(today, NOTICE_DAYS)) {
      problems.push(`${path}: remove_after ${record.remove_after} is less than ${NOTICE_DAYS} days away; a removal is announced at least ${NOTICE_DAYS} days ahead (${addDays(today, NOTICE_DAYS)} or later)`);
    }
    records.set(id, record);
  }
  const matured = (r: Deprecation | undefined) => !!r && DATE.test(r.remove_after) && r.remove_after <= today;

  const baseManifest = git('show', `${ref}:${MANIFEST}`);
  if (baseManifest.ok && existsSync(join(root, MANIFEST))) {
    const dropped = droppedEntries(JSON.parse(baseManifest.out), JSON.parse(readFileSync(join(root, MANIFEST), 'utf8')));
    for (const { surface, name } of dropped) {
      const record = [...records.values()].find(r => r.surface === surface && r.name === name);
      if (!record) problems.push(`${surface} \`${name}\` is removed or changed with no ${DEPRECATION_DIR}/<id>.md naming it (surface: ${surface}, name: ${name})`);
      else if (!matured(record)) problems.push(`${surface} \`${name}\` is removed before its record ${DEPRECATION_DIR}/${record.id}.md allows it (remove_after ${record.remove_after}); keep it working with a warning until then`);
    }
  } else if (!baseManifest.ok) {
    log(`check-public-surface: ${ref} has no ${MANIFEST} yet; the removal check starts once it does`);
  }

  const newNotices = listDir(FRAGMENT_DIR).filter(f => !onBase(`${FRAGMENT_DIR}/${f}`));
  for (const f of newNotices) {
    const path = `${FRAGMENT_DIR}/${f}`;
    const { front } = parseNoticeFragment(readFileSync(join(root, path), 'utf8'));
    if (!front.kind) { problems.push(`${path}: a new behaviour-change row needs front matter with kind: breaking, action, default, fix or add (${FRAGMENT_DIR}/README.md)`); continue; }
    if (front.kind !== 'breaking' || front.exception) continue;
    const record = front.deprecation ? records.get(front.deprecation) : undefined;
    if (!front.deprecation) problems.push(`${path}: kind: breaking needs exception: security or data-loss, or deprecation: <id> naming a ${DEPRECATION_DIR} record whose remove_after has passed`);
    else if (!record) problems.push(`${path}: deprecation: ${front.deprecation} names no ${DEPRECATION_DIR}/${front.deprecation}.md`);
    else if (!matured(record)) problems.push(`${path}: deprecation: ${front.deprecation} has not matured (remove_after ${record.remove_after})`);
  }

  const mergeBase = git('merge-base', ref, 'HEAD');
  const from = mergeBase.ok ? mergeBase.out.trim() : ref;
  const goldens = git('diff', '--name-only', from, '--', ...GOLDEN_DIRS).out.split('\n').filter(Boolean);
  if (goldens.length && !newNotices.length) {
    const waived = listDir(CHANGELOG_FRAGMENT_DIR).some(f => !onBase(`${CHANGELOG_FRAGMENT_DIR}/${f}`) && NO_BEHAVIOR_CHANGE.test(readFileSync(join(root, CHANGELOG_FRAGMENT_DIR, f), 'utf8')));
    if (!waived) problems.push(`CLI or agent-contract goldens changed (${goldens.slice(0, 3).join(', ')}${goldens.length > 3 ? `, +${goldens.length - 3} more` : ''}) with no new ${FRAGMENT_DIR} row; add one with its kind, or put <!-- public-surface: no-behavior-change: <reason> --> in your ${CHANGELOG_FRAGMENT_DIR} fragment`);
  }

  if (!problems.length) {
    log(`check-public-surface: ok against ${ref} (${records.size} deprecation record(s), ${newNotices.length} new behaviour-change row(s))`);
    return 0;
  }
  for (const p of problems) log(`FAIL: ${p}`);
  log('Why:  stable promises that documented commands, flags, tools, config keys and exit codes change only after a 14-day announced deprecation, except for security and data-loss fixes.');
  log(SEE);
  return 1;
}

if (import.meta.main) process.exit(main());
