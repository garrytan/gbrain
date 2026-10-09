/**
 * #6259 (fix wave 12, W1.2): `gbrain quarantine clear` on a managed brain and
 * the `quarantine_override` an operator's --force records.
 *
 * Protects: a managed clear publishes through the canonical owner with the
 * snapshot's expected revision (it used to refuse writer_coordinator_required);
 * --force keeps the page cleared across later writes of the same title, type
 * and body, and any change to them re-arms the gate; a concurrent edit makes
 * the clear a revision conflict, never an overwrite; a pending receipt is not
 * reported as cleared; untrusted writers (remote put_page / put_pages) can
 * neither plant nor renew an override, while a remote edit that leaves the
 * classifier's inputs unchanged keeps it.
 *
 * Named `.serial.test.ts`: it captures console output and sets process env.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { operations } from '../src/core/operations.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { runQuarantine, QUARANTINE_HELP } from '../src/commands/quarantine.ts';
import { getContentFlag, isQuarantined } from '../src/core/quarantine.ts';
import { QUARANTINE_OVERRIDE_KEY } from '../src/core/quarantine-override.ts';
import { FACTS_FENCE_BEGIN, FACTS_FENCE_END } from '../src/core/facts-fence.ts';
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END } from '../src/core/takes-fence.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { activateSharedSkillPersistence } from '../src/core/persistence/skill-activation.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../src/core/cli-force-exit.ts';
import { PENDING_WRITE_EXIT_CODE } from '../src/core/exit-codes.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { withEnv } from './helpers/with-env.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';

const JUNK_BODY = 'Our scraper analysis: the headless browser stopped at a page that said "Cloudflare Ray ID: 8f2a" before any article text.';
const junkPage = (title = 'Scraper notes', body = JUNK_BODY, extra = '') => `---\ntitle: ${title}\ntype: note\n${extra}---\n\n${body}\n`;
const SLUG = 'notes/scraper-notes';

let engine: BrainEngine;
let close: () => Promise<void>;
let home: string;
let root: string;

class Exited extends Error { constructor(readonly code: number | undefined) { super(`process.exit(${code})`); } }
/** Captures console output; a process.exit becomes `exit` instead of ending the test runner. */
async function capture(fn: () => Promise<void>): Promise<{ out: string; err: string; exit?: number }> {
  const [log, error, exit] = [console.log, console.error, process.exit];
  const out: string[] = [], err: string[] = [];
  let code: number | undefined;
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(' ')); };
  console.error = (...a: unknown[]) => { err.push(a.map(String).join(' ')); };
  process.exit = ((c?: number) => { throw new Exited(c); }) as typeof process.exit;
  try { await fn(); } catch (e) { if (!(e instanceof Exited)) throw e; code = e.code; }
  finally { console.log = log; console.error = error; process.exit = exit; }
  return { out: out.join('\n'), err: err.join('\n'), ...(code === undefined ? {} : { exit: code }) };
}
const ctx = (remote = false) => ({ engine, config: { engine: engine.kind, embedding_disabled: true }, sourceId: 'default', remote, dryRun: false,
  deferEmbeds: true, logger: { info() {}, warn() {}, error() {} } }) as unknown as OperationContext;
const frontmatter = async () => (await engine.getPage(SLUG, { sourceId: 'default' }))?.frontmatter as Record<string, unknown>;
const managedPut = async (content: string) => {
  const snapshot = await engine.readPageSnapshot(SLUG, { sourceId: 'default' });
  return submitPageMutation(ctx(), { operation: 'put_page', params: { slug: SLUG, content, request_id: randomUUID(), ...(snapshot ? { expected_revision: snapshot.revision } : {}) } });
};

beforeAll(async () => {
  home = realpathSync.native(mkdtempSync(join(tmpdir(), 'gbrain-quarantine-6259-')));
  ({ engine, close } = await isolatedSharedSkillsEngine());
}, 120_000);
afterAll(async () => {
  await withEnv({ GBRAIN_HOME: home }, async () => { await disposePersistenceConsumer(engine); });
  await close(); rmSync(home, { recursive: true, force: true });
});
beforeEach(() => { _resetCliExitVerdictForTests(); });

