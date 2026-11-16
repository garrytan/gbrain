#!/usr/bin/env bun
/**
 * bun run release:restamp — make a branch next-to-merge in one command.
 *
 *   bun run release:restamp              merge origin/master, restamp, regenerate, check, commit
 *   bun run release:restamp --dry-run    print every planned edit; change nothing (fetches origin/master)
 *   bun run release:restamp --no-commit  same, but leave the restamp edits staged
 *   bun run release:restamp --continue   resume after resolving a stop (conflicts, references, generator, drift)
 *   bun run release:restamp --continue --accept-references
 *                                        resume and keep the listed reference lines as written
 *   bun run release:restamp --abort      return the branch to its pre-run commit
 *   bun run release:unstamp              under merge: direct, convert a stamped branch: merge origin/master, put every
 *                                        version stamp back to master's, move the branch's CHANGELOG entry to
 *                                        changelog.d/<branch-slug>.md and its plain-text BEHAVIOR_CHANGES rows to
 *                                        behavior-changes.d/, renumber its migrations, commit once
 *   bun run migrations:renumber          merge origin/master and renumber this branch's own schema migrations
 *                                        after master's latest; no version stamp
 *   bun scripts/release-restamp.ts --stamp-only <version>
 *                                        the release stamp (.gstack/ship-policy.json restamp_command): write <version>
 *                                        into every stamp in the working tree and nothing else; no fetch, merge,
 *                                        generator or commit
 *
 * Steps: refuse a dirty tree; fetch origin/master; capture the branch's
 * CHANGELOG entry and migration inventory; merge origin/master with a merge
 * commit (version-only stamp hunks, CHANGELOG and generated files resolve
 * mechanically, anything else stops with the file list); set VERSION to
 * master's MAJOR.MINOR.(PATCH+1).0; renumber the branch's own schema
 * migrations (files origin/master does not have) consecutively from master's
 * latest + 1, changing only the filename, the export name and the `version:`
 * literal, with a payload identity check; rewrite every required stamp from
 * the CLAUDE.md "Version locations" table; run the generators; stop on any
 * branch-added line that still names an old migration number; run the
 * version and plugin/template drift checks; commit once. A second run with
 * nothing to change commits nothing. It never touches a database: generators
 * run with database URLs and provider keys removed.
 *
 * Test seams (test/scripts/release-restamp.test.ts): GBRAIN_RESTAMP_STEPS and
 * GBRAIN_RESTAMP_CHECKS (JSON arrays of { name, argv, env?, migrationsOnly? })
 * replace the generator and drift-check commands; GBRAIN_RESTAMP_DATE pins the
 * CHANGELOG date; GBRAIN_RESTAMP_PR_TITLE replaces the `gh pr view` lookup.
 *
 * Exit: 0 done (or nothing to change), 1 stopped (FAIL/Why/Fix/See printed), 2 usage.
 * Docs: docs/RELEASING.md#release-restamp
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  BEHAVIOR_NOTICE_FILE, COLLISION_DOCS, MIGRATION_FILE_RE, MIGRATIONS_DIR, RESTAMP_DOCS, RestampError, STAMPS,
  branchEntrySections, fail, findLeftoverRefs, isGenerated, migrationPayloadKey, nextPatchVersion, parseAddedLines,
  isVersionToken, planRenumber, rebuildChangelog, renumberMigrationText, resolveVersionOnlyHunks, restampSinceLines, restampTodoLines, stampTbdSince, versionOfHeader,
  type BranchMigration, type ChangelogSection, type LeftoverRef, type Renumber,
} from './lib/restamp.ts';
import { offlineEnv } from './regen-all.ts';
import { CHANGELOG_FRAGMENT_DIR, FRAGMENT_DIR } from './build-behavior-changes.ts';

interface Step { name: string; argv: string[]; env?: Record<string, string>; migrationsOnly?: boolean }

const USAGE = `Usage: bun run release:restamp [--dry-run] [--no-commit] [--continue [--accept-references] | --abort] [--remote <name>] [--base <branch>]
       bun scripts/release-restamp.ts --stamp-only <version>

Merges origin/master with a merge commit, sets VERSION to master's MAJOR.MINOR.(PATCH+1).0,
renumbers this branch's own schema migrations after master's latest, rewrites every required
version stamp (CLAUDE.md "Version locations"), regenerates derived files, runs the drift checks
and commits once. Run it when your PR is next to merge.

Migration renumbering changes only the filename, the \`export const v<NNN>\` name and the
\`version: <NNN>\` literal. Branch-added lines that still name an old number in one of these
shapes stop the run (they are listed, never rewritten):
  v<old>  v<old>-<name>  migration <old>  schema_version ... <old>  version: <old>  LATEST_VERSION ... <old>

Docs: ${RESTAMP_DOCS}`;

export const DEFAULT_STEPS: Step[] = [
  { name: 'schema migration registry', argv: ['bun', 'run', 'scripts/build-schema-migrations.ts'] },
  { name: 'migrations golden (records.json)', argv: ['bun', 'test', '--timeout=60000', 'test/migrations-golden.test.ts'], env: { GBRAIN_TEST_UPDATE_GOLDENS: '1' }, migrationsOnly: true },
  { name: 'bun.lock', argv: ['bun', 'install', '--lockfile-only'] },
  { name: 'bootstrap template repo', argv: ['bun', 'run', 'scripts/generate-template-repo.ts', '--out', 'templates/bootstrap/template-repo'] },
  { name: 'regen:all (plugin trees, llms, registries)', argv: ['bun', 'scripts/regen-all.ts'] },
];

export const DEFAULT_CHECKS: Step[] = [
  { name: 'bootstrap runbook stamp', argv: ['bash', 'scripts/check-bootstrap-tag.sh'] },
  { name: 'plugin tree drift', argv: ['bash', 'scripts/check-plugin-tree.sh'] },
  { name: 'bootstrap template drift', argv: ['bash', 'scripts/check-bootstrap-templates.sh'] },
  { name: 'schema migration registry fresh', argv: ['bash', 'scripts/check-schema-migrations-fresh.sh'] },
  { name: 'schema migration order', argv: ['bun', 'scripts/check-schema-migration-order.ts'] },
  { name: "no since: 'TBD' BEHAVIOR_CHANGES row", argv: ['bun', 'scripts/check-behavior-since.ts', '--stamped'] },
  { name: 'CHANGELOG keeps every master release heading', argv: ['bun', 'scripts/check-changelog-headings.ts'] },
];

type Mode = 'restamp' | 'unstamp' | 'renumber';

/** What release:unstamp leaves true: versions back to master's, every fragment valid, no TBD row. */
export const UNSTAMP_CHECKS: Step[] = [
  { name: 'bootstrap runbook stamp', argv: ['bash', 'scripts/check-bootstrap-tag.sh'] },
  { name: 'plugin tree drift', argv: ['bash', 'scripts/check-plugin-tree.sh'] },
  { name: 'bootstrap template drift', argv: ['bash', 'scripts/check-bootstrap-templates.sh'] },
  { name: 'behavior-change fragments', argv: ['bun', 'scripts/build-behavior-changes.ts', '--check'] },
  { name: "no since: 'TBD' BEHAVIOR_CHANGES row", argv: ['bun', 'scripts/check-behavior-since.ts'] },
  { name: 'CHANGELOG keeps every master release heading', argv: ['bun', 'scripts/check-changelog-headings.ts'] },
];

