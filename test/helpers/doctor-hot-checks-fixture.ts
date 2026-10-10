/**
 * Fixture brain for the doctor hot-check goldens (GBRA-75 wave 10): a Git
 * source whose files and stored rows exercise every finding of
 * `frontmatter_integrity`, `frontmatter_repairable`, the `timeline_history`
 * group and `fence_integrity`, built through the CLI plus a few direct SQL
 * edits (database-only timeline rows, a stored page with a malformed fence).
 * Shared by the PGLite golden (test/doctor-hot-checks-golden.test.ts) and its
 * Postgres twin (test/e2e/doctor-hot-checks-golden.test.ts).
 *
 * Synthetic content only.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runGbrain, type DoctorHome, type GbrainRun } from './doctor-json-golden.ts';

/** Runs the statements in one transaction against the brain's database (the CLI holds no connection between calls). */
export type Sql = (statements: Array<[string, unknown[]]>) => Promise<void>;

/** `Sql` for a PGLite brain on disk: opens it for one transaction while no CLI process holds it. */
export function pgliteSql(databasePath: string): Sql {
  return async (statements) => {
    const engine = new PGLiteEngine();
    await engine.connect({ database_path: databasePath });
    try {
      await engine.transaction(async (tx) => { for (const [q, p] of statements) await tx.executeRaw(q, p); });
    } finally {
      await engine.disconnect();
    }
  };
}

const FB = '<!--- gbrain:facts:begin -->', FE = '<!--- gbrain:facts:end -->';
const FH = '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|---|---|---|---|---|---|---|---|---|';
const T = '<!--- gbrain:takes:begin -->', TE = '<!--- gbrain:takes:end -->';
const TH = '| # | claim | kind | who | weight | since | source |\n|---|---|---|---|---|---|---|';
const row = (n: number, claim: string) => `| ${n} | ${claim} | fact | 1.0 | private | medium | 2026-01-01 |  | call |  |`;
/** Facts fence with no end marker: Tier 1 closes it. */
const DETERMINISTIC_FENCE = `${FB}\n${FH}\n${row(1, 'Synthetic fact')}\n${row(2, 'Second synthetic fact')}\n\n`;
/** Facts fence with no header row: model tier. */
const LLM_FENCE = `${FB}\n${row(1, 'Synthetic fact')}\n${row(2, 'Another synthetic fact')}\n${FE}\n`;
/** Takes fence with an unknown kind: manual. */
const MANUAL_FENCE = `${T}\n${TH}\n| 1 | Synthetic take | sentinelkind | brain | 0.7 | 2026-01 | chat |\n${TE}\n`;
const CLEAN_FENCE = `${FB}\n${FH}\n${row(1, 'Clean synthetic fact')}\n${FE}\n`;

const fm = (title: string, type = 'note') => ['---', `title: ${title}`, `type: ${type}`, '---'].join('\n');

/** Committed and imported before doctor runs. */
const IMPORTED: Record<string, string> = {
  'people/alice-example.md': `${fm('Alice Example', 'person')}\n# Alice Example\n\nAlice works with [[acme-example]].\n\n## Facts\n\n${CLEAN_FENCE}\n## Timeline\n\n- **2024-03-05** | Joined Acme\n- **2024-04-10** | Promoted\n`,
  'companies/acme-example.md': `${fm('Acme Example', 'company')}\n# Acme Example\n\nAcme raised a round.\n\n## Timeline\n\n- **2024-02-01** | Raised a round\n`,
  'notes/timeline-a.md': `${fm('Timeline A')}\nBody A.\n\n## Timeline\n\n- **2024-05-01** | Event A happened\n`,
  'notes/timeline-b.md': `${fm('Timeline B')}\nBody B.\n\n## Timeline\n\n- **2024-05-02** | Event B happened\n`,
  'notes/stored-fence.md': `${fm('Stored Fence')}\nA page whose stored copy gets a malformed fence.\n`,
  'notes/crlf.md': ['---', 'title: Crlf', '---', 'Line one [[acme-example]]', ''].join('\r\n'),
  'notes/leading-blank.md': `\n\n${fm('Leading Blank')}\nBody after blank lines.\n`,
};