describe('quarantine clear on a managed brain (#6259)', () => {
  const run = (fn: () => Promise<void>) => withEnv({ GBRAIN_HOME: home, GBRAIN_AUDIT_DIR: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, fn);

  test('setup: a managed source whose page the gate quarantined', () => run(async () => {
    root = join(home, 'content'); mkdirSync(root);
    await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [root]);
    await claimWorktree(engine, 'default', root, localHostId());
    await activateSharedSkillPersistence(engine, { confirmQuiesced: true });
    await managedPut(junkPage());
    expect(isQuarantined(await frontmatter())).toBe(true);
  }), 120_000);

  test('without --force the gate re-checks the page and it stays quarantined', () => run(async () => {
    const { err, exit } = await capture(() => runQuarantine(engine, ['clear', SLUG]));
    expect(err).not.toContain('writer_coordinator_required');
    expect(isQuarantined(await frontmatter())).toBe(true);
    expect(err).toContain('STILL detected as junk');
    expect(exit).toBe(1);
  }), 120_000);

  test('--force publishes through the owner with a binding override and the page is searchable again', () => run(async () => {
    const { out } = await capture(() => runQuarantine(engine, ['clear', SLUG, '--force']));
    expect(out).toContain(`Cleared "${SLUG}"`);
    const fm = await frontmatter();
    expect(isQuarantined(fm)).toBe(false);
    expect(fm[QUARANTINE_OVERRIDE_KEY]).toMatchObject({ binding: expect.stringMatching(/^[0-9a-f]{64}$/) });
    // The canonical file the owner published carries the override, so a later sync of it keeps the page cleared.
    expect(readFileSync(join(root, `${SLUG}.md`), 'utf8')).toContain(`${QUARANTINE_OVERRIDE_KEY}:`);
  }), 120_000);

  test('writing the same title, type and body again keeps it cleared (the canonical file, re-submitted)', () => run(async () => {
    await managedPut(readFileSync(join(root, `${SLUG}.md`), 'utf8'));
    expect(isQuarantined(await frontmatter())).toBe(false);
  }), 120_000);

  test('a changed title or body expires the override and the gate decides again', () => run(async () => {
    const file = readFileSync(join(root, `${SLUG}.md`), 'utf8');
    await managedPut(file.replace('title: Scraper notes', 'title: Scraper notes, revised'));
    let fm = await frontmatter();
    expect(isQuarantined(fm)).toBe(true);
    expect(fm[QUARANTINE_OVERRIDE_KEY]).toBeUndefined();
    await capture(() => runQuarantine(engine, ['clear', SLUG, '--force']));
    expect(isQuarantined(await frontmatter())).toBe(false);
    await managedPut(readFileSync(join(root, `${SLUG}.md`), 'utf8').replace(JUNK_BODY, `${JUNK_BODY} Another line.`));
    fm = await frontmatter();
    expect(isQuarantined(fm)).toBe(true);
    expect(fm[QUARANTINE_OVERRIDE_KEY]).toBeUndefined();
  }), 120_000);

  test('a managed write the gate quarantines records facts_backstop.skipped quarantined in its receipt', () => run(async () => {
    const body = `${JUNK_BODY} ${'The rest of the note is ordinary prose that would otherwise be long enough to extract. '.repeat(2)}`;
    const response = await submitPageMutation(ctx(), { operation: 'put_page', params: { slug: 'notes/junk-facts', content: junkPage('Junk facts', body), request_id: randomUUID() } }) as Record<string, unknown>;
    expect(response.facts_backstop).toEqual({ skipped: 'quarantined' });
  }), 120_000);

  test('a managed write the gate quarantines projects no facts or takes from its fences', () => run(async () => {
    const FH = '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|---|---|---|---|---|---|---|---|---|';
    const TH = '| # | claim | kind | who | weight | since | source |\n|---|---|---|---|---|---|---|';
    const fences = `${FACTS_FENCE_BEGIN}\n${FH}\n| 1 | Example claim from the page | fact | 1.0 | world | medium | 2026-01-01 |  | chat |  |\n${FACTS_FENCE_END}\n\n${TAKES_FENCE_BEGIN}\n${TH}\n| 1 | Example take from the page | take | brain | 0.7 | 2026-01 | chat |\n${TAKES_FENCE_END}`;
    const slug = 'notes/junk-fences';
    await submitPageMutation(ctx(), { operation: 'put_page', params: { slug, content: junkPage('Junk fences', `${JUNK_BODY}\n\n${fences}`), request_id: randomUUID() } });
    expect(isQuarantined((await engine.getPage(slug, { sourceId: 'default' }))!.frontmatter as Record<string, unknown>)).toBe(true);
    expect(await engine.executeRaw("SELECT id FROM facts WHERE source_markdown_slug=$1", [slug])).toEqual([]);
    expect(await engine.executeRaw('SELECT k.id FROM takes k JOIN pages p ON p.id=k.page_id WHERE p.slug=$1', [slug])).toEqual([]);
  }), 120_000);

  test('a local managed put_page cannot plant gate-owned markers (only the clear\'s owner kind keeps its override)', () => run(async () => {
    const clean = '---\ntitle: Clean notes\ntype: note\nquarantine:\n  reason: junk_pattern\n  detail: planted\natoms_scan_hash: deadbeefdeadbeef\n---\n\nOrdinary prose with nothing junk-like in it.\n';
    const slug = 'notes/planted-managed';
    await submitPageMutation(ctx(), { operation: 'put_page', params: { slug, content: clean, request_id: randomUUID() } });
    const fm = (await engine.getPage(slug, { sourceId: 'default' }))!.frontmatter as Record<string, unknown>;
    expect(fm.quarantine).toBeUndefined();
    expect(fm.atoms_scan_hash).toBeUndefined();
  }), 120_000);

  test('an edit landing after the clear read the page is a revision conflict, not an overwrite', () => run(async () => {
    const original = engine.readPageSnapshot.bind(engine);
    let raced = false, inside = false;
    // Transaction engines inherit from `engine`, so the original's own nested call lands here too: pass it through.
    engine.readPageSnapshot = (async (...args: Parameters<BrainEngine['readPageSnapshot']>) => {
      if (inside) return original(...args);
      inside = true;
      let snapshot: Awaited<ReturnType<BrainEngine['readPageSnapshot']>>;
      try { snapshot = await original(...args); } finally { inside = false; }
      if (!raced && args[0] === SLUG) {
        raced = true;
        delete (engine as { readPageSnapshot?: unknown }).readPageSnapshot;
        await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], async () => {
          const page = (await tx.getPage(SLUG, { sourceId: 'default' }))!;
          await tx.putPage(SLUG, { type: page.type, title: page.title, compiled_truth: `${JUNK_BODY} A concurrent edit.`, frontmatter: page.frontmatter }, { sourceId: 'default' });
        }, TEST_WRITE_ATTRIBUTION));
      }
      return snapshot;
    }) as BrainEngine['readPageSnapshot'];
    try {
      const { err } = await capture(() => runQuarantine(engine, ['clear', SLUG, '--force']));
      expect(err).toContain('revision_conflict');
    } finally { delete (engine as { readPageSnapshot?: unknown }).readPageSnapshot; }
    expect(raced).toBe(true);
    expect((await engine.getPage(SLUG, { sourceId: 'default' }))!.compiled_truth).toContain('A concurrent edit.');
    expect(isQuarantined(await frontmatter())).toBe(true);
    expect(currentExitCode()).toBe(1);
  }), 120_000);

  test('a pending receipt is reported as pending, never as cleared', () => run(async () => {
    await disposePersistenceConsumer(engine);
    const { out, err } = await withEnv({ GBRAIN_WRITE_WAIT_MS: '0' }, () => capture(() => runQuarantine(engine, ['clear', SLUG, '--force'])));
    expect(out).not.toContain('Cleared');
    expect(err).toContain('write_pending');
    expect(err).toContain('Poll: gbrain write-request');
    expect(currentExitCode()).toBe(PENDING_WRITE_EXIT_CODE);
  }), 120_000);

  test('scan --apply refuses on a managed brain and changes nothing', () => run(async () => {
    const before = await engine.executeRaw('SELECT slug,knowledge_revision FROM pages ORDER BY id');
    const { err } = await capture(() => runQuarantine(engine, ['scan', '--apply']));
    expect(err).toContain('writer_coordinator_required');
    expect(err).toContain('passing its slug to gbrain quarantine clear with --force');
    expect(currentExitCode()).toBe(1);
    expect(await engine.executeRaw('SELECT slug,knowledge_revision FROM pages ORDER BY id')).toEqual(before);
  }), 120_000);

  test('help lists the subcommands and flags', () => {
    for (const text of ['list', 'clear <slug>', '--source-id', '--force', '--no-embed', 'scan', '--apply', 'content_sanity.disabled_patterns']) expect(QUARANTINE_HELP).toContain(text);
  });
});