export const RENUMBER_CHECKS: Step[] = [
  { name: 'schema migration registry fresh', argv: ['bash', 'scripts/check-schema-migrations-fresh.sh'] },
  { name: 'schema migration order', argv: ['bun', 'scripts/check-schema-migration-order.ts'] },
];

/** gstack's changelog fragment name for a branch (lib/changelog-fragments.ts fragmentSlug). */
export const fragmentSlug = (branch: string): string =>
  branch.replace(/[\\/]+/g, '-').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 100) || 'change';

interface State {
  mode?: Mode;
  rows?: Array<{ id: string; text: string }>;
  phase: 'merge' | 'merge-conflict' | 'restamp';
  preHead: string;
  masterRef: string;
  branchVersion: string;
  entry: ChangelogSection | null;
  inventory: BranchMigration[];
  conflicted: string[];
  mapping: Array<{ from: number; to: number; fromPath: string; toPath: string }>;
  flaggedRefs: string[];
  merged: boolean;
}

class Ctx {
  constructor(readonly root: string, readonly log: (line: string) => void, readonly env: Record<string, string | undefined>) {}

  run(argv: string[], extraEnv: Record<string, string> = {}, input?: string): { code: number; out: string } {
    const r = Bun.spawnSync(argv, { cwd: this.root, env: { ...offlineEnv(this.env), GBRAIN_GUARD_ROOT: this.root, GBRAIN_BOOTSTRAP_GUARD_ROOT: this.root, ...extraEnv }, stdout: 'pipe', stderr: 'pipe', stdin: input === undefined ? 'ignore' : new TextEncoder().encode(input) });
    return { code: r.exitCode ?? 1, out: `${r.stdout.toString()}${r.stderr.toString()}` };
  }

  git(...args: string[]): string {
    const r = Bun.spawnSync(['git', ...args], { cwd: this.root, env: { ...this.env, GIT_MERGE_AUTOEDIT: 'no' } as Record<string, string>, stdout: 'pipe', stderr: 'pipe' });
    if (r.exitCode !== 0) throw new RestampError(`git ${args.join(' ')} failed (exit ${r.exitCode}): ${r.stderr.toString().trim()}`);
    return r.stdout.toString();
  }

  gitOk(...args: string[]): boolean {
    return Bun.spawnSync(['git', ...args], { cwd: this.root, stdout: 'ignore', stderr: 'ignore' }).exitCode === 0;
  }

  read(path: string): string {
    return readFileSync(join(this.root, path), 'utf8');
  }

  write(path: string, text: string): boolean {
    const file = join(this.root, path);
    if (existsSync(file) && readFileSync(file, 'utf8') === text) return false;
    writeFileSync(file, text);
    return true;
  }

  get statePath(): string {
    return resolve(this.root, this.git('rev-parse', '--git-path', 'gbrain-restamp.json').trim());
  }

  loadState(): State | null {
    return existsSync(this.statePath) ? (JSON.parse(readFileSync(this.statePath, 'utf8')) as State) : null;
  }

  saveState(state: State): void {
    writeFileSync(this.statePath, JSON.stringify(state, null, 2) + '\n');
  }

  steps(key: 'GBRAIN_RESTAMP_STEPS' | 'GBRAIN_RESTAMP_CHECKS', fallback: Step[]): Step[] {
    const raw = this.env[key];
    return raw ? (JSON.parse(raw) as Step[]) : fallback;
  }
}

const RESUME = ['then: bun run release:restamp --continue', 'or return to the pre-run commit: bun run release:restamp --abort'];

function stop(state: State, ctx: Ctx, what: string, why: string, fix: string[]): never {
  ctx.saveState(state);
  return fail(what, why, [...fix, ...RESUME]);
}

/** Blob text of `<ref>:<path>` for many paths in one git process. */
function catFiles(ctx: Ctx, ref: string, paths: string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (paths.length === 0) return out;
  const r = Bun.spawnSync(['git', 'cat-file', '--batch'], { cwd: ctx.root, stdin: new TextEncoder().encode(paths.map((p) => `${ref}:${p}`).join('\n') + '\n'), stdout: 'pipe' });
  const buf = Buffer.from(r.stdout);
  let pos = 0;
  for (const p of paths) {
    const nl = buf.indexOf(10, pos);
    const header = buf.subarray(pos, nl).toString();
    pos = nl + 1;
    if (header.endsWith(' missing')) continue;
    const size = Number(header.split(' ')[2]);
    out.set(p, buf.subarray(pos, pos + size).toString('utf8'));
    pos += size + 1;
  }
  return out;
}

function migrationPaths(names: string[]): Array<{ path: string; version: number; slug: string }> {
  return names.flatMap((n) => {
    const m = MIGRATION_FILE_RE.exec(n);
    return m ? [{ path: `${MIGRATIONS_DIR}/${n}`, version: Number(m[1]), slug: m[2]! }] : [];
  });
}

interface MigrationAnalysis { masterMax: number; branch: BranchMigration[]; plan: Renumber[] }

/**
 * Split `head` migrations into published (on the master ref) and branch-only,
 * with the payload identity rules: a published file must keep master's
 * payload unless only master changed it since the merge base, and a branch
 * file must not be a copy of a published one.
 */
function analyzeMigrations(ctx: Ctx, masterRef: string, head: Map<string, string>): MigrationAnalysis {
  const masterFiles = migrationPaths(ctx.git('ls-tree', '--name-only', `${masterRef}:${MIGRATIONS_DIR}`).split('\n'));
  const masterText = catFiles(ctx, masterRef, masterFiles.map((m) => m.path));
  const masterMax = Math.max(...masterFiles.map((m) => m.version));
  const masterKeys = new Map(masterFiles.map((m) => [migrationPayloadKey(masterText.get(m.path)!, m.path), m.path]));
  const mergeBase = ctx.git('merge-base', 'HEAD', masterRef).trim();
  const baseText = catFiles(ctx, mergeBase, migrationPaths(ctx.git('ls-tree', '--name-only', `${mergeBase}:${MIGRATIONS_DIR}`).split('\n')).map((m) => m.path));
  const changes = (from: string | undefined, to: string, path: string) => from === undefined || (from !== to && migrationPayloadKey(from, path) !== migrationPayloadKey(to, path));
  const branch: BranchMigration[] = [];
  for (const m of migrationPaths([...head.keys()].map((p) => p.slice(MIGRATIONS_DIR.length + 1)))) {
    const text = head.get(m.path)!;
    const published = masterText.get(m.path);
    if (published !== undefined) {
      if (changes(published, text, m.path) && changes(baseText.get(m.path), text, m.path)) {
        fail(`${m.path} is published on ${masterRef} but this branch changes its payload`,
          'brains that already applied it never run it again, so an edit to a published migration silently never lands; restamp never renumbers or edits published migrations.',
          [`put the change in a new migration (bun run new:migration <name>) and restore the file: git checkout ${masterRef} -- ${m.path}`, 'commit, then rerun: bun run release:restamp'], COLLISION_DOCS);
      }
      continue;
    }
    const twin = masterKeys.get(migrationPayloadKey(text, m.path));
    if (twin) {
      fail(`${m.path} has the same payload as ${twin}, which ${masterRef} already publishes`,
        'the migration already landed on master under another number (squash-merged or cherry-picked and renumbered); renumbering this copy would apply it twice.',
        [`drop this branch's copy: git rm ${m.path} && bun run build:schema-migrations`, `point references at ${twin}, commit, then rerun: bun run release:restamp`], COLLISION_DOCS);
    }
    branch.push(m);
  }
  return { masterMax, branch, plan: planRenumber(branch, masterMax) };
}

