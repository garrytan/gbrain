/**
 * Every write that stores a trust-table row (pages, facts, takes, timeline_entries) declares who wrote it.
 *
 * The tier trigger stamps a row `unknown` when its writer declared nothing (withWriteTrust, a coordinated write's
 * declaration, a keep or backfill scope), and `unknown` sits below `agent_written`: a write path that forgot to declare
 * silently stores its rows at the wrong tier (#9209 and #9457 each fixed one such path). These tests install the strict
 * trigger function (a test-only variant that RAISEs `undeclared_write_trust` where the real one would store `unknown`)
 * and drive the write paths, so a path that stops declaring fails here by name.
 *
 * Three layers:
 *   1. the strict seam itself (what it raises on, what it lets through, and that the real function is unchanged);
 *   2. every mutating operation of the operation manifest, on an unmanaged brain and on a managed one, or an explicit
 *      reason it writes no trust-table row;
 *   3. the non-operation write paths (file and content imports, receipts, timeline extraction, soft deletes), plus a
 *      source scan that refuses a new importFromContent caller that declares nothing.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { operationsByName } from '../src/core/operations.ts';
import { OPERATION_MANIFEST } from '../src/core/operation-manifest.generated.ts';
import { importFromContent, importFromFile } from '../src/core/import-file.ts';
import { restoreRedactedRows } from '../src/core/repair/redacted-facts.ts';
import { keepTierTransaction, maintenanceTransaction } from '../src/core/persistence/attribution.ts';
import { withTrustKeep, withWriteTrust } from '../src/core/persistence/context.ts';
import { writeReceipt } from '../src/core/extract/receipt-writer.ts';
import { extractTimelineFromDB } from '../src/commands/extract-timeline-db.ts';
import { agentVerbTrust } from '../src/core/trust/channel.ts';
import { derivedWriteTrust } from '../src/core/trust/taint.ts';
import { publishExtractedFacts, type ExtractedFactsRequest } from '../src/core/generations/adapters/extracted-facts.ts';
import { GUEST_FAIL_CLOSED_STAMP_TIER_FUNCTION } from '../src/core/trust/schema.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { installStrictWriteTrust, isUndeclaredWriteTrust, UNDECLARED_WRITE_TRUST } from './helpers/strict-write-trust.ts';

const FIXTURE = { tier: 'operator_curated' as const, origin: { channel: 'test:fixture' } };
const logger = { info() {}, warn() {}, error() {} };
const note = (title: string, body: string) => `---\ntype: note\ntitle: ${title}\n---\n\n${body}\n`;

/** Seeds fixture rows as a declared owner write, so the code under test is the only undeclared writer in a test. */
const seed = <T>(engine: BrainEngine, fn: (tx: BrainEngine) => Promise<T>): Promise<T> => maintenanceTransaction(engine, fn, FIXTURE);

/**
 * Runs one write path and names it when the strict trigger refuses it: the failure of this guard reads
 * `undeclared write trust in <path>: <the trigger's message and the refused statement>`.
 */
async function drive<T>(path: string, run: () => Promise<T>): Promise<T> {
  try { return await run(); }
  catch (error) {
    if (!isUndeclaredWriteTrust(error)) throw error;
    const cause = (error as { cause?: { detail?: unknown } }).cause;
    const detail = String((error as { detail?: unknown }).detail ?? cause?.detail ?? '');
    throw new Error(`undeclared write trust in ${path}: ${(error as Error).message} ${detail}`, { cause: error });
  }
}

/** Connects `engine` (made by the caller's beforeAll) with the strict trigger function installed. */
async function strictEngine(engine: PGLiteEngine): Promise<PGLiteEngine> {
  await engine.connect({});
  await engine.initSchema();
  await installStrictWriteTrust(engine);
  return engine;
}
const opContext = (engine: BrainEngine) => ({ engine, config: { engine: engine.kind, embedding_disabled: true }, sourceId: 'default', remote: false, dryRun: false, logger });
const tierOf = async (engine: BrainEngine, slug: string) => (await engine.executeRaw<{ trust_tier: string }>('SELECT trust_tier FROM pages WHERE slug=$1', [slug]))[0]?.trust_tier;