/** Written after the import, so only the filesystem readers (and the sync) see them. */
const ON_DISK: Record<string, string> = {
  'fm/missing-open.md': 'No frontmatter here.\n',
  'fm/empty-file.md': '   \n',
  'fm/missing-close.md': '---\ntitle: Missing Close\n# Heading\nBody.\n',
  'fm/empty-frontmatter.md': '---\n---\nBody.\n',
  'fm/nested-quotes.md': '---\ntitle: "Name "Nick" Last"\n---\nBody.\n',
  'fm/needs-interpretation.md': '---\ntitle: [unclosed\ntags: a: b\n---\nBody.\n',
  'fm/recoverable-colon.md': '---\ntitle: Ratio: 3:1 split\ntype: note\n---\nBody.\n',
  'fm/duplicate-key.md': '---\ntitle: One\ntitle: Two\n---\nBody.\n',
  'fm/slug-mismatch.md': '---\ntitle: Slug Mismatch\nslug: somewhere-else\n---\nBody.\n',
  'fm/slug-equivalent.md': '---\ntitle: Slug Equivalent\nslug: FM/Slug-Equivalent\n---\nBody.\n',
  'fm/non-string.md': '---\ntitle: 123\ntype: 2024\n---\nBody.\n',
  'fm/comment-value.md': '---\ntitle: #hashtag title\n---\nBody.\n',
  'fm/bom.md': '\uFEFF---\ntitle: Bom\n---\nBody.\n',
  'fm/language.md': '---yaml\ntitle: Language\n---\nBody.\n',
  'fm/indented-close.md': '---\ntitle: Indented\n  ---\nBody\n---\nMore.\n',
  'fm/dash-line.md': '---\ntitle: Dash\n---x\n---\nBody.\n',
  'fm/protected-unclosed.md': '---\nslug: x\ntitle: Protected\n',
  'fences/deterministic.md': `${fm('Deterministic Fence')}\n## Facts\n\n${DETERMINISTIC_FENCE}`,
  'fences/llm.md': `${fm('Llm Fence')}\n## Facts\n\n${LLM_FENCE}`,
  'fences/manual.md': `${fm('Manual Fence')}\n## Takes\n\n${MANUAL_FENCE}`,
};

/** Untracked (a stored NUL byte fails the sync's write, so these never reach it): only the working-tree readers see them. */
const UNTRACKED: Record<string, string> = {
  'fm/untracked-yaml.md': '---\ntitle: [unclosed\n---\nBody.\n',
  'fm/null-bytes.md': '---\ntitle: Null Bytes\n---\nBody \u0000 here.\n',
  'fm/null-in-frontmatter.md': '---\ntitle: Null\u0000 Front\n---\nBody.\n',
  'fm/image.png': 'not really a png \u0000',
};

/** A plain directory source (no Git): the pruned walk and the mtime-based census. */
const PLAIN: Record<string, string> = {
  'clean.md': `${fm('Plain Clean')}\nBody.\n`,
  'broken.md': '---\ntitle: [unclosed\n---\nBody.\n',
  'fence.md': `${fm('Plain Fence')}\n## Facts\n\n${DETERMINISTIC_FENCE}`,
  'node_modules/pkg/broken.md': '---\ntitle: [pruned\n---\n',
  '.hidden/broken.md': '---\ntitle: [pruned\n---\n',
};

const FIXED_DATE = '2024-01-01T00:00:00Z';

function writeAll(dir: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
}