function workingMigrations(ctx: Ctx): Map<string, string> {
  const dir = join(ctx.root, MIGRATIONS_DIR);
  return new Map(readdirSync(dir).filter((n) => MIGRATION_FILE_RE.test(n)).map((n) => [`${MIGRATIONS_DIR}/${n}`, readFileSync(join(dir, n), 'utf8')]));
}

function headMigrations(ctx: Ctx): Map<string, string> {
  const names = ctx.git('ls-tree', '--name-only', `HEAD:${MIGRATIONS_DIR}`).split('\n').filter((n) => MIGRATION_FILE_RE.test(n));
  return catFiles(ctx, 'HEAD', names.map((n) => `${MIGRATIONS_DIR}/${n}`));
}

function addedLines(ctx: Ctx, from: string, to: string[] = []) {
  return parseAddedLines(ctx.git('diff', '-U0', '--no-renames', '--no-color', '--no-ext-diff', from, ...to));
}

function refKey(r: { file: string; text: string }): string {
  return `${r.file}\u0000${r.text}`;
}

function describeRefs(refs: LeftoverRef[], mapping: State['mapping']): string[] {
  return refs.map((r) => `  ${r.file}:${r.line}: ${r.text.trim()}   (v${r.oldVersion} is now v${mapping.find((m) => m.from === r.oldVersion)?.to ?? '?'})`);
}

function prTitle(ctx: Ctx, version: string): string {
  const fromEnv = ctx.env.GBRAIN_RESTAMP_PR_TITLE;
  let current = fromEnv ?? '';
  if (fromEnv === undefined) {
    const r = Bun.spawnSync(['gh', 'pr', 'view', '--json', 'title', '--jq', '.title'], { cwd: ctx.root, stdout: 'pipe', stderr: 'ignore', timeout: 20_000 });
    current = r.exitCode === 0 ? r.stdout.toString().trim() : '';
  }
  if (!current) return `v${version} <type>(<scope>): <summary>`;
  return `v${version} ${current.replace(/^v?\d+\.\d+\.\d+(?:\.\d+)?(?:-\S+)?\s+/, '')}`;
}

const SIZE_LIMITS = 'scripts/module-size-limits.tsv';
const limitLine = (text: string) => text.split('\n').find((l) => l.startsWith(`${BEHAVIOR_NOTICE_FILE}\t`));
const ROW_DUMP = `import { BEHAVIOR_CHANGES } from './${BEHAVIOR_NOTICE_FILE}';
console.log(JSON.stringify(BEHAVIOR_CHANGES.map((r) => ({ id: r.id ?? null, text: typeof r.text === 'string' ? r.text : null }))));`;

/**
 * The BEHAVIOR_CHANGES rows this branch appended (ids its merge base does not hold), read from the evaluated table at
 * HEAD. release:unstamp moves them to behavior-changes.d/, so it refuses a branch whose notice-file diff is anything
 * but appended table lines, a row without an id, and a row whose text is a function (convert that one by hand).
 */
