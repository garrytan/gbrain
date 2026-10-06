/**
 * Pure helpers for `bun run release:restamp` (scripts/release-restamp.ts):
 * version arithmetic, CHANGELOG entry capture and re-insertion, version-stamp
 * rewriters for the CLAUDE.md "Version locations" table, schema-migration
 * renumbering with a payload identity check, the leftover-reference scan, and
 * version-only merge-conflict hunk resolution. No git, no filesystem, no
 * database: the CLI owns every side effect.
 */
import ts from 'typescript';
import { normalizeTokens } from './normalize-tokens.ts';

export const RESTAMP_DOCS = 'docs/RELEASING.md#release-restamp';
export const COLLISION_DOCS = 'docs/TESTING.md#schema-migration-registry';

export class RestampError extends Error {}

/** FAIL/Why/Fix/See block (agent operator protocol); thrown, printed by the CLI. */
export function fail(what: string, why: string, fix: string | string[], see = RESTAMP_DOCS): never {
  const fixLines = Array.isArray(fix) ? fix : [fix];
  throw new RestampError([`FAIL: ${what}`, `Why:  ${why}`, ...fixLines.map((l, i) => `${i === 0 ? 'Fix:  ' : '      '}${l}`), `See:  ${see}`].join('\n'));
}

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?(?:-[0-9A-Za-z.-]+)?$/;

/** master's MAJOR.MINOR.(PATCH+1).0 */
export function nextPatchVersion(masterVersion: string): string {
  const m = VERSION_RE.exec(masterVersion.trim());
  if (!m) {
    fail(`master's VERSION "${masterVersion.trim()}" is not MAJOR.MINOR.PATCH.MICRO`,
      'restamp derives the branch version from master\'s VERSION file.',
      'fix VERSION on master first (CLAUDE.md "Version locations"), then rerun: bun run release:restamp');
  }
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}.0`;
}

// ---------------------------------------------------------------- CHANGELOG

export interface ChangelogSection { header: string; text: string }

/** Split a Keep-a-Changelog file into the preamble and `## [` sections (each section text keeps its header line). */
export function splitChangelog(text: string): { preamble: string; sections: ChangelogSection[] } {
  const lines = text.split('\n');
  const starts = lines.flatMap((l, i) => (l.startsWith('## [') ? [i] : []));
  if (starts.length === 0) return { preamble: text, sections: [] };
  const preamble = lines.slice(0, starts[0]).join('\n');
  const sections = starts.map((s, k) => {
    const end = k + 1 < starts.length ? starts[k + 1]! : lines.length;
    return { header: lines[s]!, text: lines.slice(s, end).join('\n') };
  });
  return { preamble, sections };
}

/**
 * The branch's own CHANGELOG entry: the sections above the merge base's top
 * section header. Returns [] when the branch has not written one yet.
 */
export function branchEntrySections(branchText: string, baseText: string): ChangelogSection[] {
  const baseTop = splitChangelog(baseText).sections[0]?.header;
  const branch = splitChangelog(branchText).sections;
  if (!baseTop) return [];
  const idx = branch.findIndex((s) => s.header === baseTop);
  if (idx < 0) {
    fail(`CHANGELOG.md on this branch no longer contains the merge base's top entry "${baseTop}"`,
      'restamp finds the branch\'s own entry as the sections above the newest entry the branch shares with master; a rewritten or reordered master entry hides it.',
      ['restore master\'s entries (git checkout origin/master -- CHANGELOG.md, then re-add only your entry on top), commit,',
        'then rerun: bun run release:restamp']);
  }
  return branch.slice(0, idx);
}

export function versionOfHeader(header: string): string | null {
  return /^## \[([^\]]+)\]/.exec(header)?.[1] ?? null;
}