function git(dir: string, ...args: string[]): void {
  const env = { ...process.env, GIT_AUTHOR_DATE: FIXED_DATE, GIT_COMMITTER_DATE: FIXED_DATE, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  execFileSync('git', ['-C', dir, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', ...args], { env, stdio: 'ignore' });
}

async function gbrain(h: DoctorHome, args: string[]): Promise<GbrainRun> {
  const run = await runGbrain(h, args);
  if (run.exitCode !== 0) throw new Error(`gbrain ${args.join(' ')} failed (${run.exitCode}): ${run.stderr}`);
  return run;
}

/**
 * Builds the fixture on an initialized brain (`init` already ran) and returns
 * nothing; doctor runs next.
 */
export async function buildHotCheckFixture(h: DoctorHome, sql: Sql): Promise<void> {
  const src = join(h.home, 'notes-src');
  writeAll(src, IMPORTED);
  git(src, 'init', '-q', '-b', 'main');
  git(src, 'add', '-A');
  git(src, 'commit', '-q', '-m', 'fixture');
  await gbrain(h, ['sources', 'add', 'notes', '--path', src, '--federated', '--force']);
  await gbrain(h, ['import', src, '--no-embed', '--source-id', 'notes']);
  await gbrain(h, ['extract', 'all', '--source', 'db']);
  const plain = join(h.home, 'plain-src');
  writeAll(plain, { 'clean.md': PLAIN['clean.md']! });
  await gbrain(h, ['sources', 'add', 'plain', '--path', plain, '--federated', '--force']);
  await gbrain(h, ['import', plain, '--no-embed', '--source-id', 'plain']);
  writeAll(plain, PLAIN);

  // Committed but not synced: the sync holds what it refuses; the rest waits in the checkout.
  writeAll(src, ON_DISK);
  git(src, 'add', '-A');
  git(src, 'commit', '-q', '-m', 'broken files');
  await runGbrain(h, ['sync', '--source', 'notes', '--no-pull', '--no-embed']);
  // After the sync (a full catch-up re-imports changed pages): database-only timeline rows, one materializable and one that cannot round-trip (comment markup).
  const insert = `INSERT INTO timeline_entries(page_id,date,source,summary,detail)
    SELECT id, $2::date, $3, $4, '' FROM pages WHERE slug = $1 AND source_id = 'notes'`;
  await sql([
    ["SELECT set_config('gbrain.write_sources', $1, true)", [JSON.stringify(['notes'])]],
    [insert, ['notes/timeline-a', '2024-06-01', 'legacy', 'A database-only event']],
    [insert, ['notes/timeline-b', '2024-06-02', 'legacy', 'Hidden <!-- markup --> event']],
    // A stored page whose fence is malformed (the file stays clean).
    [`UPDATE pages SET compiled_truth = compiled_truth || $2 WHERE slug = $1 AND source_id = 'notes'`, ['notes/stored-fence', `\n\n## Facts\n\n${DETERMINISTIC_FENCE}`]],
    // Planner estimates (doctor's "~N request row(s)") are exact, not whatever Postgres autovacuum last sampled.
    ['ANALYZE', []],
  ]);
  writeAll(src, { ...UNTRACKED, 'fences/untracked.md': `${fm('Untracked Fence')}\n## Facts\n\n${DETERMINISTIC_FENCE}` });
}

/**
 * Edits between the first and second doctor run, so the second run takes the
 * incremental paths (changed-file census pass, resumed timeline state): one
 * waiting fence fixed, one new broken file, one new database-only row.
 */
export async function editHotCheckFixture(h: DoctorHome, sql: Sql): Promise<void> {
  const src = join(h.home, 'notes-src');
  writeAll(src, {
    'fences/untracked.md': `${fm('Untracked Fence')}\n## Facts\n\n${CLEAN_FENCE}`,
    'fm/late-broken.md': '---\ntitle: "Late "Broken" One"\n---\nBody.\n',
    'fences/late.md': `${fm('Late Fence')}\n## Takes\n\n${MANUAL_FENCE}`,
  });
  await sql([
    ["SELECT set_config('gbrain.write_sources', $1, true)", [JSON.stringify(['notes'])]],
    [`INSERT INTO timeline_entries(page_id,date,source,summary,detail)
      SELECT id, '2024-07-01', 'legacy', 'A later database-only event', '' FROM pages WHERE slug = 'companies/acme-example' AND source_id = 'notes'`, []],
    ['ANALYZE', []],
  ]);
}