describe('the strict seam', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => { engine = await strictEngine(new PGLiteEngine()); });
  afterAll(async () => { await engine.disconnect(); });

  test('an undeclared insert raises, naming the table and the statement', async () => {
    const error = await engine.putPage('seam/undeclared', { type: 'note', title: 'u', compiled_truth: 'body' }).then(() => null, e => e);
    expect(isUndeclaredWriteTrust(error)).toBe(true);
    expect(String(error.message)).toContain(`${UNDECLARED_WRITE_TRUST}: an INSERT on pages`);
  });

  test('a declared insert stores the declared tier', async () => {
    await seed(engine, tx => tx.putPage('seam/declared', { type: 'note', title: 'd', compiled_truth: 'body' }));
    expect(await tierOf(engine, 'seam/declared')).toBe('operator_curated');
  });

  test('an undeclared content rewrite raises, and a keep scope or a non-content update does not', async () => {
    await seed(engine, tx => tx.putPage('seam/rewrite', { type: 'note', title: 'r', compiled_truth: 'one' }));
    const rewrite = (db: BrainEngine, text: string) => db.executeRaw(`UPDATE pages SET compiled_truth=$1 WHERE slug='seam/rewrite'`, [text]);
    expect(isUndeclaredWriteTrust(await rewrite(engine, 'two').then(() => null, e => e))).toBe(true);
    await maintenanceTransaction(engine, tx => withTrustKeep(tx, ['pages'], () => rewrite(tx, 'three')));
    await engine.executeRaw(`UPDATE pages SET updated_at = now() WHERE slug='seam/rewrite'`);
    expect(await tierOf(engine, 'seam/rewrite')).toBe('operator_curated');
  });

  test('a backfill copy is not a write the strict mode refuses', async () => {
    await engine.transaction(async tx => {
      await tx.executeRaw(`SELECT set_config('gbrain.write_trust_backfill','on',true)`);
      await tx.executeRaw(`INSERT INTO pages (source_id, slug, type, title, compiled_truth, trust_tier) VALUES ('default','seam/copied','note','c','x','agent_written')`);
    });
    expect(await tierOf(engine, 'seam/copied')).toBe('agent_written');
  });

  test('the function a migration installs still stores unknown for an undeclared write', async () => {
    const plain = new PGLiteEngine();
    await plain.connect({});
    try {
      await plain.initSchema();
      await plain.executeRaw(GUEST_FAIL_CLOSED_STAMP_TIER_FUNCTION);
      await plain.putPage('seam/legacy', { type: 'note', title: 'l', compiled_truth: 'body' });
      expect(await tierOf(plain, 'seam/legacy')).toBe('unknown');
    } finally { await plain.disconnect(); }
  });

  test('negative: a deliberately undeclared write fails the guard, and the failure names the path', async () => {
    await expect(drive('deliberately_undeclared_write', () => engine.putPage('seam/deliberate', { type: 'note', title: 'x', compiled_truth: 'body' })))
      .rejects.toThrow(/undeclared write trust in deliberately_undeclared_write: .*undeclared_write_trust/);
  });
});

/**
 * Mutating operations that write no pages, facts, takes or timeline rows (job, skill, source, storage and cache
 * state, or reads that record a watch), and the reason. A mutating operation of the manifest that is neither driven
 * below nor listed here fails `every mutating operation is accounted for`, so a new one is classified when it is added.
 */