function replaceVersionToken(text: string, oldVersion: string, newVersion: string): string {
  if (!/^\d+(?:\.\d+){2,3}(?:-[A-Za-z0-9]+)?$/.test(oldVersion)) throw new Error(`restamp: refusing to rewrite a non-numeric version token '${oldVersion}'`);
  const esc = oldVersion.replace(/\./g, '\\.');
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- oldVersion is validated above as dotted digits (optional alphanumeric suffix) and its dots escaped, so the pattern is a fixed literal with bounded lookarounds (no ReDoS)
  return text.replace(new RegExp(`(?<![\\d.])${esc}(?![\\d.]*\\d)`, 'g'), newVersion);
}

/**
 * Put the branch entry back on top of `currentText` (the merged CHANGELOG),
 * re-stamped: header `## [new] - date`, every other mention of the branch's
 * old version inside the entry rewritten. A copy of the entry already in
 * `currentText` (a clean merge kept it, or an earlier restamp pass wrote it)
 * is removed first, so the rebuild is idempotent.
 */
export function rebuildChangelog(currentText: string, entry: ChangelogSection, oldVersion: string, newVersion: string, date: string): string {
  const { preamble, sections } = splitChangelog(currentText);
  const bodyOf = (text: string) => text.split('\n').slice(1).join('\n').replace(/\n+$/, '');
  const body = replaceVersionToken(bodyOf(entry.text), oldVersion, newVersion);
  const ours = new Set([bodyOf(entry.text), body]);
  const rest = sections.filter((s) => {
    const v = versionOfHeader(s.header);
    return !((v === oldVersion || v === newVersion) && ours.has(bodyOf(s.text)));
  });
  const stamped = `## [${newVersion}] - ${date}\n${body}\n`;
  return [preamble, stamped, ...rest.map((s) => s.text)].join('\n');
}

// ---------------------------------------------------------------- stamps

export interface Stamp {
  file: string;
  read(text: string): string | null;
  write(text: string, version: string): string;
}

function jsonVersionStamp(file: string): Stamp {
  return {
    file,
    read: (text) => {
      try {
        const v = (JSON.parse(text) as { version?: unknown }).version;
        return typeof v === 'string' ? v : null;
      } catch {
        return null;
      }
    },
    write(text, version) {
      const current = this.read(text);
      if (current === null) fail(`${file} has no top-level "version" string`, 'restamp rewrites that field in place.', `add "version": "${version}" to ${file}, then rerun with --continue`);
      return text.replace(`"version": "${current}"`, `"version": "${version}"`);
    },
  };
}

const RUNBOOK_STAMP = /<!-- gbrain-runbook-stamp: ([^ ]+) -->/;

/**
 * Hand-maintained rows of the CLAUDE.md "Version locations" Required table
 * (CHANGELOG.md, TODOS.md and the generated template repo are handled by the
 * CLI). test/scripts/release-restamp.test.ts fails when the table names a file
 * restamp does not cover.
 */
export const STAMPS: Stamp[] = [
  {
    file: 'VERSION',
    read: (text) => text.trim() || null,
    write: (text, version) => `${version}${text.endsWith('\n') ? '\n' : ''}`,
  },
  jsonVersionStamp('package.json'),
  jsonVersionStamp('openclaw.plugin.json'),
  jsonVersionStamp('.codex-plugin/plugin.json'),
  jsonVersionStamp('.claude-plugin/plugin.json'),
  {
    file: 'BOOTSTRAP_FOR_AGENTS.md',
    read: (text) => RUNBOOK_STAMP.exec(text)?.[1] ?? null,
    write: (text, version) => {
      if (!RUNBOOK_STAMP.test(text)) fail('BOOTSTRAP_FOR_AGENTS.md has no <!-- gbrain-runbook-stamp: X.Y.Z.W --> line', 'scripts/check-bootstrap-tag.sh requires it to equal VERSION.', `restore line 1 as <!-- gbrain-runbook-stamp: ${version} -->, then rerun with --continue`);
      return text.replace(RUNBOOK_STAMP, `<!-- gbrain-runbook-stamp: ${version} -->`);
    },
  },
];

