#!/usr/bin/env bun
/**
 * Build src/core/behavior-changes.generated.ts: the BEHAVIOR_CHANGES rows a release disclosed from
 * behavior-changes.d/, and the release of every marked id.
 *
 *   bun scripts/build-behavior-changes.ts           write the generated file
 *   bun scripts/build-behavior-changes.ts --check   read-only: refuse a stale file or a broken fragment
 *
 * A PR that changes behavior adds behavior-changes.d/<id>.md (the notice text, one paragraph) and names the id in
 * its changelog.d fragment as `<!-- behavior-change: <id> -->`. The release folds that fragment into the CHANGELOG
 * under its version, so the marker's section is the row's `since`; nothing in behavior-changes.d is edited. A row
 * whose text is a function stays in src/core/behavior-change-notice.ts as `{ since: releasedIn('<id>'), id: '<id>', ... }`
 * with a marker, and takes its release from BEHAVIOR_CHANGE_RELEASES.
 *
 * Unreleased markers (changelog.d, `## [Unreleased]`) count only while a release is being stamped: VERSION is
 * newer than the CHANGELOG's top release heading (gstack-restamp --release runs this before it folds the
 * fragments). On every other tree they are pending and generate nothing, so a PR never changes the generated file.
 * A changelog.d fragment whose front matter says `bump:` anything but `patch` is refused: releases are PATCH only.
 * Dependency-free and history-free: gstack's release check reruns it in a bare worktree of the release head.
 *
 * Exit: 0 written or fresh, 1 stale or invalid (FAIL/Why/Fix printed), 2 usage.
 * Docs: behavior-changes.d/README.md
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const FRAGMENT_DIR = 'behavior-changes.d';
export const CHANGELOG_FRAGMENT_DIR = 'changelog.d';
export const OUT = 'src/core/behavior-changes.generated.ts';
export const NOTICE_FILE = 'src/core/behavior-change-notice.ts';
export const MARKER = /<!--\s*behavior-change:\s*([^\s]+)\s*-->/g;
export const ID = /^[a-z][a-z0-9_]{2,95}$/;
const NOTICE_CAP = 2_000;
const DOCS = 'behavior-changes.d/README.md';

export interface Release { version: string | null; ids: string[] }
export interface Built { text: string; problems: string[] }

const read = (root: string, rel: string) => (existsSync(join(root, rel)) ? readFileSync(join(root, rel), 'utf8') : '');
const cmp = (a: string, b: string) => {
  const [pa, pb] = [a, b].map(v => v.split('.').map(n => parseInt(n, 10) || 0));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0) ? -1 : 1;
  return 0;
};
const markers = (text: string) => [...text.matchAll(MARKER)].map(m => m[1]!);

/** CHANGELOG sections oldest first: each release heading with the ids its text marks; `## [Unreleased]` has version null. */
export function changelogReleases(changelog: string): Release[] {
  const out: Release[] = [];
  let cur: Release | null = null;
  for (const line of changelog.split('\n')) {
    const h = /^## \[([^\]]+)\]/.exec(line);
    if (h) { cur = { version: /^unreleased$/i.test(h[1]!) ? null : h[1]!, ids: [] }; out.push(cur); continue; }
    if (cur) cur.ids.push(...markers(line));
  }
  return out.reverse();
}