const WRITES_NO_TRUST_ROW: Readonly<Record<string, string>> = {
  purge_deleted_pages: 'deletes rows', cancel_write_request: 'request state', rate_answer: 'answer ratings',
  begin_page_upload: 'upload staging, committed through the page publication driven below', upload_page_part: 'upload staging', abort_page_upload: 'upload staging',
  commit_page_upload: 'the page publication put_page drives', put_skill: 'skill packs', delete_skill: 'skill packs', set_skill_policy: 'skill packs',
  prune_skill_revisions: 'skill packs', retain_skill_revision: 'skill packs', import_skill_proposal: 'skill packs', join_brain: 'skill enrollment',
  sync_brain_skills: 'skill enrollment', leave_brain: 'skill enrollment', put_raw_data: 'raw data rows', log_ingest: 'the ingest log',
  file_upload: 'storage', file_register: 'file rows', storage_register: 'storage cards', storage_update: 'storage cards', submit_job: 'job queue',
  cancel_job: 'job queue', retry_job: 'job queue', pause_job: 'job queue', resume_job: 'job queue', replay_job: 'job queue', send_job_message: 'job queue',
  submit_agent: 'job queue', watch_job: 'watch registration', watch_write_request: 'watch registration', watch_cron: 'watch registration',
  accept_wakeshift_terms: 'terms acceptance', unwatch: 'watch registration', think: 'a read; a persisted take is driven by the think persist path',
  takes_remove: 'deletes a take row', takes_rebuild: 'rebuilds take rows from the fence, written by the extract-takes path',
  sources_add: 'source rows', sources_remove: 'source rows', request_tools: 'tool grants', connector_sync: 'journaled connector publication, driven by the connector tests',
  chronicle_backfill: 'a job submission', extraction_review: 'review state', entity_identity_link: 'identity rows', entity_identity_unlink: 'identity rows',
  purge_fact: 'deletes rows', unpurge_page: 'page restore through the journal, as restore_page', set_memory_writeback: 'a setting', memory_conversation_mode: 'a setting',
  code_traversal_cache_clear: 'a cache', migrate_embeddings: 'embedding columns', schema_apply_mutations: 'schema packs', run_onboard: 'a job submission',
  run_skillopt: 'a job submission', loops_close: 'loop state', loops_mute: 'loop settings', loops_unmute: 'loop settings', questions_pin: 'question settings',
  questions_refresh: 'question settings', questions_unpin: 'question settings', mute_notice: 'notice settings', confirm_memory: 'a tier confirmation, not a write of content',
  promote_guest_note: 'an async derived publication, covered by the guest tests', sync_brain: 'a sync job, driven by the import paths below',
  remove_tag: 'a tag row', add_tag: 'a tag row', remove_link: 'a link row', add_link: 'a link row', ontology_propose: 'ontology proposals',
  memory_propose: 'proposals', memory_write: 'requires an attested person; its fact rows go through the same journal as remember',
  forget: 'withdraws facts through the journal, as forget_fact', delete_page: 'a soft delete through the journal', restore_page: 'a restore through the journal',
};

/** The operations that write trust-table rows, with minimal valid arguments; each runs on an unmanaged and a managed brain. */
type Step = { op: string; args: (state: { revision?: string; versionId?: number }) => Record<string, unknown> };
const DRIVEN: Step[] = [
  { op: 'put_page', args: () => ({ slug: 'notes/alpha', content: note('Alpha', 'Alpha body text.') }) },
  { op: 'put_pages', args: () => ({ request_id: randomUUID(), pages: [{ slug: 'notes/beta', content: note('Beta', 'Beta body text.') }] }) },
  { op: 'append_page', args: () => ({ slug: 'notes/alpha', text: 'More alpha text.', request_id: randomUUID() }) },
  { op: 'capture', args: () => ({ content: 'A captured thought about alpha.' }) },
  { op: 'add_timeline_entry', args: () => ({ slug: 'notes/alpha', date: '2026-01-02', summary: 'Alpha happened' }) },
  { op: 'takes_add', args: () => ({ slug: 'notes/alpha', claim: 'Alpha will ship', kind: 'bet', holder: 'world' }) },
  { op: 'takes_update', args: () => ({ slug: 'notes/alpha', row_num: 1, weight: 0.4 }) },
  { op: 'takes_supersede', args: () => ({ slug: 'notes/alpha', row_num: 1, claim: 'Alpha ships later' }) },
  { op: 'takes_resolve', args: () => ({ slug: 'notes/alpha', row_num: 2, quality: 'correct' }) },
  { op: 'remember', args: () => ({ fact: 'Beta likes tea', entity: 'notes/beta', provenance: 'told directly' }) },
  { op: 'extract_facts', args: () => ({ turn_text: 'Beta said they like tea.', session_id: 'strict-1' }) },
  { op: 'extract_entities', args: () => ({ text: 'Beta met Gamma.', source_slug: 'notes/alpha' }) },
  { op: 'forget_fact', args: () => ({ id: 1, reason: 'superseded by newer notes' }) },
  { op: 'edit_page', args: s => ({ slug: 'notes/beta', expected_revision: s.revision, edits: [{ old_text: 'Beta body', new_text: 'Beta edited body' }] }) },
  { op: 'revert_version', args: s => ({ slug: 'notes/beta', version_id: s.versionId, expected_revision: s.revision }) },
];

const mutating = (OPERATION_MANIFEST as unknown as Array<{ name: string; mutating?: boolean }>).filter(o => o.mutating).map(o => o.name);