/** Files restamp keeps in step beyond STAMPS (named so the coverage test can match the CLAUDE.md table). */
export const OTHER_STAMPED_FILES = ['CHANGELOG.md', 'TODOS.md', 'templates/bootstrap/template-repo/'];

/** Rewrite `vOLD` to `vNEW` in branch-added TODOS.md lines (1-based line numbers). */
export function restampTodoLines(text: string, addedLines: Set<number>, oldVersion: string, newVersion: string): string {
  if (oldVersion === newVersion) return text;
  return text.split('\n').map((l, i) => (addedLines.has(i + 1) ? l.split(`v${oldVersion}`).join(`v${newVersion}`) : l)).join('\n');
}

// ---------------------------------------------------------------- migrations

export const MIGRATIONS_DIR = 'src/core/schema-migrations';
export const MIGRATION_FILE_RE = /^v(\d{3,})-([a-z0-9]+(?:-[a-z0-9]+)*)\.ts$/;

export function padVersion(version: number): string {
  return String(version).padStart(3, '0');
}

interface MigrationLiteral { exportName: string; exportStart: number; version: number; versionStart: number; versionEnd: number }

function migrationLiteral(text: string, file: string): MigrationLiteral {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt) || !stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    for (const d of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || !d.initializer || !ts.isObjectLiteralExpression(d.initializer) || d.type?.getText(sf) !== 'Migration') continue;
      for (const p of d.initializer.properties) {
        if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'version' && ts.isNumericLiteral(p.initializer)) {
          return { exportName: d.name.text, exportStart: d.name.getStart(sf), version: Number(p.initializer.text), versionStart: p.initializer.getStart(sf), versionEnd: p.initializer.getEnd() };
        }
      }
    }
  }
  return fail(`${file} has no \`export const v<NNN>: Migration = { version: <NNN>, ... }\``,
    'restamp renumbers a migration by rewriting exactly its export name and version literal.',
    `fix the file so bun run build:schema-migrations accepts it, then rerun: bun run release:restamp`, COLLISION_DOCS);
}

/** Rewrite only the export identifier and the `version:` literal. */
export function renumberMigrationText(text: string, file: string, newVersion: number): string {
  const lit = migrationLiteral(text, file);
  const exportEnd = lit.exportStart + lit.exportName.length;
  return text.slice(0, lit.exportStart) + `v${padVersion(newVersion)}` + text.slice(exportEnd, lit.versionStart) + String(newVersion) + text.slice(lit.versionEnd);
}

/**
 * Payload identity key: the comment- and whitespace-insensitive token stream
 * with the export name and version literal replaced, so the same migration
 * under two numbers has the same key and any other edit changes it.
 */
export function migrationPayloadKey(text: string, file: string): string {
  const lit = migrationLiteral(text, file);
  const exportEnd = lit.exportStart + lit.exportName.length;
  const neutral = text.slice(0, lit.exportStart) + '__restamp_export__' + text.slice(exportEnd, lit.versionStart) + '0' + text.slice(lit.versionEnd);
  return normalizeTokens(neutral).join(' ');
}

export interface BranchMigration { path: string; version: number; slug: string }
export interface Renumber { from: BranchMigration; toVersion: number; toPath: string }

/** Branch migrations, in original version order, renumbered consecutively from masterMax + 1. */
export function planRenumber(branch: BranchMigration[], masterMax: number): Renumber[] {
  return [...branch]
    .sort((a, b) => a.version - b.version)
    .map((m, i) => ({ from: m, toVersion: masterMax + 1 + i, toPath: `${MIGRATIONS_DIR}/v${padVersion(masterMax + 1 + i)}-${m.slug}.ts` }))
    .filter((r) => r.toVersion !== r.from.version);
}

// ---------------------------------------------------------------- leftover references

export interface AddedLine { file: string; line: number; text: string }
export interface LeftoverRef extends AddedLine { oldVersion: number }