/** The ids the source table holds, and the ids its function rows date with releasedIn('<id>'). */
export function tableIds(notice: string): { ids: Set<string>; tbd: Set<string> } {
  return {
    ids: new Set([...notice.matchAll(/\{ since: [^,]+, id: '([^']+)'/g)].map(m => m[1]!)),
    tbd: new Set([...notice.matchAll(/\{ since: releasedIn\('([a-z0-9_]+)'\)/g)].map(m => m[1]!)),
  };
}

export function build(root: string): Built {
  const problems: string[] = [];
  const version = read(root, 'VERSION').trim();
  const releases = changelogReleases(read(root, 'CHANGELOG.md'));
  const released = releases.filter(r => r.version);
  const top = released.at(-1)?.version ?? null;
  const stamping = !!version && (!top || cmp(version, top) > 0);
  const pendingFiles = existsSync(join(root, CHANGELOG_FRAGMENT_DIR))
    ? readdirSync(join(root, CHANGELOG_FRAGMENT_DIR)).filter(f => f.endsWith('.md') && f !== 'README.md').sort() : [];
  for (const f of pendingFiles) {
    const front = /^---\r?\n([\s\S]*?)\r?\n---\s*(\n|$)/.exec(read(root, join(CHANGELOG_FRAGMENT_DIR, f)))?.[1] ?? '';
    const bump = /^\s*['"]?bump['"]?\s*:(.*)$/m.exec(front)?.[1]?.trim().replace(/^(['"])(.*)\1$/, '$2');
    if (bump !== undefined && bump !== 'patch') problems.push(`${CHANGELOG_FRAGMENT_DIR}/${f} says bump: ${bump}; gbrain releases are PATCH only and the release takes the highest bump in the batch, so delete the bump: line (or write bump: patch)`);
  }
  const pending = [...pendingFiles.flatMap(f => markers(read(root, join(CHANGELOG_FRAGMENT_DIR, f)))), ...releases.filter(r => !r.version).flatMap(r => r.ids)];
  const sinceOf = new Map<string, string>();
  const order: string[] = [];
  const mark = (id: string, v: string) => {
    if (sinceOf.has(id)) { problems.push(`${id} is marked in two releases (${sinceOf.get(id)} and ${v})`); return; }
    sinceOf.set(id, v); order.push(id);
  };
  for (const r of released) for (const id of r.ids) mark(id, r.version!);
  const pendingIds = new Set<string>();
  for (const id of pending) {
    if (pendingIds.has(id)) problems.push(`${id} is marked twice among the unreleased changes (changelog.d and ## [Unreleased]); the release would mark it twice`);
    else if (sinceOf.has(id)) problems.push(`${id} is marked again after release ${sinceOf.get(id)}; a released id is never marked again`);
    pendingIds.add(id);
  }
  for (const id of new Set([...sinceOf.keys(), ...pendingIds])) if (!ID.test(id)) problems.push(`the marker <!-- behavior-change: ${id} --> is not an id: lowercase letters, digits and _, starting with a letter (3-96 characters)`);
  if (stamping) for (const id of pendingIds) if (!sinceOf.has(id)) mark(id, version);

  const files = existsSync(join(root, FRAGMENT_DIR)) ? readdirSync(join(root, FRAGMENT_DIR)).filter(f => f !== 'README.md').sort() : [];
  const texts = new Map<string, string>();
  for (const f of files) {
    const id = f.replace(/\.md$/, '');
    if (!f.endsWith('.md') || !ID.test(id)) { problems.push(`${FRAGMENT_DIR}/${f}: a fragment is named <id>.md, the id lowercase letters, digits and _, starting with a letter (3-96 characters)`); continue; }
    const text = read(root, join(FRAGMENT_DIR, f)).trim().replace(/\s*\n\s*/g, ' ');
    if (!text) problems.push(`${FRAGMENT_DIR}/${f} is empty`);
    else if (text.length > NOTICE_CAP) problems.push(`${FRAGMENT_DIR}/${f} is ${text.length} characters; the notice renders at most ${NOTICE_CAP}`);
    else if (/<!--|^---/.test(text)) problems.push(`${FRAGMENT_DIR}/${f} holds markup; it is the notice text only`);
    texts.set(id, text);
  }
  const table = tableIds(read(root, NOTICE_FILE));
  for (const id of texts.keys()) {
    if (table.ids.has(id)) problems.push(`${FRAGMENT_DIR}/${id}.md repeats the id of a row in ${NOTICE_FILE}`);
    if (!sinceOf.has(id) && !pendingIds.has(id)) problems.push(`${FRAGMENT_DIR}/${id}.md has no <!-- behavior-change: ${id} --> marker in a changelog.d fragment or the CHANGELOG, so no release would disclose it`);
  }
  for (const id of [...sinceOf.keys(), ...pendingIds]) {
    if (!texts.has(id) && !table.tbd.has(id) && !table.ids.has(id)) problems.push(`the marker <!-- behavior-change: ${id} --> names no ${FRAGMENT_DIR}/${id}.md and no function row dated releasedIn('${id}')`);
  }
  for (const id of table.tbd) if (!sinceOf.has(id) && !pendingIds.has(id)) problems.push(`the releasedIn('${id}') row in ${NOTICE_FILE} has no <!-- behavior-change: ${id} --> marker, so no release would date it`);

  const rows = order.filter(id => texts.has(id)).map(id => `  { since: '${sinceOf.get(id)}', id: '${id}', text: ${JSON.stringify(texts.get(id))} },`);
  const map = order.map(id => `  ${id}: '${sinceOf.get(id)}',`);
  const text = [
    '// Generated by scripts/build-behavior-changes.ts from behavior-changes.d/ and the CHANGELOG markers; do not edit.',
    '// Regenerate: bun scripts/build-behavior-changes.ts (the release does it). Docs: behavior-changes.d/README.md',
    '',
    '/** The plain-text rows of behavior-changes.d/, each dated by the release whose CHANGELOG section marks it. */',
    'export const RELEASED_BEHAVIOR_CHANGES: ReadonlyArray<{ since: string; id: string; text: string }> = [',
    ...rows,
    '];',
    '',
    '/** The release of every marked id, so a function row dated releasedIn(id) takes the release that disclosed it. */',
    'export const BEHAVIOR_CHANGE_RELEASES: Readonly<Record<string, string>> = {',
    ...map,
    '};',
    '',
  ].join('\n');
  return { text, problems };
}

export function main(argv: string[], opts: { cwd?: string; log?: (line: string) => void } = {}): number {
  const log = opts.log ?? ((l: string) => console.log(l));
  const root = resolve(opts.cwd ?? join(import.meta.dir, '..'));
  if (argv.some(a => a !== '--check')) { log('usage: bun scripts/build-behavior-changes.ts [--check]'); return 2; }
  const { text, problems } = build(root);
  if (problems.length) {
    log(`FAIL: ${problems.length} behavior-change fragment problem(s):`);
    for (const p of problems) log(`  - ${p}`);
    log('Why:  each notice row needs its text and a marker in its PR\'s changelog.d fragment; the release dates it from the marker.');
    log('Fix:  correct the files named above, then rerun bun scripts/build-behavior-changes.ts --check');
    log(`See:  ${DOCS}`);
    return 1;
  }
  const current = read(root, OUT);
  if (argv.includes('--check')) {
    if (current === text) { log(`build-behavior-changes: ok (${OUT} is fresh)`); return 0; }
    log(`FAIL: ${OUT} is stale.`);
    log('Why:  it must equal what scripts/build-behavior-changes.ts generates from behavior-changes.d/ and the CHANGELOG.');
    log('Fix:  bun scripts/build-behavior-changes.ts, then commit the file');
    log(`See:  ${DOCS}`);
    return 1;
  }
  if (current !== text) writeFileSync(join(root, OUT), text);
  log(current === text ? `build-behavior-changes: ${OUT} unchanged` : `build-behavior-changes: wrote ${OUT}`);
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