describe('operations', () => {
  test('every mutating operation is accounted for', () => {
    const covered = new Set([...DRIVEN.map(s => s.op), ...Object.keys(WRITES_NO_TRUST_ROW)]);
    const unaccounted = mutating.filter(name => !covered.has(name));
    expect(unaccounted, `mutating operations neither driven nor listed as writing no trust row: ${unaccounted.join(', ')}`).toEqual([]);
    const stale = [...covered].filter(name => !mutating.includes(name));
    expect(stale, `operations listed here that the manifest does not mark mutating: ${stale.join(', ')}`).toEqual([]);
  });

  /** Runs every driven operation; an operation that refuses for a reason other than an undeclared write is not this guard's failure. */
  async function driveAll(engine: BrainEngine, mode: string, extra: Record<string, unknown>): Promise<string[]> {
    const ctx = opContext(engine);
    const state: { revision?: string; versionId?: number } = {};
    const refused: string[] = [];
    for (const step of DRIVEN) {
      if (step.op === 'edit_page' || step.op === 'revert_version') {
        const snapshot = await engine.readPageSnapshot('notes/beta', { sourceId: 'default' });
        state.revision = snapshot?.revision;
        const [version] = await engine.executeRaw<{ id: number }>(`SELECT v.id FROM page_versions v JOIN pages p ON p.id=v.page_id WHERE p.slug='notes/beta' ORDER BY v.id LIMIT 1`);
        state.versionId = version?.id;
        if (step.op === 'revert_version' && state.versionId === undefined) continue;
      }
      try { await drive(`${mode} operation ${step.op}`, async () => operationsByName[step.op]!.handler(ctx as never, { ...step.args(state), ...extra } as never)); }
      catch (error) {
        const message = String((error as Error).message);
        if (isUndeclaredWriteTrust(error) || message.startsWith('undeclared write trust in')) throw error;
        // A managed write reports the trigger's refusal as a failed publication without the trigger's text.
        if (message.includes('gbrain_stamp_trust_tier')) throw new Error(`undeclared write trust in ${mode} operation ${step.op}: ${message}`, { cause: error });
        refused.push(`${step.op}: ${String((error as Error).message).slice(0, 80)}`);
      }
    }
    return refused;
  }

  let unmanaged: PGLiteEngine;
  beforeAll(async () => { unmanaged = await strictEngine(new PGLiteEngine()); });
  afterAll(async () => { await unmanaged.disconnect(); });

  test('on an unmanaged brain none writes an undeclared row', async () => {
    expect(await driveAll(unmanaged, 'unmanaged', {}), 'an operation that refused here was not exercised').toEqual([]);
    expect(await tierOf(unmanaged, 'notes/alpha')).toBe('agent_written');
  }, 240_000);

  test('on a managed brain none writes an undeclared row', async () => {
    await managedBrain(async ({ engine }) => {
      expect(await driveAll(engine, 'managed', { wait_ms: 30_000 }), 'an operation that refused here was not exercised').toEqual([]);
      expect(await tierOf(engine, 'notes/alpha')).toBe('agent_written');
      const failed = await engine.executeRaw<{ operation: string; state: string }>(`SELECT operation, state FROM persistence_requests WHERE state='failed'`);
      expect(failed, `requests that ended failed: ${JSON.stringify(failed)}`).toEqual([]);
    }, { setup: ({ engine }) => installStrictWriteTrust(engine) });
  }, 240_000);
});

