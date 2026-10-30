/**
 * Value: protects=file-ingestion surfaces name a noncanonical private request as visibility_noncanonical; fails_when=a surface drops holdNoncanonicalPrivate or its fix case.
 * Value: why_new=visibility-noncanonical-hold-7848 drives sync, import and doctor, not validate --importable, the hold fix, the unindexed scan or the streamed import; seam=none; no_claim=sync (covered there).
 *
 * #7848 surfaces beside sync and import: `gbrain frontmatter validate --importable` (what a pre-commit hook sees), the hold's
 * next step and fault class, the unindexed-files scan that finds committed files an older release never held, and the
 * streamed (segmented-body) import, including a local page write that streams without an upload session.
 * PGLite only; the sync and import paths live in test/visibility-noncanonical-hold-7848.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { runFrontmatter } from '../src/commands/frontmatter.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { readPageBodyPolicy } from '../src/core/page-body/limits.ts';
import { importStreamedMarkdownFile } from '../src/core/page-body/streamed-import.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { gitHoldFix } from '../src/core/persistence/sync-holds.ts';
import { classifySyncFault } from '../src/core/persistence/sync-fault-class.ts';
import { findUnindexedFiles } from '../src/core/persistence/unindexed-files.ts';
import { withEnv } from './helpers/with-env.ts';

const note = (extra: string) => `---\ntitle: Note\ntype: note\n${extra}---\nA note about acme-example.\n`;
const UPPER = note('Visibility: Private\n');
const CANONICAL = note('visibility: private\n');

async function validateImportable(content: string): Promise<{ hold?: { code?: string } | null }> {
  const logOrig = console.log;
  const prevExitCode = process.exitCode;
  const out: string[] = [];
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(' ')); };
  try { await runFrontmatter(['validate', '--stdin', '--importable', '--json'], { stdin: Readable.from([Buffer.from(content)]) }); } finally { console.log = logOrig; process.exitCode = prevExitCode ?? 0; }
  const result = JSON.parse(out.join('\n')).results[0];
  return { hold: result.hold };
}

describe('#7848 surfaces beside sync and import', () => {
  let engine: PGLiteEngine;
  const home = mkdtempSync(join(tmpdir(), 'gbrain-7848-surfaces-'));
  beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
  afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });

  test('validate --importable names visibility_noncanonical for a noncanonical private request and passes a canonical one', async () => {
    expect((await validateImportable(UPPER)).hold).toMatchObject({ code: 'visibility_noncanonical' });
    expect((await validateImportable(CANONICAL)).hold ?? null).toBeNull();
  });

  test('the hold is a user-owned fix that names the lowercase line, and the fault table needs a human for it', () => {
    const fix = gitHoldFix({ source_id: 'source-a', path: 'notes/upper.md', slug: 'notes/upper', code: 'visibility_noncanonical', meta: {} } as Parameters<typeof gitHoldFix>[0]);
    expect(fix).toMatchObject({ actor: 'user', consent: [] });
    expect(fix.user_message).toContain('visibility: private');
    expect(fix.user_message).toContain('gbrain sync --source source-a --no-pull');
    expect(classifySyncFault({ code: 'visibility_noncanonical' })).toMatchObject({ class: 'page', needs_human: true, safe_actions: ['none'] });
  });

  test('the unindexed-files scan screens a committed file that asks for private noncanonically as visibility_noncanonical, not clean', () => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home }, async () => {
    const repo = join(home, 'repo');
    mkdirSync(join(repo, 'notes'), { recursive: true });
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init', '-q');
    writeFileSync(join(repo, 'notes/upper.md'), UPPER);
    writeFileSync(join(repo, 'notes/canonical.md'), CANONICAL);
    git('add', '-A'); git('-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'content');
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw("INSERT INTO sources(id,name,local_path,config,last_commit) VALUES('source-a','source-a',$1,'{}',$2)", [repo, git('rev-parse', 'HEAD')]);
    await claimWorktree(engine, 'source-a', repo);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const scan = await findUnindexedFiles(engine, 'source-a');
    expect(scan.files.map(file => [file.path, file.code]).sort()).toEqual([['notes/canonical.md', 'clean'], ['notes/upper.md', 'visibility_noncanonical']]);
  }), 120_000);

  test('the streamed (segmented-body) import holds a noncanonical private request, a local page write streaming without an upload session included, and stores the fixed file private', async () => {
    const path = join(home, 'upper-large.md');
    const body = '\n' + 'A line about acme-example.\n'.repeat(2000);
    writeFileSync(path, UPPER + body);
    const policy = { ...(await readPageBodyPolicy(engine)), segmented: true };
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    try {
      expect(await importStreamedMarkdownFile(engine, path, 'notes/upper-large.md', { noEmbed: true }, statSync(path), policy))
        .toMatchObject({ status: 'skipped', skip_reason: 'visibility_noncanonical' });
      expect(await importStreamedMarkdownFile(engine, path, 'notes/upper-large.md', { noEmbed: true, inferFrontmatter: false, content: {} }, statSync(path), policy))
        .toMatchObject({ status: 'skipped', skip_reason: 'visibility_noncanonical' });
      expect(await engine.getPage('notes/upper-large')).toBeNull();
      writeFileSync(path, CANONICAL + body);
      expect((await importStreamedMarkdownFile(engine, path, 'notes/upper-large.md', { noEmbed: true }, statSync(path), policy)).status).not.toBe('skipped');
      expect((await engine.getPage('notes/upper-large'))?.frontmatter).toMatchObject({ visibility: 'private' });
    } finally {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    }
  }, 120_000);
});