/** Generated or regenerated paths: never scanned for leftover references. */
export const GENERATED_PATHS = [
  `${MIGRATIONS_DIR}/registry.generated.ts`,
  'test/fixtures/goldens/migrations/records.json',
  'llms.txt',
  'llms-full.txt',
  'bun.lock',
  'plugin/',
  'plugin-variants/',
  'templates/bootstrap/template-repo/',
];

export function isGenerated(path: string): boolean {
  return GENERATED_PATHS.some((g) => (g.endsWith('/') ? path.startsWith(g) : path === g));
}

/** Migration-reference shapes restamp lists (never rewrites): `v209`, `v209-name`, `migration 209`, `schema_version ... 209`, `version: 209`. */
export function referencePatterns(oldVersion: number): RegExp[] {
  if (!Number.isSafeInteger(oldVersion) || oldVersion < 0) throw new Error(`restamp: migration number must be a non-negative integer, got ${oldVersion}`);
  const n = String(oldVersion);
  return [
    // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- n is a validated non-negative integer (digits only), so the pattern is fixed
    new RegExp(`\\bv0*${n}\\b`),
    // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- same: digits only, bounded {0,12} gap
    new RegExp(`\\b(?:migrations?|schema[_ ]version|LATEST_VERSION|version)\\b[^0-9\\n]{0,12}\\b${n}\\b`, 'i'),
  ];
}

const OWN_CONSTANT_LINE = /^\s*(?:version:\s*\d+,?|export const v\d{3,}: Migration = \{)\s*$/;

/** Branch-added lines that still reference a renumbered migration's old number. */
export function findLeftoverRefs(added: AddedLine[], oldVersions: number[], renamedPaths: Set<string>): LeftoverRef[] {
  const out: LeftoverRef[] = [];
  for (const l of added) {
    if (isGenerated(l.file)) continue;
    if (renamedPaths.has(l.file) && OWN_CONSTANT_LINE.test(l.text)) continue;
    for (const v of oldVersions) {
      if (referencePatterns(v).some((re) => re.test(l.text))) {
        out.push({ ...l, oldVersion: v });
        break;
      }
    }
  }
  return out;
}

/** Parse `git diff -U0` output into the added lines with their new-file line numbers. */
export function parseAddedLines(diff: string): AddedLine[] {
  const out: AddedLine[] = [];
  let file = '';
  let line = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) {
      file = raw === '+++ /dev/null' ? '' : raw.slice(4).replace(/^b\//, '');
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith('+') && file) {
      out.push({ file, line, text: raw.slice(1) });
      line++;
    }
  }
  return out;
}

// ---------------------------------------------------------------- merge conflicts

const ANY_VERSION = /\d+\.\d+\.\d+(?:\.\d+)?/g;

/**
 * Resolve conflict hunks whose two sides differ only in version strings
 * (keep ours: the stamps are rewritten right after). Returns the text and the
 * number of hunks left unresolved (their markers stay in place).
 */
export function resolveVersionOnlyHunks(text: string): { text: string; unresolved: number } {
  const lines = text.split('\n');
  const out: string[] = [];
  let unresolved = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]!.startsWith('<<<<<<< ')) {
      out.push(lines[i]!);
      continue;
    }
    const start = i;
    const ours: string[] = [];
    const theirs: string[] = [];
    let section: 'ours' | 'base' | 'theirs' = 'ours';
    for (i++; i < lines.length && !lines[i]!.startsWith('>>>>>>> '); i++) {
      const l = lines[i]!;
      if (section === 'ours' && l.startsWith('||||||| ')) section = 'base';
      else if (section !== 'theirs' && l === '=======') section = 'theirs';
      else if (section === 'ours') ours.push(l);
      else if (section === 'theirs') theirs.push(l);
    }
    const norm = (side: string[]) => side.join('\n').replace(ANY_VERSION, '<v>');
    if (norm(ours) === norm(theirs)) out.push(...ours);
    else {
      unresolved++;
      out.push(...lines.slice(start, i + 1));
    }
  }
  return { text: out.join('\n'), unresolved };
}