describe('write paths outside the operations', () => {
  let engine: PGLiteEngine;
  let dir: string;
  beforeAll(async () => { engine = await strictEngine(new PGLiteEngine()); dir = mkdtempSync(join(tmpdir(), 'gbrain-write-trust-')); });
  afterAll(async () => { await engine.disconnect(); rmSync(dir, { recursive: true, force: true }); });

  test('importFromContent stores the tier its caller declares, and refuses an undeclared write', async () => {
    await drive('importFromContent with writeTrust', () => importFromContent(engine, 'paths/declared', note('D', 'declared body'), { noEmbed: true, writeTrust: agentVerbTrust('test:agent') }));
    expect(await tierOf(engine, 'paths/declared')).toBe('agent_written');
    const undeclared = await importFromContent(engine, 'paths/undeclared', note('U', 'undeclared body'), { noEmbed: true }).then(() => null, e => e);
    expect(isUndeclaredWriteTrust(undeclared)).toBe(true);
  });

  test('a keepTier re-import rewrites the page and leaves its tier', async () => {
    await seed(engine, tx => tx.putPage('paths/kept', { type: 'note', title: 'K', compiled_truth: 'before' }));
    await drive('importFromContent with keepTier', () => importFromContent(engine, 'paths/kept', note('K', 'after the re-import'), { noEmbed: true, keepTier: true, forceRechunk: true }));
    expect(await tierOf(engine, 'paths/kept')).toBe('operator_curated');
    const [row] = await engine.executeRaw<{ compiled_truth: string }>(`SELECT compiled_truth FROM pages WHERE slug='paths/kept'`);
    expect(row?.compiled_truth).toContain('after the re-import');
  });

  test('importFromFile declares the owner source tier for a markdown file and for a code file', async () => {
    mkdirSync(join(dir, 'notes'), { recursive: true });
    writeFileSync(join(dir, 'notes', 'filed.md'), note('Filed', 'a filed note'));
    writeFileSync(join(dir, 'tool.ts'), 'export const answer = 42;\n');
    await drive('importFromFile (markdown)', () => importFromFile(engine, join(dir, 'notes', 'filed.md'), 'notes/filed.md', { noEmbed: true }));
    await drive('importFromFile (code)', () => importFromFile(engine, join(dir, 'tool.ts'), 'tool.ts', { noEmbed: true }));
    expect(await tierOf(engine, 'notes/filed')).toBe('operator_curated');
    const [code] = await engine.executeRaw<{ trust_tier: string }>(`SELECT trust_tier FROM pages WHERE type='code' LIMIT 1`);
    expect(code?.trust_tier).toBe('operator_curated');
  });

  test('writeReceipt files its page as a derived write', async () => {
    await drive('writeReceipt', () => writeReceipt(engine, { kind: 'extract_facts', source_id: 'default', run_id: 'strict-run', round: 'single',
      extracted_at: '2026-01-02T00:00:00Z', total_rows: 1, cost_usd: 0 }));
    const [row] = await engine.executeRaw<{ trust_tier: string }>(`SELECT trust_tier FROM pages WHERE type='extract_receipt' LIMIT 1`);
    expect(row?.trust_tier).toBe('agent_written');
  });

  test('timeline extraction stamps the rows with their page tier', async () => {
    const body = '## Timeline\n\n- **2026-02-03** | notes - the planning meeting\n';
    await seed(engine, tx => tx.putPage('paths/dated', { type: 'note', title: 'Dated', compiled_truth: 'Dated body.', timeline: body }));
    const result = await drive('extractTimelineFromDB', () => extractTimelineFromDB(engine, { dryRun: false, jsonMode: true, quiet: true, sourceIdFilter: 'default', slugs: ['paths/dated'] }));
    expect(result.refused).toBe(0);
    const rows = await engine.executeRaw<{ trust_tier: string }>(`SELECT t.trust_tier FROM timeline_entries t JOIN pages p ON p.id=t.page_id WHERE p.slug='paths/dated'`);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(r => r.trust_tier === 'operator_curated')).toBe(true);
  });

  test('restoring a redacted fact rewrites its text and leaves its tier', async () => {
    const { id } = await seed(engine, tx => tx.insertFact({ fact: 'redacted text', kind: 'fact', entity_slug: 'people/example-person', visibility: 'world', source: 'test:seed' }, { source_id: 'default' }));
    const restore = { id: Number(id), from: 'redacted text', to: 'the original text', visibility: 'world', entity_slug: 'people/example-person', source_markdown_slug: null, row_num: null };
    const restored = await drive('restoreRedactedRows', () => maintenanceTransaction(engine, tx => restoreRedactedRows(tx, 'default', [restore as never])));
    expect(restored.map(row => Number(row.id))).toEqual([Number(id)]);
    const [row] = await engine.executeRaw<{ trust_tier: string; fact: string }>('SELECT trust_tier, fact FROM facts WHERE id=$1', [id]);
    expect(row).toMatchObject({ trust_tier: 'operator_curated', fact: 'the original text' });
  });

  test('publishExtractedFacts takes the writer from its request: a declared trust stores that tier, and the request type requires one', async () => {
    await seed(engine, tx => tx.putPage('paths/chat', { type: 'conversation', title: 'Chat', compiled_truth: 'Alice likes green tea.' }));
    const request = (trust: ExtractedFactsRequest['trust']): ExtractedFactsRequest => ({ sourceId: 'default', slug: 'paths/chat', writer: 'conversation', coverage: 'whole_body',
      input: { pin: 'chat-v1', size: 22 }, facts: [{ fact: 'Alice likes green tea.', visibility: 'world', entity_slug: null, attributed_to: 'user' }], trust });
    const outcome = await drive('publishExtractedFacts', () => publishExtractedFacts(engine, request(derivedWriteTrust({ channel: 'derive:extracted_facts', inputs: [] }))));
    expect(outcome.state).toBe('published');
    const [row] = await engine.executeRaw<{ trust_tier: string }>(`SELECT trust_tier FROM facts WHERE source_markdown_slug='paths/chat' AND expired_at IS NULL`);
    expect(row?.trust_tier).toBe('agent_written');
    // The type is the guard for a caller that forgets: this line is a compile error if `trust` ever becomes optional.
    // @ts-expect-error trust is required
    const missing: ExtractedFactsRequest = { sourceId: 'default', slug: 'paths/chat', writer: 'conversation', coverage: 'whole_body', input: { pin: 'x', size: 1 }, facts: [] };
    expect(missing.trust).toBeUndefined();
  });

  test('a lifecycle soft delete through keepTierTransaction leaves the page tier', async () => {
    await seed(engine, tx => tx.putPage('paths/retired', { type: 'note', title: 'R', compiled_truth: 'retire me' }));
    await drive('keepTierTransaction softDeletePage', () => keepTierTransaction(engine, tx => tx.softDeletePage('paths/retired', { sourceId: 'default' })));
    expect(await tierOf(engine, 'paths/retired')).toBe('operator_curated');
  });
});