function branchNoticeRows(ctx: Ctx, masterRef: string, mergeBase: string): Array<{ id: string; text: string }> {
  const added = addedLines(ctx, mergeBase, ['HEAD', '--', BEHAVIOR_NOTICE_FILE]);
  if (added.length === 0) return [];
  const why = 'release:unstamp moves appended plain-text rows to behavior-changes.d/; anything else in the notice file is a product edit to make by hand.';
  const how = ['move each row to behavior-changes.d/<id>.md and name <!-- behavior-change: <id> --> in changelog.d/<slug>.md (behavior-changes.d/README.md), commit,', 'then rerun: bun run release:unstamp'];
  const removed = ctx.git('diff', '--numstat', '--no-renames', mergeBase, 'HEAD', '--', BEHAVIOR_NOTICE_FILE).trim().split('\t')[1];
  const head = ctx.git('show', `HEAD:${BEHAVIOR_NOTICE_FILE}`).split('\n');
  const open = head.findIndex((l) => l.startsWith('export const BEHAVIOR_CHANGES')) + 1;
  const close = head.findIndex((l, i) => i >= open && l === '];') + 1;
  const outside = added.filter((l) => l.line <= open || l.line >= close);
  if (removed !== '0' || outside.length > 0) fail(`this branch changes ${BEHAVIOR_NOTICE_FILE} beyond appending BEHAVIOR_CHANGES rows${outside.length ? ` (line ${outside.slice(0, 5).map((l) => l.line).join(', ')})` : ''}`, why, how);
  const noId = added.filter((l) => /\{ since:/.test(l.text) && !/\bid: '/.test(l.text));
  if (noId.length > 0) fail(`${noId.length} BEHAVIOR_CHANGES row(s) this branch added have no id (line ${noId.map((l) => l.line).join(', ')})`, 'a moved row is named behavior-changes.d/<id>.md and dated by its id.', 'give each row an id (lowercase letters, digits and _), commit, then rerun: bun run release:unstamp');
  const r = ctx.run(['bun', '-e', ROW_DUMP]);
  const rows = (() => { try { return JSON.parse(r.out.trim().split('\n').at(-1) ?? '') as Array<{ id: string | null; text: string | null }>; } catch { return null; } })();
  if (r.code !== 0 || !rows) fail(`could not read the BEHAVIOR_CHANGES table at HEAD (exit ${r.code}): ${r.out.trim().split('\n').slice(-3).join(' ')}`, 'release:unstamp reads each appended row\'s text from the evaluated table.', 'fix the table so bun can import it, then rerun: bun run release:unstamp');
  const ids = (text: string) => new Set([...text.matchAll(/\bid: '([^']+)'/g)].map((m) => m[1]!));
  const baseIds = ids(ctx.git('show', `${mergeBase}:${BEHAVIOR_NOTICE_FILE}`));
  const mine = rows.filter((row): row is { id: string; text: string | null } => !!row.id && !baseIds.has(row.id));
  const fn = mine.filter((row) => row.text === null).map((row) => row.id);
  if (fn.length > 0) fail(`${fn.length} appended row(s) compute their text (${fn.join(', ')})`, 'a function row stays in the table, dated since: releasedIn(\'<id>\'), which release:unstamp does not write for you.', ["change each to { since: releasedIn('<id>'), id: '<id>', ... }, name <!-- behavior-change: <id> --> in changelog.d/<slug>.md, commit,", 'then rerun: bun run release:unstamp']);
  const taken = [...ids(ctx.git('show', `${masterRef}:${BEHAVIOR_NOTICE_FILE}`))].filter((id) => mine.some((row) => row.id === id));
  const files = ctx.git('ls-tree', '--name-only', `${masterRef}`, '--', `${FRAGMENT_DIR}/`).split('\n').map((f) => f.replace(/^.*\//, '').replace(/\.md$/, ''));
  const dup = [...taken, ...mine.filter((row) => files.includes(row.id)).map((row) => row.id)];
  if (dup.length > 0) fail(`${dup.join(', ')} already name a row on ${masterRef}`, 'every behavior-change id is unique across the table and behavior-changes.d/.', 'rename the row\'s id, commit, then rerun: bun run release:unstamp');
  return mine.map((row) => ({ id: row.id, text: row.text! }));
}

function capture(ctx: Ctx, masterRef: string, mode: Mode = 'restamp'): State {
  const preHead = ctx.git('rev-parse', 'HEAD').trim();
  const mergeBase = ctx.git('merge-base', 'HEAD', masterRef).trim();
  const entries = branchEntrySections(ctx.git('show', 'HEAD:CHANGELOG.md'), ctx.git('show', `${mergeBase}:CHANGELOG.md`));
  if (entries.length > 1) {
    if (mode === 'unstamp') {
      fail(`this branch has ${entries.length} CHANGELOG entries above master's (${entries.map((e) => versionOfHeader(e.header)).join(', ')})`,
        'a branch that carries other PRs (a stack or train) holds their entries too; each PR converts on its own, and its entry leaves this branch once it reaches master.',
        ['land or convert the PRs this branch carries first, merge master into this branch,', 'then rerun: bun run release:unstamp (or write changelog.d/<branch-slug>.md for your own entry by hand)']);
    }
    fail(`this branch has ${entries.length} CHANGELOG entries above master's (${entries.map((e) => versionOfHeader(e.header)).join(', ')})`,
      'a branch ships one unified entry (docs/RELEASING.md "CHANGELOG + VERSION are branch-scoped"); restamp re-stamps exactly one.',
      'fold them into one `## [X.Y.Z.W] - date` entry, commit, then rerun: bun run release:restamp');
  }
  const head = headMigrations(ctx);
  const inventory = analyzeMigrations(ctx, masterRef, head).branch;
  if (mode === 'unstamp') {
    if (entries.length === 0) {
      fail(`this branch has no CHANGELOG entry above ${masterRef}'s`, 'release:unstamp moves the branch\'s own top entry into its changelog fragment; an edit inside a released section is not one.',
        `write changelog.d/<branch-slug>.md yourself (changelog.d/README.md), put CHANGELOG.md back to the merge base's, commit, then rerun: bun run release:unstamp`);
    }
    const ownLines = new Set(entries[0]!.text.split('\n'));
    const rest = ctx.git('show', 'HEAD:CHANGELOG.md').replace(entries[0]!.text + '\n', '');
    if (rest !== ctx.git('show', `${mergeBase}:CHANGELOG.md`) && ownLines.size > 0) {
      fail('this branch also edits released CHANGELOG sections', 'under releases per batch a PR changes the CHANGELOG only through its changelog.d fragment; a release never rewrites a released section.',
        'move those edits into your entry (or drop them), commit, then rerun: bun run release:unstamp');
    }
  }
  const rows = mode === 'unstamp' ? branchNoticeRows(ctx, masterRef, mergeBase) : [];
  return { mode, rows, phase: 'merge', preHead, masterRef, branchVersion: ctx.git('show', 'HEAD:VERSION').trim(), entry: entries[0] ?? null, inventory, conflicted: [], mapping: [], flaggedRefs: [], merged: false };
}

function merge(ctx: Ctx, state: State): void {
  if (ctx.gitOk('merge-base', '--is-ancestor', state.masterRef, 'HEAD')) {
    ctx.log(`restamp: branch already contains ${state.masterRef}; no merge needed.`);
    return;
  }
  const attempt = Bun.spawnSync(['git', 'merge', '--no-ff', '--no-commit', state.masterRef], { cwd: ctx.root, env: { ...ctx.env, GIT_MERGE_AUTOEDIT: 'no' } as Record<string, string>, stdout: 'pipe', stderr: 'pipe' });
  const conflicted = ctx.git('diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean);
  if (attempt.exitCode !== 0 && conflicted.length === 0 && !ctx.gitOk('rev-parse', '-q', '--verify', 'MERGE_HEAD')) {
    stop(state, ctx, `git merge ${state.masterRef} did not start: ${attempt.stderr.toString().trim().split('\n').slice(-3).join(' ')}`,
      'restamp merges master before allocating numbers; git refused the merge before any conflict resolution.',
      ['fix what git reports (for example move an untracked file it would overwrite)']);
  }
  const genuine: string[] = [];
  const stampFiles = new Set(STAMPS.map((s) => s.file));
  for (const f of conflicted) {
    if (f === 'CHANGELOG.md') {
      ctx.write(f, ctx.git('show', `${state.masterRef}:CHANGELOG.md`));
    } else if (isGenerated(f)) {
      if (!ctx.gitOk('checkout', '--theirs', '--', f)) {
        genuine.push(f);
        continue;
      }
    } else if (state.mode === 'unstamp' && (state.rows ?? []).length > 0 && f === BEHAVIOR_NOTICE_FILE) {
      ctx.write(f, ctx.git('show', `${state.masterRef}:${f}`));
    } else if (state.mode === 'unstamp' && (state.rows ?? []).length > 0 && f === SIZE_LIMITS) {
      const merged = mergeLimitsWithMastersNoticeRow(ctx);
      if (merged === null) {
        genuine.push(f);
        continue;
      }
      ctx.write(f, merged);
    } else if (stampFiles.has(f) && existsSync(join(ctx.root, f))) {
      const r = resolveVersionOnlyHunks(ctx.read(f));
      if (r.unresolved > 0) {
        genuine.push(f);
        continue;
      }
      ctx.write(f, r.text);
    } else {
      genuine.push(f);
      continue;
    }
    ctx.git('add', '--', f);
  }
  state.merged = true;
  if (genuine.length > 0) {
    state.phase = 'merge-conflict';
    state.conflicted = genuine;
    stop(state, ctx, `merging ${state.masterRef} left ${genuine.length} conflict(s) restamp cannot resolve mechanically:\n${genuine.map((f) => `      ${f}`).join('\n')}`,
      'version-only stamp hunks, CHANGELOG.md and generated files resolve mechanically; these files have real edits on both sides.',
      ['resolve each file, then git add <file> (do not commit; restamp writes the merge commit)']);
  }
  ctx.git('commit', '--no-edit', '--quiet');
  ctx.log(`restamp: merged ${state.masterRef} with a merge commit (${conflicted.length} conflict(s) resolved mechanically).`);
}

/** The size table merged with the notice file's row taken from master on every side (its rows leave the file), or null on a real conflict. */
function mergeLimitsWithMastersNoticeRow(ctx: Ctx): string | null {
  const stage = (n: number) => ctx.git('show', `:${n}:${SIZE_LIMITS}`);
  const [base, ours, theirs] = [stage(1), stage(2), stage(3)];
  const master = limitLine(theirs);
  const pin = (text: string) => { const own = limitLine(text); return own && master ? text.replace(own, master) : text; };
  const dir = resolve(ctx.root, ctx.git('rev-parse', '--git-path', 'gbrain-unstamp-limits').trim());
  const at = (name: string) => join(dir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(at('base'), pin(base));
  writeFileSync(at('ours'), pin(ours));
  writeFileSync(at('theirs'), pin(theirs));
  const r = Bun.spawnSync(['git', 'merge-file', '-p', at('ours'), at('base'), at('theirs')], { cwd: ctx.root, stdout: 'pipe', stderr: 'pipe' });
  rmSync(dir, { recursive: true, force: true });
  return r.exitCode === 0 ? r.stdout.toString() : null;
}

function finishMerge(ctx: Ctx, state: State): void {
  const unmerged = ctx.git('diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean);
  const marked = state.conflicted.filter((f) => existsSync(join(ctx.root, f)) && /^(<<<<<<<|>>>>>>>) /m.test(ctx.read(f)));
  if (unmerged.length > 0 || marked.length > 0) {
    stop(state, ctx, `conflicts are still unresolved: ${[...new Set([...unmerged, ...marked])].join(', ')}`,
      'restamp writes the merge commit only after every conflicted file is resolved and staged.',
      ['remove the conflict markers, git add <file>']);
  }
  if (ctx.gitOk('rev-parse', '-q', '--verify', 'MERGE_HEAD')) ctx.git('commit', '--no-edit', '--quiet');
  state.phase = 'restamp';
  ctx.saveState(state);
}

function applyRenumber(ctx: Ctx, state: State, plan: Renumber[]): void {
  const staged = plan.map((r, i) => ({ r, tmp: `${MIGRATIONS_DIR}/.restamp-${i}-${r.from.slug}.ts` }));
  for (const { r, tmp } of staged) ctx.git('mv', r.from.path, tmp);
  for (const { r, tmp } of staged) {
    const before = ctx.read(tmp);
    const after = renumberMigrationText(before, r.toPath, r.toVersion);
    if (migrationPayloadKey(after, r.toPath) !== migrationPayloadKey(before, r.from.path)) {
      fail(`renumbering ${r.from.path} would change more than its version`, 'restamp may change only the filename, export name and version literal.', 'report this with the file attached; renumber it by hand (docs below), then rerun', COLLISION_DOCS);
    }
    writeFileSync(join(ctx.root, tmp), after);
    ctx.git('mv', tmp, r.toPath);
    ctx.git('add', '--', r.toPath);
    const prior = state.mapping.find((m) => m.to === r.from.version);
    if (prior) {
      prior.to = r.toVersion;
      prior.toPath = r.toPath;
    } else state.mapping.push({ from: r.from.version, to: r.toVersion, fromPath: r.from.path, toPath: r.toPath });
  }
}

interface Outcome { version: string; masterVersion: string }

/**
 * release:unstamp's one conversion: every version stamp back to master's, the branch's CHANGELOG entry to its
 * changelog fragment, its appended rows to behavior-changes.d/ with a marker each, and the notice file and its size
 * row to master's. Nothing else changes, so gstack-ship-receipt carry can read the commit as an unstamp.
 */
function unstampFiles(ctx: Ctx, state: State, masterVersion: string): void {
  if (!state.entry) {
    fail(`this branch has no CHANGELOG entry above ${state.masterRef}'s`, 'release:unstamp moves the branch\'s own entry into its changelog fragment.',
      `write ${CHANGELOG_FRAGMENT_DIR}/<branch-slug>.md yourself (docs/RELEASING.md#releases-per-batch), commit, then rerun: bun run release:unstamp`);
  }
  const frag = `${CHANGELOG_FRAGMENT_DIR}/${fragmentSlug(ctx.git('rev-parse', '--abbrev-ref', 'HEAD').trim())}.md`;
  if (ctx.gitOk('cat-file', '-e', `HEAD:${frag}`)) fail(`${frag} already exists`, 'release:unstamp writes the branch\'s entry there and never merges two entries.', `fold your CHANGELOG entry into ${frag} by hand, put CHANGELOG.md back to ${state.masterRef}'s, commit, then rerun`);
  stampOnly(ctx.root, masterVersion, [state.branchVersion]);
  ctx.write('CHANGELOG.md', ctx.git('show', `${state.masterRef}:CHANGELOG.md`));
  const rows = state.rows ?? [];
  const body = state.entry.text.split('\n').slice(1).join('\n').trim();
  mkdirSync(join(ctx.root, CHANGELOG_FRAGMENT_DIR), { recursive: true });
  ctx.write(frag, [body, ...(rows.length ? ['', ...rows.map((r) => `<!-- behavior-change: ${r.id} -->`)] : [])].join('\n') + '\n');
  if (rows.length === 0) return;
  mkdirSync(join(ctx.root, FRAGMENT_DIR), { recursive: true });
  for (const row of rows) ctx.write(`${FRAGMENT_DIR}/${row.id}.md`, `${row.text}\n`);
  ctx.write(BEHAVIOR_NOTICE_FILE, ctx.git('show', `${state.masterRef}:${BEHAVIOR_NOTICE_FILE}`));
  const limits = ctx.read(SIZE_LIMITS);
  const [own, master] = [limitLine(limits), limitLine(ctx.git('show', `${state.masterRef}:${SIZE_LIMITS}`))];
  if (own && master && own !== master) ctx.write(SIZE_LIMITS, limits.replace(own, master));
}

function restampTree(ctx: Ctx, state: State, opts: { acceptRefs: boolean; date: string }): Outcome {
  const mode = state.mode ?? 'restamp';
  const masterVersion = ctx.git('show', `${state.masterRef}:VERSION`).trim();
  const version = mode === 'restamp' ? nextPatchVersion(masterVersion) : masterVersion;

  const migrations = analyzeMigrations(ctx, state.masterRef, workingMigrations(ctx));
  applyRenumber(ctx, state, migrations.plan);
  ctx.saveState(state);

  if (mode === 'unstamp') unstampFiles(ctx, state, masterVersion);
  for (const stamp of mode === 'restamp' ? STAMPS : []) {
    if (!existsSync(join(ctx.root, stamp.file))) fail(`${stamp.file} is missing`, 'it is a required row of the CLAUDE.md "Version locations" table.', `restore it from ${state.masterRef} (git checkout ${state.masterRef} -- ${stamp.file}), then rerun with --continue`);
    const text = ctx.read(stamp.file);
    if (stamp.read(text) !== version) ctx.write(stamp.file, stamp.write(text, version));
  }
  const olds = new Set([state.branchVersion, state.entry ? versionOfHeader(state.entry.header) ?? '' : ''].filter((v) => v && v !== version && isVersionToken(v)));
  if (mode === 'restamp' && existsSync(join(ctx.root, BEHAVIOR_NOTICE_FILE))) {
    const notice = ctx.read(BEHAVIOR_NOTICE_FILE);
    const lines = new Set(addedLines(ctx, state.masterRef, ['--', BEHAVIOR_NOTICE_FILE]).map((l) => l.line));
    let stamped = stampTbdSince(notice, version);
    for (const old of olds) stamped = restampSinceLines(stamped, lines, old, version);
    if (stamped !== notice) ctx.write(BEHAVIOR_NOTICE_FILE, stamped);
  }
  if (mode === 'restamp' && state.entry) {
    const old = versionOfHeader(state.entry.header) ?? state.branchVersion;
    ctx.write('CHANGELOG.md', rebuildChangelog(ctx.read('CHANGELOG.md'), state.entry, old, version, opts.date));
  }
  if (mode === 'restamp' && existsSync(join(ctx.root, 'TODOS.md'))) {
    const lines = new Set(addedLines(ctx, state.masterRef, ['--', 'TODOS.md']).map((l) => l.line));
    let text = ctx.read('TODOS.md');
    for (const old of olds) text = restampTodoLines(text, lines, old, version);
    ctx.write('TODOS.md', text);
  }

  const hasMigrations = migrations.branch.length > 0;
  for (const step of ctx.steps('GBRAIN_RESTAMP_STEPS', DEFAULT_STEPS)) {
    if (step.migrationsOnly && !hasMigrations) continue;
    if (mode !== 'restamp' && !(hasMigrations && (step.migrationsOnly || step.name === 'schema migration registry'))) continue;
    const r = ctx.run(step.argv, step.env);
    if (r.code !== 0) {
      stop(state, ctx, `generator "${step.name}" failed (${step.argv.join(' ')}, exit ${r.code}):\n${r.out.trim().split('\n').slice(-15).map((l) => `      | ${l}`).join('\n')}`,
        'restamp regenerates every derived file after the version and migration edits; a failing generator leaves them stale.',
        [`run it directly (${step.argv.join(' ')}) and fix what it reports`]);
    }
    ctx.log(`restamp: regenerated ${step.name}`);
  }

  if (state.mapping.length > 0) {
    const renamed = new Set(state.mapping.map((m) => m.toPath));
    ctx.git('add', '-A');
    const flagged = new Set(state.flaggedRefs);
    let refs = findLeftoverRefs(addedLines(ctx, state.masterRef), state.mapping.map((m) => m.from), renamed);
    if (flagged.size > 0) refs = refs.filter((r) => flagged.has(refKey(r)));
    if (refs.length > 0 && opts.acceptRefs) {
      ctx.log(`restamp: kept ${refs.length} reference line(s) as written (--accept-references):\n${describeRefs(refs, state.mapping).join('\n')}`);
      state.flaggedRefs = [];
    } else if (refs.length > 0) {
      state.flaggedRefs = refs.map(refKey);
      stop(state, ctx, `${refs.length} line(s) this branch added still name a renumbered migration's old number:\n${describeRefs(refs, state.mapping).join('\n')}`,
        'restamp renames only the migration file, its export name and its version literal; any other mention may mean the old migration or the published one that now owns that number, so it is listed instead of rewritten.',
        ['edit each line to the new number shown (an edited line is not listed again),',
          'or, when a line means the published migration that now owns that number, add --accept-references to --continue']);
    }
  }

  const drift = mode === 'restamp' ? driftProblems(ctx, version, masterVersion, state)
    : mode === 'unstamp' ? STAMPS.flatMap((stamp) => { const v = stamp.read(ctx.read(stamp.file)); return v === masterVersion ? [] : [`${stamp.file} says ${v ?? '<none>'}, expected master's ${masterVersion}`]; }) : [];
  for (const check of ctx.steps('GBRAIN_RESTAMP_CHECKS', mode === 'restamp' ? DEFAULT_CHECKS : mode === 'unstamp' ? UNSTAMP_CHECKS : hasMigrations ? RENUMBER_CHECKS : [])) {
    const r = ctx.run(check.argv, check.env);
    if (r.code !== 0) drift.push(`${check.name} (${check.argv.join(' ')}, exit ${r.code}):\n${r.out.trim().split('\n').slice(-10).map((l) => `      | ${l}`).join('\n')}`);
  }
  if (drift.length > 0) {
    stop(state, ctx, `drift check(s) failed after restamping to ${version}:\n${drift.map((d) => `      - ${d}`).join('\n')}`,
      '/ship\'s idempotency check and CI require every version stamp and generated tree to agree before the PR merges.',
      ['fix each item listed']);
  }
  return { version, masterVersion };
}

function driftProblems(ctx: Ctx, version: string, masterVersion: string, state: State): string[] {
  const out: string[] = [];
  for (const stamp of STAMPS) {
    const v = stamp.read(ctx.read(stamp.file));
    if (v !== version) out.push(`${stamp.file} says ${v ?? '<none>'}, expected ${version}`);
  }
  const top = /^## \[([^\]]+)\]/m.exec(ctx.read('CHANGELOG.md'))?.[1];
  if (top !== version) {
    out.push(state.entry
      ? `CHANGELOG.md top entry is ${top}, expected ${version}`
      : `CHANGELOG.md has no entry for this branch (top entry ${top} is master's); write one with /ship: \`## [${version}] - <date>\` on top`);
  }
  if (version === masterVersion) out.push(`VERSION ${version} is not newer than master's ${masterVersion}`);
  return out;
}

function printDryRun(ctx: Ctx, state: State, date: string): void {
  const masterVersion = ctx.git('show', `${state.masterRef}:VERSION`).trim();
  const version = nextPatchVersion(masterVersion);
  const L = ctx.log;
  L(`restamp --dry-run: nothing will be changed. ${state.masterRef} is at VERSION ${masterVersion}; this branch becomes ${version}.`);
  if (ctx.gitOk('merge-base', '--is-ancestor', state.masterRef, 'HEAD')) L(`Merge: the branch already contains ${state.masterRef}; no merge commit.`);
  else {
    const count = ctx.git('rev-list', '--count', `HEAD..${state.masterRef}`).trim();
    L(`Merge: would merge ${count} commit(s) from ${state.masterRef} with a merge commit.`);
    const r = Bun.spawnSync(['git', 'merge-tree', '--write-tree', '--name-only', '--no-messages', 'HEAD', state.masterRef], { cwd: ctx.root, stdout: 'pipe' });
    const files = r.stdout.toString().split('\n').slice(1).filter(Boolean);
    const stampFiles = new Set(STAMPS.map((s) => s.file));
    for (const f of files) {
      const how = f === 'CHANGELOG.md' ? 'mechanical: master\'s file plus this branch\'s entry on top'
        : isGenerated(f) ? 'mechanical: take master\'s side, then regenerate'
          : stampFiles.has(f) ? 'mechanical when the hunks differ only in version strings, otherwise a stop'
            : 'genuine: the run stops for you to resolve it, then --continue';
      L(`  predicted conflict ${f} (${how})`);
    }
  }
  L('Edits:');
  for (const stamp of STAMPS) {
    const cur = stamp.read(ctx.git('show', `HEAD:${stamp.file}`));
    L(`  ${stamp.file}: ${cur} -> ${version}${cur === version ? ' (unchanged)' : ''}`);
  }
  if (state.entry) rebuildChangelog(ctx.git('show', 'HEAD:CHANGELOG.md'), state.entry, versionOfHeader(state.entry.header) ?? state.branchVersion, version, date);
  L(state.entry
    ? `  CHANGELOG.md: "${state.entry.header}" -> "## [${version}] - ${date}", kept above master's entries`
    : '  CHANGELOG.md: this branch has no entry yet; the drift check will stop until /ship writes one');
  L(`  TODOS.md: branch-added lines naming v${state.branchVersion} -> v${version}`);
  const plan = planRenumber(state.inventory, analyzeMigrations(ctx, state.masterRef, headMigrations(ctx)).masterMax);
  if (plan.length === 0) L(`Migrations: ${state.inventory.length ? `${state.inventory.length} branch migration(s) already follow master's latest` : 'none on this branch'}; nothing to renumber.`);
  else {
    L('Migrations (filename, export name and version literal only):');
    for (const r of plan) L(`  v${r.from.version} -> v${r.toVersion}  ${r.from.path} -> ${r.toPath}`);
    const mergeBase = ctx.git('merge-base', 'HEAD', state.masterRef).trim();
    const refs = findLeftoverRefs(addedLines(ctx, mergeBase, ['HEAD']), plan.map((r) => r.from.version), new Set(plan.map((r) => r.from.path)));
    const mapping = plan.map((r) => ({ from: r.from.version, to: r.toVersion, fromPath: r.from.path, toPath: r.toPath }));
    if (refs.length) L(`References that will stop the run until edited:\n${describeRefs(refs, mapping).join('\n')}`);
  }
  L('Regenerate:');
  for (const s of ctx.steps('GBRAIN_RESTAMP_STEPS', DEFAULT_STEPS)) L(`  ${s.argv.join(' ')}${s.migrationsOnly ? ' (branch has migrations only)' : ''}`);
  L('Drift checks:');
  for (const s of ctx.steps('GBRAIN_RESTAMP_CHECKS', DEFAULT_CHECKS)) L(`  ${s.argv.join(' ')}`);
  L(`Commit: one commit "v${version} chore(release): restamp onto master v${masterVersion}" (--no-commit leaves it staged).`);
  L(`PR title: ${prTitle(ctx, version)}`);
  L('Run it: bun run release:restamp');
}

function report(ctx: Ctx, state: State, outcome: Outcome, committed: string | null, staged: boolean): void {
  const L = ctx.log;
  if (state.mode === 'unstamp' || state.mode === 'renumber') {
    const what = state.mode === 'unstamp'
      ? `unstamp: ${state.branchVersion} -> master's ${outcome.masterVersion}; the entry is in changelog.d/${fragmentSlug(ctx.git('rev-parse', '--abbrev-ref', 'HEAD').trim())}.md${state.rows?.length ? ` and ${state.rows.length} row(s) in behavior-changes.d/ (${state.rows.map((r) => r.id).join(', ')})` : ''}`
      : `renumber: onto master v${outcome.masterVersion}`;
    L(what);
    for (const m of state.mapping) L(`  v${m.from} -> v${m.to}  ${m.fromPath} -> ${m.toPath}`);
    L(committed ? `Committed ${committed.slice(0, 12)}.` : `Nothing to change${state.merged ? ' (only the merge commit was added)' : ''}.`);
    if (state.mode === 'unstamp') L('PR title: drop the version prefix; the release names the version.');
    return;
  }
  L(`restamp: ${state.branchVersion} -> ${outcome.version} (master ${outcome.masterVersion}).`);
  if (state.mapping.length > 0) {
    L('Migration renumbering (source only; no database was touched):');
    for (const m of state.mapping) L(`  v${m.from} -> v${m.to}  ${m.fromPath} -> ${m.toPath}`);
    L('If a database already applied an old number: a disposable dev DB is rebuilt and replayed;');
    L('retained data needs explicit schema_version reconciliation, never a counter edit.');
    L(`  Collision recovery: ${COLLISION_DOCS}`);
    L('Golden regeneration reason (PR body): test/fixtures/goldens/migrations/records.json regenerated by release:restamp for the renumbered migrations listed above.');
  }
  L(`Drift checks: VERSION, package.json, plugin manifests, BOOTSTRAP stamp, CHANGELOG, plugin and template trees agree on ${outcome.version}.`);
  if (committed) L(`Committed ${committed.slice(0, 12)}: v${outcome.version} chore(release): restamp onto master v${outcome.masterVersion}`);
  else if (!staged) L(`Nothing to change: the branch was already restamped onto current master${state.merged ? ' (only the merge commit was added)' : ''}; no restamp commit.`);
  else L(`Edits are staged (--no-commit). Commit them: git commit -m "v${outcome.version} chore(release): restamp onto master v${outcome.masterVersion}"`);
  L(`PR title: ${prTitle(ctx, outcome.version)}   (set it: gh pr edit --title "<that title>")`);
  L('Verify: bun run verify   (full gate before merge: bun run ci:ubicloud or bun run ci:local), then git push');
}

/** Generated trees whose stamp lines name the release; their other bytes do not depend on VERSION. */
const GENERATED_STAMP_ROOTS = ['plugin', 'plugin-variants', 'templates/bootstrap/template-repo'];

/**
 * The release stamp under merge: direct: every STAMPS row and every stamp line of the generated trees moves from the
 * tree's VERSION to `version`. Returns the files written. gstack-restamp --release runs it in a clean checkout of the
 * base and then folds the changelog fragments itself.
 */
export function stampOnly(root: string, version: string, from: string[] = []): string[] {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(version)) fail(`--stamp-only needs a four-part version, got "${version}"`, 'the release stamp writes exactly the version gstack-restamp allocated.', 'pass it as the argument: bun scripts/release-restamp.ts --stamp-only <X.Y.Z.W>');
  const old = readFileSync(join(root, 'VERSION'), 'utf8').trim();
  const written: string[] = [];
  const put = (rel: string, text: string) => {
    if (readFileSync(join(root, rel), 'utf8') === text) return;
    writeFileSync(join(root, rel), text);
    written.push(rel);
  };
  for (const stamp of STAMPS) {
    if (!existsSync(join(root, stamp.file))) fail(`${stamp.file} is missing`, 'it is a required row of the CLAUDE.md "Version locations" table.', `restore it, then rerun: bun scripts/release-restamp.ts --stamp-only ${version}`);
    const text = readFileSync(join(root, stamp.file), 'utf8');    if (stamp.read(text) !== version) put(stamp.file, stamp.write(text, version));
  }
  const olds = [...new Set([old, ...from])].filter((v) => v && v !== version);
  if (olds.length === 0) return written;
  const lines = olds.flatMap((v) => [`"version": "${v}"`, `<!-- gbrain-plugin-tree-stamp: ${v} -->`, `<!-- gbrain-template-stamp: ${v} -->`]);
  const walk = (rel: string): string[] => readdirSync(join(root, rel), { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(rel, e.name)) : e.isFile() && /\.(json|md)$/.test(e.name) ? [join(rel, e.name)] : []);
  for (const dir of GENERATED_STAMP_ROOTS.filter(d => existsSync(join(root, d)))) {
    for (const rel of walk(dir)) {
      const text = readFileSync(join(root, rel), 'utf8');
      let next = text;
      for (const l of lines) next = next.split(l).join(l.replace(/\d+\.\d+\.\d+\.\d+/, version));
      put(rel, next);
    }
  }
  return written;
}

export function main(argv: string[], opts: { cwd?: string; env?: Record<string, string | undefined>; log?: (line: string) => void } = {}): number {
  const log = opts.log ?? ((l: string) => console.log(l));
  const env = opts.env ?? process.env;
  if (argv[0] === '--stamp-only') {
    if (argv.length !== 2) { log(USAGE); return 2; }
    const top = Bun.spawnSync(['git', 'rev-parse', '--show-toplevel'], { cwd: opts.cwd ?? process.cwd(), stdout: 'pipe', stderr: 'pipe' });
    const root = top.exitCode === 0 ? top.stdout.toString().trim() : resolve(opts.cwd ?? process.cwd());
    try {
      const files = stampOnly(root, argv[1]!);
      log(`restamp --stamp-only: ${argv[1]} written to ${files.length} file(s)${files.length ? `: ${files.join(', ')}` : ''}`);
      return 0;
    } catch (e) {
      if (e instanceof RestampError) { log(e.message); return 1; }
      throw e;
    }
  }
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const known = new Set(['--dry-run', '--no-commit', '--continue', '--abort', '--accept-references', '--remote', '--base', '--help', '--unstamp', '--renumber']);
  const mode: Mode = flags.has('--unstamp') ? 'unstamp' : flags.has('--renumber') ? 'renumber' : 'restamp';
  const valueOf = (flag: string, fallback: string) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] ?? '' : fallback);
  const remote = valueOf('--remote', 'origin');
  const base = valueOf('--base', 'master');
  const stray = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--remote' && argv[i - 1] !== '--base');
  if (flags.has('--help')) {
    log(USAGE);
    return 0;
  }
  if ([...flags].some((f) => !known.has(f)) || stray.length || !remote || !base || (flags.has('--continue') && flags.has('--abort')) || (flags.has('--accept-references') && !flags.has('--continue')) || (flags.has('--unstamp') && flags.has('--renumber')) || (mode !== 'restamp' && flags.has('--dry-run'))) {
    log(USAGE);
    return 2;
  }
  const top = Bun.spawnSync(['git', 'rev-parse', '--show-toplevel'], { cwd: opts.cwd ?? process.cwd(), stdout: 'pipe', stderr: 'pipe' });
  if (top.exitCode !== 0) {
    log(`FAIL: not inside a git checkout\nWhy:  restamp edits and commits the current branch.\nFix:  cd into your gbrain checkout and rerun: bun run release:restamp\nSee:  ${RESTAMP_DOCS}`);
    return 1;
  }
  const ctx = new Ctx(top.stdout.toString().trim(), log, env);
  const date = env.GBRAIN_RESTAMP_DATE ?? new Date().toISOString().slice(0, 10);
  try {
    let state = ctx.loadState();
    if (flags.has('--abort')) {
      if (!state) fail('no restamp is in progress', 'there is no saved pre-run commit to return to.', 'nothing to abort; run: bun run release:restamp');
      if (ctx.gitOk('rev-parse', '-q', '--verify', 'MERGE_HEAD')) ctx.git('merge', '--abort');
      ctx.git('reset', '--hard', '--quiet', state.preHead);
      rmSync(ctx.statePath);
      const left = ctx.git('status', '--porcelain').trim();
      log(`restamp --abort: returned to ${state.preHead.slice(0, 12)}.${left ? ` Untracked files restamp did not create remain:\n${left}` : ''}`);
      return 0;
    }
    if (flags.has('--continue')) {
      if (!state) fail('no restamp is in progress', '--continue resumes a run that stopped.', 'start one: bun run release:restamp');
      if (state.phase === 'merge-conflict' || ctx.gitOk('rev-parse', '-q', '--verify', 'MERGE_HEAD')) finishMerge(ctx, state);
      else if (state.phase === 'merge') merge(ctx, state);
    } else {
      if (state) {
        fail(`a restamp is already in progress (stopped in phase "${state.phase}")`, 'starting over would lose the saved pre-run commit and migration mapping.',
          ['finish it: bun run release:restamp --continue', 'or return to the pre-run commit: bun run release:restamp --abort']);
      }
      const dirty = ctx.git('status', '--porcelain').trim();
      if (dirty && !flags.has('--dry-run')) {
        fail(`the working tree is not clean:\n${dirty.split('\n').slice(0, 10).map((l) => `      ${l}`).join('\n')}`,
          'restamp commits its own edits as one commit and --abort resets to the pre-run commit; uncommitted work would be swept in or lost.',
          'commit or stash your changes (git stash -u), then rerun: bun run release:restamp');
      }
      const fetch = Bun.spawnSync(['git', 'fetch', '--quiet', remote, `+refs/heads/${base}:refs/remotes/${remote}/${base}`], { cwd: ctx.root, stdout: 'pipe', stderr: 'pipe' });
      if (fetch.exitCode !== 0) {
        fail(`could not fetch ${remote}/${base}: ${fetch.stderr.toString().trim().split('\n').pop()}`,
          'restamp numbers the version and migrations after the latest master; a stale ref would allocate a taken number.',
          `check network access and the remote, then run: git fetch ${remote} ${base} && bun run release:restamp`);
      }
      const policy = Bun.spawnSync(['git', 'show', `${remote}/${base}:.gstack/ship-policy.json`], { cwd: ctx.root, stdout: 'pipe', stderr: 'ignore' });
      const direct = (() => { try { return JSON.parse(policy.stdout.toString() || '{}').merge === 'direct'; } catch { return false; } })();
      if (direct && mode === 'restamp') {
        fail(`${remote}/${base} lands PRs directly and writes versions at release (.gstack/ship-policy.json merge: direct)`, 'a PR branch carries no version, so there is nothing to restamp.',
          ['a branch stamped before the switch: bun run release:unstamp', 'a branch whose schema migration number master took: bun run migrations:renumber']);
      }
      state = capture(ctx, `${remote}/${base}`, mode);
      if (flags.has('--dry-run')) {
        printDryRun(ctx, state, date);
        return 0;
      }
      ctx.saveState(state);
      merge(ctx, state);
      state.phase = 'restamp';
      ctx.saveState(state);
    }
    const outcome = restampTree(ctx, state, { acceptRefs: flags.has('--accept-references'), date });
    ctx.git('add', '-A');
    const staged = !ctx.gitOk('diff', '--cached', '--quiet');
    let committed: string | null = null;
    if (staged && !flags.has('--no-commit')) {
      const body = state.mapping.length ? `\n\nMigrations renumbered (filename, export name, version literal):\n${state.mapping.map((m) => `  v${m.from} -> v${m.to} ${m.toPath}`).join('\n')}\nGolden regeneration: migrations/records.json follows the renumbered versions.` : '';
      const subject = state.mode === 'unstamp' ? `chore(release): unstamp onto master v${outcome.masterVersion}; versions are written at release`
        : state.mode === 'renumber' ? `chore(migrations): renumber onto master v${outcome.masterVersion}`
        : `v${outcome.version} chore(release): restamp onto master v${outcome.masterVersion}`;
      ctx.git('commit', '--quiet', '-m', `${subject}${body}`);
      committed = ctx.git('rev-parse', 'HEAD').trim();
    }
    rmSync(ctx.statePath, { force: true });
    report(ctx, state, outcome, committed, staged);
    return 0;
  } catch (e) {
    if (e instanceof RestampError) {
      log(e.message);
      return 1;
    }
    throw e;
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