describe('untrusted writers and quarantine_override (#6259)', () => {
  const run = (fn: () => Promise<void>) => withEnv({ GBRAIN_HOME: home, GBRAIN_AUDIT_DIR: home }, async () => {
    const { engine: plain, close: closePlain } = await isolatedSharedSkillsEngine();
    const saved = engine;
    engine = plain;
    try { await fn(); } finally { engine = saved; await closePlain(); }
  });
  const put = async (content: string, remote: boolean) => {
    const snapshot = await engine.readPageSnapshot(SLUG, { sourceId: 'default' });
    return operations.find(o => o.name === 'put_page')!.handler(ctx(remote), { slug: SLUG, content, ...(snapshot ? { expected_revision: snapshot.revision } : {}) });
  };
  const forged = `${QUARANTINE_OVERRIDE_KEY}:\n  binding: ${'a'.repeat(64)}\n  cleared_at: 2026-10-07T00:00:00.000Z\n`;

  test('remote put_page and put_pages cannot plant an override', () => run(async () => {
    await put(junkPage(undefined, undefined, forged), true);
    let fm = await frontmatter();
    expect(isQuarantined(fm)).toBe(true);
    expect(fm[QUARANTINE_OVERRIDE_KEY]).toBeUndefined();
    await operations.find(o => o.name === 'put_pages')!.handler(ctx(true), { request_id: randomUUID(), pages: [
      { slug: 'notes/batch-junk', content: junkPage('Batch notes', JUNK_BODY, forged) }] });
    fm = (await engine.getPage('notes/batch-junk', { sourceId: 'default' }))!.frontmatter as Record<string, unknown>;
    expect(isQuarantined(fm)).toBe(true);
    expect(fm[QUARANTINE_OVERRIDE_KEY]).toBeUndefined();
  }), 120_000);

  test('a remote edit keeps a current override only while title, type and body are unchanged', () => run(async () => {
    await importFromContent(engine, SLUG, junkPage(), { noEmbed: true });
    await capture(() => runQuarantine(engine, ['clear', SLUG, '--force', '--no-embed']));
    const cleared = await frontmatter();
    expect(isQuarantined(cleared)).toBe(false);
    // A tag edit leaves the classifier's inputs unchanged: the stored override carries forward.
    await put(junkPage(undefined, undefined, 'tags: [scraping]\n'), true);
    expect(isQuarantined(await frontmatter())).toBe(false);
    expect((await frontmatter())[QUARANTINE_OVERRIDE_KEY]).toEqual(cleared[QUARANTINE_OVERRIDE_KEY]);
    // A remote body edit cannot renew it.
    await put(junkPage(undefined, `${JUNK_BODY} Remote addition.`, forged), true);
    const fm = await frontmatter();
    expect(isQuarantined(fm)).toBe(true);
    expect(fm[QUARANTINE_OVERRIDE_KEY]).toBeUndefined();
    expect(getContentFlag(fm)).toBeNull();
  }), 120_000);
});