describe('importFromContent callers', () => {
  /** A call declares its writer when it passes a gate, a trust, a keep, a coordinated `prepare`, spreads options its caller declared, or says why not. */
  const DECLARES = /writeGate|writeTrust|keepTier|prepare\b|\.\.\.(importOptions|importOpts|source|opts)\b|write-trust:/;
  const CALLEE = /\b(importFromContent|importPageItem|importCodeFile)\(/g;

  function sourceFiles(root: string): string[] {
    return readdirSync(root).flatMap(name => {
      const path = join(root, name);
      if (statSync(path).isDirectory()) return sourceFiles(path);
      return path.endsWith('.ts') ? [path] : [];
    });
  }

  /** The line numbers of calls in `text` that declare no writer. */
  function undeclaredCalls(text: string): number[] {
    const lines = text.split('\n');
    const found: number[] = [];
    for (const match of text.matchAll(CALLEE)) {
      const line = text.slice(0, match.index).split('\n').length;
      const code = lines[line - 1]!;
      if (/^\s*(\*|\/\/)/.test(code) || /(async )?function \w+\(|import\s*\{|typeof importFromContent|Parameters<typeof/.test(code)) continue;
      let depth = 0, end = match.index! + match[0].length - 1;
      for (; end < text.length; end++) { if (text[end] === '(') depth++; else if (text[end] === ')' && --depth === 0) break; }
      const call = text.slice(match.index!, end + 1);
      const context = lines.slice(Math.max(0, line - 4), line).join('\n');
      if (!DECLARES.test(call) && !DECLARES.test(context)) found.push(line);
    }
    return found;
  }

  test('the scan flags an import call that declares nothing and accepts one that declares', () => {
    expect(undeclaredCalls(`await importFromContent(engine, slug, body, { noEmbed: true });`)).toEqual([1]);
    expect(undeclaredCalls(`await importPageItem(tx, item, { sourceId });`)).toEqual([1]);
    expect(undeclaredCalls(`await importFromContent(engine, slug, body, { noEmbed: true, writeTrust });`)).toEqual([]);
    expect(undeclaredCalls(`await importFromContent(engine, slug, body, { keepTier: true });`)).toEqual([]);
    expect(undeclaredCalls(`// write-trust: declared by the caller's scope\nawait importFromContent(engine, slug, body, {});`)).toEqual([]);
  });

  test('no caller in src stores a page without declaring its writer', () => {
    const root = join(import.meta.dir, '..', 'src');
    const undeclared: string[] = [];
    for (const file of sourceFiles(root)) {
      if (file.endsWith(join('core', 'import-file.ts'))) continue; // the entry points declare inside: driven above
      for (const line of undeclaredCalls(readFileSync(file, 'utf8'))) undeclared.push(`${relative(root, file)}:${line}`);
    }
    expect(undeclared, `import calls that declare no writer (pass writeGate, writeTrust or keepTier, or add a "write-trust:" comment naming who declares): ${undeclared.join(', ')}`).toEqual([]);
  });
});
