import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runPhaseSynthesize } from '../src/core/cycle/synthesize.ts';
import { retryWriteAdmission } from '../src/core/persistence/admission-retry.ts';
import * as journal from '../src/core/persistence/journal.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { acquireWorktree, getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { __setMaintenanceWriteWaitForTests } from '../src/core/persistence/maintenance-wait.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { clientRequestUuid } from '../src/core/persistence/preconditions.ts';
import { COMMITTED_OUTPUT_REQUESTS_SQL, journaledPageSlug } from '../src/core/cycle/synthesize-postprocess.ts';
import { POSTPROCESS_PENDING_KEY } from '../src/core/cycle/synthesize-postprocess-deferral.ts';
import { requestIndexesCheck } from '../src/commands/doctor/checks/persistence-requests.ts';
import { PERSISTENCE_REQUEST_ID_INDEX } from '../src/core/persistence/schema.ts';
import { buildIndexOnline } from '../src/core/schema-migrations/helpers.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { isTerminal as isTerminalRequest, type RequestState as PersistenceRequestState } from '../src/core/persistence/model.ts';
import { configureGateway, resetGateway, __setChatTransportForTests, __setEmbedTransportForTests, __setDecideTransportForTests } from '../src/core/ai/gateway.ts';
import { flushDecideWrites } from '../src/core/ai/decide/store.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import * as staleEmbedding from '../src/core/embed-stale.ts';
import { testBackends } from './helpers/test-backends.ts';
import { freezeCorpusSessions } from './helpers/frozen-corpus.ts';
import { childCommittedOrdinaryCycle, interruptAfterChild, laterQuote, managedSynthesisFixture, outputSlug, type SynthesisFixture } from './helpers/managed-synthesis-fixture.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
let dataDir: string;
let closePostgres: (() => Promise<void>) | undefined;
beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'gbrain-synth-postprocess-db-'));
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine();
    await engine.connect({ database_path: dataDir });
    await engine.initSchema();
    engines.push(engine);
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engines.push(pg.engine);
    closePostgres = pg.close;
  }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.();
  resetGateway();
  rmSync(dataDir, { recursive: true, force: true });
});

const fixture = (run: (f: SynthesisFixture) => Promise<void>, outputCount = 1, outputBody?: string) => managedSynthesisFixture(engines, run, outputCount, outputBody);

test('managed native synthesis quarantines interpretations around valid evidence before mirror/chunk publication', async () => {
  const supported = 'Reliable memories should survive every tool change.';
  const unsupported = [
    'The user completed the durability roadmap in 2026.',
    'The user completed the roadmap: "we charge for durability because reliable memories should survive every tool".',
  ];
  await fixture(async ({ engine, sourceId, root, opts }) => {
    const groundingConfig = {
      'decide.provider': 'typesafe:jev-1.13.0', 'decide.slots.grounding.mode': 'on',
      'decide.slots.grounding.threshold': '0.5', 'decide.slots.grounding.force_on': 'true',
      'decide.egress.private': 'allow', 'decide.egress.typesafe.conversation': 'allow',
      'decide.budget.daily_usd': '50',
    };
    const previousConfig = new Map(await Promise.all(Object.keys(groundingConfig).map(async key => [key, await engine.getConfig(key)] as const)));
    try {
      for (const [key, value] of Object.entries(groundingConfig)) await engine.setConfig(key, value);
      configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536,
        env: { TYPESAFE_API_KEY: 'sk-test-typesafe' } });
      const claims: string[] = [];
      __setDecideTransportForTests(async (_url, init) => {
        const payload = JSON.parse(init.body as string);
        const answers: Record<string, unknown> = {};
        for (const [id, question] of Object.entries<any>(payload.questions)) {
          claims.push(question.instructions.claim);
          answers[id] = { type: 'noul', noul: unsupported.includes(question.instructions.claim) ? 0.05 : 0.93 };
        }
        return new Response(JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 200, output_tokens: 3 } }));
      });
      const report = await runPhaseSynthesize(engine, opts);
      expect(report.status).toBe('ok');
      expect(claims).toEqual(expect.arrayContaining(unsupported));
      const slug = await outputSlug(engine, sourceId);
      const page = (await engine.readPageSnapshot(slug, { sourceId }))!.page;
      const rendered = readFileSync(join(root, `${slug}.md`), 'utf8');
      expect(page.compiled_truth).toContain(supported);
      expect(page.compiled_truth).not.toContain('completed');
      expect(page.frontmatter.unverified_claims).toEqual(expect.arrayContaining(unsupported.map(text =>
        expect.objectContaining({ text, reason: 'unsupported_paraphrase' }))));
      expect(rendered).toContain('unsupported_paraphrase');
      expect(rendered.slice(rendered.indexOf('\n---\n') + 5)).not.toContain('completed');
      const chunks = await engine.executeRaw<{ content: string }>('SELECT c.chunk_text AS content FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE p.slug=$1 AND p.source_id=$2', [slug, sourceId]);
      const chunkText = chunks.map(c => c.content).join('\n');
      expect(chunkText).toContain(supported);
      expect(chunkText).not.toContain('completed');
      expect((await engine.searchKeyword('Reliable memories', { limit: 5, sourceId })).some(hit => hit.slug === slug)).toBe(true);
      expect((await engine.searchKeyword('completed durability roadmap', { limit: 5, sourceId })).some(hit => hit.slug === slug)).toBe(false);
    } finally {
      await flushDecideWrites();
      for (const [key, value] of previousConfig) {
        if (value === null) await engine.unsetConfig(key);
        else await engine.setConfig(key, value);
      }
    }
  }, 1, [supported, ...unsupported, 'Related context: [[people/example]].'].join('\n\n'));
}, 120_000);

test('GBRA-60: a child that verifies and stamps writes each output once; postprocessing counts its repair and publishes nothing', async () => {
  await managedSynthesisFixture(engines, async ({ engine, sourceId, opts }) => {
    const report = await runPhaseSynthesize(engine, opts);
    expect(report.status).toBe('ok');
    expect((report.details.synthesis as { quote_verify: { pages_repaired: number } }).quote_verify.pages_repaired).toBe(1);
    const slug = await outputSlug(engine, sourceId);
    const page = (await engine.readPageSnapshot(slug, { sourceId }))!.page;
    expect({ stamped: page.frontmatter.dream_generated, invented: page.compiled_truth.includes('"an entirely invented') }).toEqual({ stamped: true, invented: false });
    const [{ n: versions }] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM page_versions v JOIN pages p ON p.id=v.page_id WHERE p.source_id=$1 AND p.slug=$2', [sourceId, slug]);
    const [{ n: postprocessed }] = await engine.executeRaw<{ n: number }>(
      "SELECT count(*)::int AS n FROM persistence_requests WHERE source_id=$1 AND slug=$2 AND intent->>'kind'='managed_maintenance_page'", [sourceId, slug]);
    expect({ versions, postprocessed }).toEqual({ versions: 0, postprocessed: 0 });
  }, 1, undefined, true);
}, 120_000);

/**
 * #6051: deterministic contention injection. Each maintenance admission for
 * which `contended(slug)` holds fails with the exact error real admission
 * raises once its retry budget is spent (retryWriteAdmission on a 55P03 lock
 * timeout with no budget left), without waiting out that budget. Records stderr.
 */
function contendAdmissions(contended: (slug: string) => boolean) {
  let injected = 0, stderr = '';
  const write = spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as never);
  const admitWrite = journal.admitWrite;
  const spy = spyOn(journal, 'admitWrite').mockImplementation(async (engine, input, ...rest) => {
    if (!contended(input.slug)) return admitWrite(engine, input, ...rest);
    injected++;
    return retryWriteAdmission(input.requestId ?? 'contended', async () => {
      throw Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
    }, 0);
  });
  return { injected: () => injected, stderr: () => stderr, restore: () => { spy.mockRestore(); write.mockRestore(); } };
}

test('finalized synthesis never rewrites a later user quotation on same-transcript replay', async () => {
  await fixture(async ({ engine, sourceId, root, opts, calls, edit }) => {
    const first = await runPhaseSynthesize(engine, opts);
    expect(first.status).toBe('ok');
    expect(first.details.pages_written).toBe(1);
    const slug = await outputSlug(engine, sourceId);
    await edit(slug);
    const before = (await engine.readPageSnapshot(slug, { sourceId }))!;
    const path = join(root, `${slug}.md`);
    const bytes = readFileSync(path, 'utf8');
    const mtime = statSync(path).mtimeMs;
    const spent = calls();
    const receipts = await engine.executeRaw('SELECT id,state,outcome FROM persistence_requests WHERE source_id=$1 AND slug=$2 ORDER BY sequence', [sourceId, slug]);
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('DELETE FROM dream_verdicts');
    const replay = await runPhaseSynthesize(engine, opts);
    expect(replay.status).toBe('ok');
    expect(calls()).toBe(spent);
    expect((await engine.readPageSnapshot(slug, { sourceId }))!.revision).toBe(before.revision);
    expect(readFileSync(path, 'utf8')).toBe(bytes);
    expect(statSync(path).mtimeMs).toBe(mtime);
    expect(await engine.executeRaw('SELECT id,state,outcome FROM persistence_requests WHERE source_id=$1 AND slug=$2 ORDER BY sequence', [sourceId, slug])).toEqual(receipts);
    expect(replay.details.pages_written).toBe(0);
  });
}, 120_000);

test('interrupted synthesis postprocessing resumes once without rerunning either provider', async () => {
  await fixture(async ({ engine, sourceId, root, opts, calls }) => {
    await interruptAfterChild(engine, sourceId, opts);
    const slug = await outputSlug(engine, sourceId);
    expect((await engine.getPage(slug, { sourceId }))!.compiled_truth).toContain('"an entirely invented');
    const spent = calls();
    const recovered = await runPhaseSynthesize(engine, opts);
    expect(recovered.status).toBe('ok');
    expect(calls()).toBe(spent);
    expect(recovered.details.pages_written).toBe(1);
    const snapshot = (await engine.readPageSnapshot(slug, { sourceId }))!;
    expect(snapshot.page.compiled_truth).not.toContain('"an entirely invented');
    expect(snapshot.page.frontmatter.dream_generated).toBe(true);
    expect(readFileSync(join(root, `${slug}.md`), 'utf8')).toContain('dream_generated: true');
    await disposePersistenceConsumer(engine);
    const replay = await runPhaseSynthesize(engine, opts);
    expect(replay.status).toBe('ok');
    expect(replay.details.pages_written).toBe(0);
    expect((await engine.readPageSnapshot(slug, { sourceId }))!.revision).toBe(snapshot.revision);
    expect(calls()).toBe(spent);
  });
}, 120_000);

/**
 * #6616: the retained tool input holds what the child sent; the journal holds the
 * canonical forms. Each alias below rewrites only the retained input (and, for a
 * printable client id, the journal row to that id's UUIDv5, as the write path
 * would have stored it); postprocessing must still find the committed output and
 * resume without another provider call.
 */
const RETAINED_ALIASES: Array<[string, (engine: BrainEngine, sourceId: string) => Promise<void>]> = [
  ['an uppercase UUID request_id', async (engine, sourceId) => {
    await engine.executeRaw(`UPDATE subagent_tool_executions SET input=jsonb_set(input,'{request_id}',to_jsonb(upper(input->>'request_id')))
      WHERE tool_name='brain_put_page' AND job_id IN (SELECT id FROM minion_jobs WHERE data->>'source_id'=$1)`, [sourceId]);
  }],
  ['a printable client request_id', async (engine, sourceId) => {
    const [tool] = await engine.executeRaw<{ request_id: string }>(`SELECT input->>'request_id' AS request_id FROM subagent_tool_executions
      WHERE tool_name='brain_put_page' AND job_id IN (SELECT id FROM minion_jobs WHERE data->>'source_id'=$1)`, [sourceId]);
    await engine.executeRaw('UPDATE persistence_requests SET request_id=$2::uuid WHERE source_id=$1 AND request_id::text=$3',
      [sourceId, clientRequestUuid('synth-output-test-1'), tool.request_id]);
    await engine.executeRaw(`UPDATE subagent_tool_executions SET input=jsonb_set(input,'{request_id}','"synth-output-test-1"')
      WHERE tool_name='brain_put_page' AND job_id IN (SELECT id FROM minion_jobs WHERE data->>'source_id'=$1)`, [sourceId]);
  }],
  ['a mixed-case slug', async (engine, sourceId) => {
    await engine.executeRaw(`UPDATE subagent_tool_executions SET input=jsonb_set(input,'{slug}',to_jsonb(replace(input->>'slug','session','SESSION')))
      WHERE tool_name='brain_put_page' AND job_id IN (SELECT id FROM minion_jobs WHERE data->>'source_id'=$1)`, [sourceId]);
  }],
];

for (const [alias, rewrite] of RETAINED_ALIASES) {
  test(`#6616: interrupted postprocessing resumes a child output retained with ${alias}, without a provider call`, async () => {
    await fixture(async ({ engine, sourceId, root, opts, calls }) => {
      await interruptAfterChild(engine, sourceId, opts);
      const slug = await outputSlug(engine, sourceId);
      await rewrite(engine, sourceId);
      const spent = calls();
      const recovered = await runPhaseSynthesize(engine, opts);
      expect(recovered.status, JSON.stringify(recovered.error ?? recovered.summary)).toBe('ok');
      expect(calls()).toBe(spent);
      expect(recovered.details.pages_written).toBe(1);
      const snapshot = (await engine.readPageSnapshot(slug, { sourceId }))!;
      expect(snapshot.page.frontmatter.dream_generated).toBe(true);
      expect(readFileSync(join(root, `${slug}.md`), 'utf8')).toContain('dream_generated: true');
    });
  }, 120_000);
}

test('#6616: a committed output that does not match source, incarnation, revision, slug or state still refuses', async () => {
  const { loadCommittedSynthesisOutputs } = await import('../src/core/cycle/synthesize-postprocess.ts');
  const { maintenancePreflight } = await import('../src/core/persistence/prepared-maintenance.ts');
  await fixture(async ({ engine, sourceId, root, opts, calls }) => {
    await interruptAfterChild(engine, sourceId, opts);
    const authority = (await maintenancePreflight(engine, sourceId, root))!;
    const [tool] = await engine.executeRaw<{ job_id: number | bigint; input: Record<string, unknown>; output: Record<string, unknown> }>(
      `SELECT t.job_id,t.input,t.output FROM subagent_tool_executions t JOIN minion_jobs j ON j.id=t.job_id
       WHERE j.data->>'source_id'=$1 AND t.tool_name='brain_put_page' AND t.status='complete'`, [sourceId]);
    const ids = [Number(tool.job_id)];
    expect(await loadCommittedSynthesisOutputs(engine, authority, ids)).toHaveLength(1);
    for (const writer of [{ ...authority.writer, sourceId: 'unrelated-source' }, { ...authority.writer, sourceIncarnation: randomUUID() }]) {
      expect(await loadCommittedSynthesisOutputs(engine, { ...authority, writer }, ids)).toEqual([]);
    }
    const spent = calls();
    for (const [input, output] of [
      [{ ...tool.input, slug: 'wiki/personal/reflections/unrelated' }, tool.output],
      [tool.input, { ...tool.output, revision: randomUUID() }],
      [tool.input, { ...tool.output, state: 'queued' }],
    ]) {
      await engine.executeRaw(`UPDATE subagent_tool_executions SET input=$2::text::jsonb,output=$3::text::jsonb WHERE job_id=$1 AND tool_name='brain_put_page'`,
        [ids[0], JSON.stringify(input), JSON.stringify(output)]);
      expect(await loadCommittedSynthesisOutputs(engine, authority, ids)).toEqual([]);
      const refused = await runPhaseSynthesize(engine, opts);
      expect(refused.status).toBe('fail');
      expect(refused.error?.code).toBe('SYNTH_PHASE_FAIL');
      expect(calls()).toBe(spent);
    }
  });
}, 120_000);

test('#6616: journaledPageSlug is the slug submitPageMutation journals', async () => {
  await fixture(async ({ engine, sourceId }) => {
    const requestId = randomUUID();
    await submitPageMutation({ engine, sourceId, remote: false, config: { engine: engine.kind, embedding_disabled: true }, dryRun: false,
      logger: { info() {}, warn() {}, error() {} } } as never,
    { operation: 'put_page', params: { slug: 'Notes/Mixed-Case-Example', content: '---\ntitle: Mixed\ntype: note\n---\nBody.', request_id: requestId } });
    const [row] = await engine.executeRaw<{ slug: string }>('SELECT slug FROM persistence_requests WHERE request_id=$1::uuid', [requestId]);
    expect(row.slug).toBe(journaledPageSlug('Notes/Mixed-Case-Example'));
  });
}, 120_000);

test('unfinished synthesis refuses an intervening user revision rather than adopting it', async () => {
  await fixture(async ({ engine, sourceId, root, opts, calls, edit }) => {
    await interruptAfterChild(engine, sourceId, opts);
    const slug = await outputSlug(engine, sourceId);
    await edit(slug);
    const snapshot = (await engine.readPageSnapshot(slug, { sourceId }))!;
    const path = join(root, `${slug}.md`);
    const bytes = readFileSync(path, 'utf8');
    const spent = calls();
    const replay = await runPhaseSynthesize(engine, opts);
    // #6360: a user revision is a per-page warn, not a phase failure every cycle.
    expect(replay.status).toBe('warn');
    expect(calls()).toBe(spent);
    expect((await engine.readPageSnapshot(slug, { sourceId }))!.revision).toBe(snapshot.revision);
    expect(readFileSync(path, 'utf8')).toBe(bytes);
  });
}, 120_000);

test('a revision_conflict output keeps the suggestion that names the slug (#6242, #6360)', async () => {
  await fixture(async ({ engine, sourceId, opts, edit }) => {
    await interruptAfterChild(engine, sourceId, opts);
    const slug = await outputSlug(engine, sourceId);
    await edit(slug);
    const replay = await runPhaseSynthesize(engine, opts);
    expect(replay.status).toBe('warn');
    const [conflict] = replay.details.postprocess_conflicts as Array<{ slug: string; message: string; fix: { argv: string[] } }>;
    expect(conflict.slug).toBe(slug);
    expect(conflict.message).toContain(slug);
    expect(conflict.message).toContain(sourceId);
    expect(conflict.fix.argv).toEqual(['gbrain', 'get', '--source', sourceId, '--', slug]);
    expect(replay.details.pages_written).toBe(0);
    expect(await engine.getConfig('dream.synthesize.last_completion_ts')).toBeTruthy();
    const again = await runPhaseSynthesize(engine, opts);
    expect(again.status).toBe('ok');
    expect(again.details.postprocess_conflicts).toBeUndefined();
  });
}, 120_000);

/** A local maintenance write that only adds `created:` to the child's page, as the next cycle's lint fix does (#6360). */
async function maintenanceFrontmatterDrift(engine: BrainEngine, sourceId: string, slug: string) {
  const { maintenancePreflight, publishMaintenancePage } = await import('../src/core/persistence/prepared-maintenance.ts');
  const { serializePageToMarkdown } = await import('../src/core/markdown.ts');
  const snapshot = (await engine.readPageSnapshot(slug, { sourceId }))!;
  const authority = (await maintenancePreflight(engine, sourceId))!;
  const content = serializePageToMarkdown({ ...snapshot.page, frontmatter: { ...snapshot.page.frontmatter, created: '2026-09-20' } }, snapshot.tags);
  await publishMaintenancePage(engine, authority, slug, content, { expectedRevision: snapshot.revision });
  await disposePersistenceConsumer(engine);
}

test('a maintenance-only frontmatter drift after the child commit is adopted (#6360)', async () => {
  await fixture(async ({ engine, sourceId, opts, calls }) => {
    await interruptAfterChild(engine, sourceId, opts);
    const slug = await outputSlug(engine, sourceId);
    await maintenanceFrontmatterDrift(engine, sourceId, slug);
    const spent = calls();
    const recovered = await runPhaseSynthesize(engine, opts);
    expect(recovered.status).toBe('ok');
    expect(calls()).toBe(spent);
    expect(recovered.details.pages_written).toBe(1);
    const snapshot = (await engine.readPageSnapshot(slug, { sourceId }))!;
    expect(snapshot.page.frontmatter.dream_generated).toBe(true);
    expect(String(snapshot.page.frontmatter.created)).toContain('2026-09-20');
    expect(snapshot.page.compiled_truth).not.toContain('"an entirely invented');
    await disposePersistenceConsumer(engine);
    const replay = await runPhaseSynthesize(engine, opts);
    expect(replay.status).toBe('ok');
    expect(replay.details.pages_written).toBe(0);
    expect((await engine.readPageSnapshot(slug, { sourceId }))!.revision).toBe(snapshot.revision);
  });
}, 120_000);

test('a user put_page that only changes frontmatter is still refused, not adopted (#6360)', async () => {
  await fixture(async ({ engine, sourceId, opts }) => {
    await interruptAfterChild(engine, sourceId, opts);
    const slug = await outputSlug(engine, sourceId);
    const snapshot = (await engine.readPageSnapshot(slug, { sourceId }))!;
    const ctx = { engine, sourceId, remote: false as const, config: { engine: engine.kind, embedding_disabled: true },
      dryRun: false, logger: { info() {}, warn() {}, error() {} } };
    const { serializePageToMarkdown } = await import('../src/core/markdown.ts');
    await submitPageMutation(ctx, { operation: 'put_page', params: { slug, request_id: randomUUID(), expected_revision: snapshot.revision,
      content: serializePageToMarkdown({ ...snapshot.page, frontmatter: { ...snapshot.page.frontmatter, created: '2026-09-20' } }, snapshot.tags) } });
    await disposePersistenceConsumer(engine);
    const moved = (await engine.readPageSnapshot(slug, { sourceId }))!;
    const replay = await runPhaseSynthesize(engine, opts);
    expect(replay.status).toBe('warn');
    expect((replay.details.postprocess_conflicts as unknown[]).length).toBe(1);
    expect((await engine.readPageSnapshot(slug, { sourceId }))!.revision).toBe(moved.revision);
  });
}, 120_000);

test('synthesis postprocessing refuses a concurrent edit after checking the child revision', async () => {
  await fixture(async ({ engine, sourceId, root, opts, calls, edit }) => {
    await interruptAfterChild(engine, sourceId, opts);
    const slug = await outputSlug(engine, sourceId);
    const read = engine.readPageSnapshot;
    let changed = false;
    const spy = spyOn(engine, 'readPageSnapshot').mockImplementation(async function (this: BrainEngine, target, options) {
      const snapshot = await read.call(this, target, options);
      if (this === engine && !changed && target === slug && options?.sourceId === sourceId) {
        changed = true;
        await edit(slug);
      }
      return snapshot;
    });
    const spent = calls();
    try {
      const result = await runPhaseSynthesize(engine, opts);
      expect(changed).toBe(true);
      expect(result.status).toBe('fail');
    } finally { spy.mockRestore(); }
    expect(calls()).toBe(spent);
    expect((await engine.readPageSnapshot(slug, { sourceId }))!.page.compiled_truth).toContain(`"${laterQuote}"`);
    expect(readFileSync(join(root, `${slug}.md`), 'utf8')).toContain(`"${laterQuote}"`);
  });
}, 120_000);

test('a committed postprocessing receipt survives interruption before the phase finishes', async () => {
  await fixture(async ({ engine, sourceId, root, opts, calls, edit }) => {
    await interruptAfterChild(engine, sourceId, opts);
    const slug = await outputSlug(engine, sourceId);
    const read = engine.readPageSnapshot;
    let interrupted = false;
    const spy = spyOn(engine, 'readPageSnapshot').mockImplementation(async function (this: BrainEngine, target, options) {
      if (this === engine && target.includes('dream-cycle-summaries/') && options?.sourceId === sourceId) {
        interrupted = true;
        throw new Error('simulated phase interruption after postprocessing commit');
      }
      return read.call(this, target, options);
    });
    const spent = calls();
    try {
      const result = await runPhaseSynthesize(engine, opts);
      expect(result.status).toBe('fail');
      expect(interrupted).toBe(true);
    } finally { spy.mockRestore(); }
    const processed = (await engine.readPageSnapshot(slug, { sourceId }))!;
    expect(processed.page.frontmatter.dream_generated).toBe(true);
    expect(processed.page.compiled_truth).not.toContain('"an entirely invented');
    const summarySlug = `dream-cycle-summaries/${opts.date}`;
    expect(await engine.readPageSnapshot(summarySlug, { sourceId })).toBeNull();
    expect(existsSync(join(root, `${summarySlug}.md`))).toBe(false);
    await edit(slug);
    const edited = (await engine.readPageSnapshot(slug, { sourceId }))!;
    const bytes = readFileSync(join(root, `${slug}.md`), 'utf8');
    await disposePersistenceConsumer(engine);
    const replay = await runPhaseSynthesize(engine, opts);
    expect(replay.status).toBe('ok');
    expect(replay.details.pages_written).toBe(0);
    expect(calls()).toBe(spent);
    expect((await engine.readPageSnapshot(slug, { sourceId }))!.revision).toBe(edited.revision);
    expect(readFileSync(join(root, `${slug}.md`), 'utf8')).toBe(bytes);
    const summary = (await engine.readPageSnapshot(summarySlug, { sourceId }))!;
    expect(summary.page.compiled_truth).toContain('**Pages written:** 1.');
    expect(summary.page.compiled_truth).toContain(`[[${slug}]]`);
    expect(readFileSync(join(root, `${summarySlug}.md`), 'utf8')).toContain(`[[${slug}]]`);
  });
}, 120_000);

test('same-date synthesis replay preserves the completed summary bytes and revision', async () => {
  await fixture(async ({ engine, sourceId, root, opts, calls, edit }) => {
    const first = await runPhaseSynthesize(engine, opts);
    expect(first.status).toBe('ok');
    const slug = await outputSlug(engine, sourceId);
    const summarySlug = String(first.details.summary_slug);
    const summaryPath = join(root, `${summarySlug}.md`);
    expect(readFileSync(summaryPath, 'utf8')).toContain(`[[${slug}]]`);
    const spent = calls();
    for (const userEdited of [false, true]) {
      if (userEdited) await edit(summarySlug);
      const before = (await engine.readPageSnapshot(summarySlug, { sourceId }))!;
      const bytes = readFileSync(summaryPath, 'utf8');
      const mtime = statSync(summaryPath).mtimeMs;
      const receipts = await engine.executeRaw('SELECT id,state,outcome FROM persistence_requests WHERE source_id=$1 ORDER BY sequence', [sourceId]);
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('DELETE FROM dream_verdicts');
      const replay = await runPhaseSynthesize(engine, opts);
      expect(replay.status).toBe('ok');
      expect(replay.details.pages_written).toBe(0);
      expect(replay.details.reverse_write_count).toBe(0);
      expect(calls()).toBe(spent);
      expect((await engine.readPageSnapshot(summarySlug, { sourceId }))!.revision).toBe(before.revision);
      expect(readFileSync(summaryPath, 'utf8')).toBe(bytes);
      expect(statSync(summaryPath).mtimeMs).toBe(mtime);
      expect(await engine.executeRaw('SELECT id,state,outcome FROM persistence_requests WHERE source_id=$1 ORDER BY sequence', [sourceId])).toEqual(receipts);
    }
  });
}, 120_000);

test('partial multi-output recovery indexes every finalized output without republishing or embedding earlier outputs', async () => {
  await fixture(async ({ engine, sourceId, root, opts, calls }) => {
    await interruptAfterChild(engine, sourceId, opts);
    const outputs = await engine.executeRaw<{ slug: string }>(
      "SELECT slug FROM pages WHERE source_id=$1 AND slug LIKE 'wiki/personal/reflections/session-%' ORDER BY slug", [sourceId]);
    expect(outputs).toHaveLength(2);
    const [first, second] = outputs.map(row => row.slug);
    const read = engine.readPageSnapshot;
    let interrupted = false;
    const spy = spyOn(engine, 'readPageSnapshot').mockImplementation(async function (this: BrainEngine, target, options) {
      if (this === engine && target === second && options?.sourceId === sourceId) {
        interrupted = true;
        throw new Error('simulated interruption between output postprocessing commits');
      }
      return read.call(this, target, options);
    });
    const spent = calls();
    try {
      expect((await runPhaseSynthesize(engine, opts)).status).toBe('fail');
      expect(interrupted).toBe(true);
    } finally { spy.mockRestore(); }
    const firstSnapshot = (await engine.readPageSnapshot(first, { sourceId }))!;
    expect(firstSnapshot.page.frontmatter.dream_generated).toBe(true);
    expect((await engine.readPageSnapshot(second, { sourceId }))!.page.frontmatter.dream_generated).not.toBe(true);
    const firstBytes = readFileSync(join(root, `${first}.md`), 'utf8');
    const firstMtime = statSync(join(root, `${first}.md`)).mtimeMs;
    const firstReceipts = await engine.executeRaw('SELECT id,state,outcome FROM persistence_requests WHERE source_id=$1 AND slug=$2 ORDER BY sequence', [sourceId, first]);
    const embedded: string[] = [];
    configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536,
      env: { OPENAI_API_KEY: 'sk-test-synthesis-embedding' } });
    __setEmbedTransportForTests((async ({ values }: { values: string[] }) => {
      embedded.push(...values);
      return { embeddings: values.map(() => Array(1536).fill(0.01)) };
    }) as never);
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('DELETE FROM dream_verdicts');
    const embedScopes: string[][] = [];
    const embedPages = staleEmbedding.embedStalePages;
    const embedSpy = spyOn(staleEmbedding, 'embedStalePages').mockImplementation(async (...args) => {
      embedScopes.push([...args[1]]);
      return embedPages(...args);
    });
    let recovered: Awaited<ReturnType<typeof runPhaseSynthesize>>;
    try { recovered = await runPhaseSynthesize(engine, opts); }
    finally { embedSpy.mockRestore(); }
    expect(recovered.status).toBe('ok');
    expect(recovered.details.pages_written).toBe(1);
    expect(recovered.details.reverse_write_count).toBe(1);
    expect(recovered.details.written_slugs).toEqual([second]);
    expect(calls()).toBe(spent);
    expect((await engine.readPageSnapshot(first, { sourceId }))!.revision).toBe(firstSnapshot.revision);
    expect(readFileSync(join(root, `${first}.md`), 'utf8')).toBe(firstBytes);
    expect(statSync(join(root, `${first}.md`)).mtimeMs).toBe(firstMtime);
    expect(await engine.executeRaw('SELECT id,state,outcome FROM persistence_requests WHERE source_id=$1 AND slug=$2 ORDER BY sequence', [sourceId, first])).toEqual(firstReceipts);
    expect(embedded.length).toBeGreaterThan(0);
    expect(embedScopes).toEqual([[second]]);
    const summarySlug = String(recovered.details.summary_slug);
    const summary = (await engine.readPageSnapshot(summarySlug, { sourceId }))!;
    const summaryBytes = readFileSync(join(root, `${summarySlug}.md`), 'utf8');
    expect(summary.page.compiled_truth).toContain('**Pages written:** 2.');
    for (const { slug } of outputs) {
      expect(summary.page.compiled_truth).toContain(`[[${slug}]]`);
      expect(summaryBytes).toContain(`[[${slug}]]`);
    }
  }, 2);
}, 120_000);

test('#5854: a postprocess publish still pending after its wait is deferred, then finished by the next ordinary cycle', async () => {
  await fixture(async ({ engine, sourceId, root, opts, calls }) => {
    const corpus = join(root, '..', 'corpus');
    mkdirSync(corpus);
    writeFileSync(join(corpus, basename(opts.inputFile)), readFileSync(opts.inputFile));
    freezeCorpusSessions(corpus, sourceId);
    await engine.setConfig('dream.synthesize.session_corpus_dir', corpus);
    const ordinary = { brainDir: root, sourceId, dryRun: false };
    await interruptAfterChild(engine, sourceId, ordinary);
    const slug = await outputSlug(engine, sourceId);
    await engine.executeRaw("DELETE FROM config WHERE key='dream.synthesize.last_completion_ts'");
    const jobsBefore = await engine.executeRaw('SELECT id FROM minion_jobs ORDER BY id');
    const spent = calls();
    const lock = (await acquireWorktree((await getWorktreeBinding(engine, sourceId))!, 1000))!;
    __setMaintenanceWriteWaitForTests(300);
    let deferred: Awaited<ReturnType<typeof runPhaseSynthesize>>;
    try { deferred = await runPhaseSynthesize(engine, ordinary); }
    finally { __setMaintenanceWriteWaitForTests(null); await lock.release(); }
    expect(deferred.status).toBe('warn');
    expect(deferred.details.publish_pending).toBe(1);
    expect(deferred.details.publish_deferred).toBe('publish deferred (writer busy); finishes next cycle, no action needed');
    expect(deferred.details.pages_written).toBe(0);
    expect(await engine.getConfig('dream.synthesize.last_completion_ts')).toBeNull();
    const [pending] = await engine.executeRaw<{ request_id: string }>(
      "SELECT request_id::text FROM persistence_requests WHERE source_id=$1 AND slug=$2 AND intent->>'kind'='managed_maintenance_page'", [sourceId, slug]);
    expect(pending).toBeDefined();
    await disposePersistenceConsumer(engine);
    const next = await runPhaseSynthesize(engine, ordinary);
    expect(next.status).toBe('ok');
    expect(next.details.publish_pending).toBeUndefined();
    expect(next.details.written_slugs).toEqual([slug]);
    expect(calls()).toBe(spent);
    expect(await engine.executeRaw('SELECT id FROM minion_jobs ORDER BY id')).toEqual(jobsBefore);
    expect(await engine.executeRaw<{ request_id: string; state: string }>(
      "SELECT request_id::text, state FROM persistence_requests WHERE source_id=$1 AND slug=$2 AND intent->>'kind'='managed_maintenance_page'", [sourceId, slug]))
      .toEqual([{ request_id: pending.request_id, state: 'committed' }]);
    const snapshot = (await engine.readPageSnapshot(slug, { sourceId }))!;
    expect(snapshot.page.frontmatter.dream_generated).toBe(true);
    expect(snapshot.page.compiled_truth).not.toContain('"an entirely invented');
    expect(await engine.getConfig('dream.synthesize.last_completion_ts')).not.toBeNull();
  });
}, 120_000);

test('#6051: a contended output admission is deferred like a pending publish, then finished by the next cycle without new spend', async () => {
  await fixture(async f => {
    const { engine, sourceId, calls } = f;
    const { ordinary, slug, jobsBefore, spent } = await childCommittedOrdinaryCycle(f);
    const before = (await engine.readPageSnapshot(slug, { sourceId }))!;
    const outputRequests = () => engine.executeRaw<{ state: string }>(
      "SELECT state FROM persistence_requests WHERE source_id=$1 AND slug=$2 AND intent->>'kind'='managed_maintenance_page'", [sourceId, slug]);
    const contention = contendAdmissions((target) => target === slug);
    let deferred: Awaited<ReturnType<typeof runPhaseSynthesize>>;
    try { deferred = await runPhaseSynthesize(engine, ordinary); }
    finally { contention.restore(); }
    expect(contention.injected()).toBe(1);
    expect(deferred.status).toBe('warn');
    expect(deferred.details.publish_pending).toBe(1);
    expect(deferred.details.publish_deferred).toBe('publish deferred (writer busy); finishes next cycle, no action needed');
    expect(deferred.details.pages_written).toBe(0);
    expect(await engine.getConfig('dream.synthesize.last_completion_ts')).toBeNull();
    expect(await outputRequests()).toEqual([]);
    expect((await engine.readPageSnapshot(slug, { sourceId }))!.revision).toBe(before.revision);
    expect(contention.stderr()).toMatch(new RegExp(`${slug} \\(request [0-9a-f-]+\\) deferred, write admission blocked by database contention`));
    await disposePersistenceConsumer(engine);
    const next = await runPhaseSynthesize(engine, ordinary);
    expect(next.status).toBe('ok');
    expect(next.details.publish_pending).toBeUndefined();
    expect(next.details.written_slugs).toEqual([slug]);
    expect(calls()).toBe(spent);
    expect(await engine.executeRaw('SELECT id FROM minion_jobs ORDER BY id')).toEqual(jobsBefore);
    expect(await outputRequests()).toEqual([{ state: 'committed' }]);
    expect((await engine.readPageSnapshot(slug, { sourceId }))!.page.frontmatter.dream_generated).toBe(true);
    expect(await engine.getConfig('dream.synthesize.last_completion_ts')).not.toBeNull();
  });
}, 120_000);

test('#6051: a contended summary admission defers the summary, and the next cycle writes it', async () => {
  await fixture(async f => {
    const { engine, sourceId, root, calls } = f;
    const { ordinary, slug, spent } = await childCommittedOrdinaryCycle(f);
    // The output publish admits; every later admission (the summary) is contended.
    const contention = contendAdmissions((target) => target !== slug);
    let deferred: Awaited<ReturnType<typeof runPhaseSynthesize>>;
    try { deferred = await runPhaseSynthesize(engine, ordinary); }
    finally { contention.restore(); }
    expect(contention.injected()).toBeGreaterThan(0);
    expect(deferred.status).toBe('warn');
    expect(deferred.details.publish_pending).toBe(1);
    expect(deferred.details.written_slugs).toEqual([slug]);
    const summarySlug = String(deferred.details.summary_slug);
    expect(await engine.readPageSnapshot(summarySlug, { sourceId })).toBeNull();
    expect(contention.stderr()).toContain(`${summarySlug} deferred, write admission blocked by database contention`);
    expect(await engine.getConfig('dream.synthesize.last_completion_ts')).toBeNull();
    await disposePersistenceConsumer(engine);
    const next = await runPhaseSynthesize(engine, ordinary);
    expect(next.status).toBe('ok');
    expect(calls()).toBe(spent);
    expect((await engine.readPageSnapshot(summarySlug, { sourceId }))!.page.compiled_truth).toContain(`[[${slug}]]`);
    expect(readFileSync(join(root, `${summarySlug}.md`), 'utf8')).toContain(`[[${slug}]]`);
    expect(await engine.getConfig('dream.synthesize.last_completion_ts')).not.toBeNull();
  });
}, 120_000);

test('#6051: a storage error that is not admission contention still fails the phase and stays retryable', async () => {
  await fixture(async f => {
    const { engine, sourceId } = f;
    const { ordinary, slug } = await childCommittedOrdinaryCycle(f);
    const admitWrite = journal.admitWrite;
    const spy = spyOn(journal, 'admitWrite').mockImplementation(async (eng, input, ...rest) => {
      if (input.slug !== slug) return admitWrite(eng, input, ...rest);
      throw Object.assign(new OperationError('storage_error', 'Synthetic storage failure.', 'Synthetic hint.'), { detail: 'disk_full' });
    });
    let failed: Awaited<ReturnType<typeof runPhaseSynthesize>>;
    try { failed = await runPhaseSynthesize(engine, ordinary); }
    finally { spy.mockRestore(); }
    expect(failed.status).toBe('fail');
    expect(failed.details.publish_pending).toBeUndefined();
    expect(await engine.getConfig('dream.synthesize.last_completion_ts')).toBeNull();
    expect(await engine.executeRaw(
      "SELECT 1 FROM persistence_requests WHERE source_id=$1 AND slug=$2 AND intent->>'kind'='managed_maintenance_page'", [sourceId, slug])).toEqual([]);
  });
}, 120_000);

/** #6757: the server's statement-timeout error (or a user cancel, which shares SQLSTATE 57014) on the matching read. */
const STATEMENT_TIMEOUT = () => Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
function failCommittedOutputsRead(engine: BrainEngine, error: () => Error = STATEMENT_TIMEOUT) {
  let hits = 0;
  // Unbound: a transaction view inherits the method and must keep running on its own connection.
  const executeRaw = engine.executeRaw as (this: unknown, ...args: unknown[]) => unknown;
  const spy = spyOn(engine, 'executeRaw').mockImplementation((async function (this: unknown, sql: string, ...rest: unknown[]) {
    if (sql === COMMITTED_OUTPUT_REQUESTS_SQL) { hits++; throw error(); }
    return executeRaw.call(this, sql, ...rest);
  }) as never);
  return { hits: () => hits, restore: () => spy.mockRestore() };
}
const quietly = async <T>(fn: () => Promise<T>): Promise<T> => {
  const write = spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
  try { return await fn(); } finally { write.mockRestore(); }
};

test('#6757: a committed-outputs read past the statement timeout defers the pass; after the transcript grows and the child rows are pruned, the replay itself runs zero child jobs and verifies the output\'s quotes against the current transcript', async () => {
  await fixture(async ({ engine, sourceId, root, opts, calls }) => {
    const timeout = failCommittedOutputsRead(engine);
    let deferred: Awaited<ReturnType<typeof runPhaseSynthesize>>;
    try { deferred = await quietly(() => runPhaseSynthesize(engine, opts)); } finally { timeout.restore(); }
    expect(timeout.hits()).toBe(1);
    expect(deferred.status, JSON.stringify(deferred.error ?? deferred.summary)).toBe('warn');
    expect(deferred.details.postprocess_deferred).toMatchObject({ read: 'committed_outputs', outputs: 1, consecutive: 1 });
    expect(deferred.summary).toContain('postprocessing deferred: the committed-outputs read hit the statement timeout');
    expect(deferred.details.publish_deferred).toBeUndefined();
    expect(deferred.details.pages_written).toBe(0);
    expect(await engine.getConfig('dream.synthesize.last_completion_ts')).toBeNull();
    const slug = await outputSlug(engine, sourceId);
    const unstamped = (await engine.readPageSnapshot(slug, { sourceId }))!.page;
    expect(unstamped.frontmatter.dream_generated).toBeUndefined();
    expect(unstamped.compiled_truth).toContain('"an entirely invented');

    // The transcript grows (a new content hash) and `jobs prune` removes the child's rows.
    appendFileSync(opts.inputFile, 'User: one more line added after the first synthesis.\n');
    await engine.executeRaw("DELETE FROM subagent_tool_executions WHERE job_id IN (SELECT id FROM minion_jobs WHERE data->>'source_id'=$1)", [sourceId]);
    await engine.executeRaw("DELETE FROM minion_jobs WHERE data->>'source_id'=$1", [sourceId]);
    await disposePersistenceConsumer(engine);
    // A grown transcript is new input: dream may synthesize it again under its new hash. Here it triages below the
    // threshold so that this pass submits no child of its own, and everything below is the replay of the deferred output.
    let synthesisCalls = 0;
    __setChatTransportForTests(async o => {
      const triage = (o.system ?? '').startsWith('You triage a conversation transcript');
      if (!triage) synthesisCalls++;
      const text = triage ? JSON.stringify({ score: 0.1, content_type: 'routine', segments: [], entities: [], reasons: ['routine'] }) : JSON.stringify({ pages: [], skipped: true });
      return { text, blocks: [{ type: 'text', text }], stopReason: 'end', usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: o.model!, providerId: 'anthropic' };
    });
    const spent = calls();
    const next = await quietly(() => runPhaseSynthesize(engine, opts));
    expect(next.status, JSON.stringify(next.error ?? next.summary)).toBe('ok');
    expect(synthesisCalls).toBe(0);
    expect(calls()).toBe(spent);
    expect(next.details.children_submitted ?? 0).toBe(0);
    expect(await engine.executeRaw("SELECT id FROM minion_jobs WHERE name = 'subagent' AND data->>'source_id'=$1", [sourceId])).toEqual([]);
    expect(next.details.postprocess_resumed).toEqual([slug]);
    expect(next.details.written_slugs).toEqual([slug]);
    const stamped = (await engine.readPageSnapshot(slug, { sourceId }))!.page;
    expect(stamped.frontmatter.dream_generated).toBe(true);
    // The grown transcript still lacks the invented quotation, so it fails grounding the way any unfound quote does.
    expect(stamped.compiled_truth).not.toContain('"an entirely invented');
    expect(stamped.frontmatter.unverified_claims).toEqual([expect.objectContaining({ reason: 'quote_not_in_source', detail: 'an entirely invented quotation that should lose its marks' })]);
    expect(stamped.frontmatter.quote_verification).toBeUndefined();
    expect(readFileSync(join(root, `${slug}.md`), 'utf8')).toContain('dream_generated: true');
    expect(JSON.parse(await engine.getConfig(POSTPROCESS_PENDING_KEY) ?? '{}')[sourceId]).toBeUndefined();
  });
}, 120_000);

test('#6757: a postprocess request read past the statement timeout defers that output, and the next ordinary pass finishes it without a provider call', async () => {
  await fixture(async ({ engine, sourceId, opts, calls }) => {
    await interruptAfterChild(engine, sourceId, opts);
    const slug = await outputSlug(engine, sourceId);
    const spent = calls();
    const getWriteRequest = journal.getWriteRequest;
    let hits = 0;
    const spy = spyOn(journal, 'getWriteRequest').mockImplementation(async (...args) => {
      if (!hits++) throw STATEMENT_TIMEOUT();
      return getWriteRequest(...args);
    });
    let deferred: Awaited<ReturnType<typeof runPhaseSynthesize>>;
    try { deferred = await quietly(() => runPhaseSynthesize(engine, opts)); } finally { spy.mockRestore(); }
    expect(deferred.status, JSON.stringify(deferred.error ?? deferred.summary)).toBe('warn');
    expect(deferred.details.postprocess_deferred).toMatchObject({ read: 'postprocess_request', outputs: 1, consecutive: 1 });
    expect(deferred.details.pages_written).toBe(0);
    expect(await engine.getConfig('dream.synthesize.last_completion_ts')).toBeNull();
    expect((await engine.readPageSnapshot(slug, { sourceId }))!.page.frontmatter.dream_generated).toBeUndefined();
    await disposePersistenceConsumer(engine);
    const next = await runPhaseSynthesize(engine, opts);
    expect(next.status, JSON.stringify(next.error ?? next.summary)).toBe('ok');
    expect(calls()).toBe(spent);
    expect(next.details.written_slugs).toEqual([slug]);
    expect((await engine.readPageSnapshot(slug, { sourceId }))!.page.frontmatter.dream_generated).toBe(true);
    expect((await engine.readPageSnapshot(slug, { sourceId }))!.page.frontmatter.quote_verification).toBeUndefined();
    expect(JSON.parse(await engine.getConfig(POSTPROCESS_PENDING_KEY) ?? '{}')[sourceId]).toBeUndefined();
  });
}, 120_000);

test('#6757: a user cancel on the committed-outputs read (SQLSTATE 57014, not a statement timeout) still fails the phase and defers nothing', async () => {
  await fixture(async ({ engine, sourceId, opts }) => {
    const cancel = failCommittedOutputsRead(engine, () => Object.assign(new Error('canceling statement due to user request'), { code: '57014' }));
    let failed: Awaited<ReturnType<typeof runPhaseSynthesize>>;
    try { failed = await runPhaseSynthesize(engine, opts); } finally { cancel.restore(); }
    expect(cancel.hits()).toBe(1);
    expect(failed.status).toBe('fail');
    expect(failed.error?.code).toBe('SYNTH_PHASE_FAIL');
    expect(JSON.parse(await engine.getConfig(POSTPROCESS_PENDING_KEY) ?? '{}')[sourceId]).toBeUndefined();
  });
}, 120_000);

test('#6757: three deferred passes in a row put a line on doctor persistence_request_indexes; it names the rebuild only when the index is missing, and clears once a pass completes', async () => {
  await fixture(async ({ engine, sourceId, opts, calls }) => {
    const spent: number[] = [];
    for (let pass = 1; pass <= 3; pass++) {
      const timeout = failCommittedOutputsRead(engine);
      let deferred: Awaited<ReturnType<typeof runPhaseSynthesize>>;
      try { deferred = await quietly(() => runPhaseSynthesize(engine, opts)); } finally { timeout.restore(); }
      expect(deferred.details.postprocess_deferred).toMatchObject({ read: 'committed_outputs', consecutive: pass });
      await disposePersistenceConsumer(engine);
      spent.push(calls());
      if (pass === 2) expect((await requestIndexesCheck(engine)).status).toBe('ok');
    }
    expect(new Set(spent).size).toBe(1);
    const valid = await requestIndexesCheck(engine);
    expect(valid.status).toBe('warn');
    expect(valid.message).toContain(`3 passes in a row on source ${sourceId}`);
    expect(valid.message).toContain('the committed-outputs read');
    expect(valid.message).toContain('1 output(s) pending');
    expect(valid.message).not.toContain('gbrain repair request-indexes');
    expect(valid.details).toMatchObject({ count: 0, postprocess_deferred: [expect.objectContaining({ source_id: sourceId, consecutive_passes: 3, read: 'committed_outputs', pending_outputs: 1 })] });
    await engine.executeRaw(`DROP INDEX ${PERSISTENCE_REQUEST_ID_INDEX.name}`);
    try {
      const missing = await requestIndexesCheck(engine);
      expect(missing.message).toContain(`${PERSISTENCE_REQUEST_ID_INDEX.name} is missing`);
      expect(missing.message).toContain('gbrain repair request-indexes');
      expect(missing.message).toContain(`3 passes in a row on source ${sourceId}`);
    } finally { await buildIndexOnline(engine, 0, PERSISTENCE_REQUEST_ID_INDEX); }
    const next = await runPhaseSynthesize(engine, opts);
    expect(next.status, JSON.stringify(next.error ?? next.summary)).toBe('ok');
    expect(calls()).toBe(spent[0]);
    expect(await requestIndexesCheck(engine)).toMatchObject({ status: 'ok', message: 'Request-table indexes are valid.' });
  });
}, 180_000);

// A shared wait may leave admitted writes pending while later admissions hit an outstanding cap (#6916).
for (const scope of ['principal', 'brain'] as const) {
  test(`synthesis defers ${scope} outstanding admission and replays the same request IDs`, async () => {
    const { MaintenanceWriteWait } = await import('../src/core/persistence/maintenance-wait.ts');
    const { isWriteCapacityWait, outstandingCapacityOf } = await import('../src/core/persistence/admission-retry.ts');
    await fixture(async f => {
      const { engine, sourceId, root, calls } = f;
      const { ordinary, jobsBefore, spent } = await childCommittedOrdinaryCycle(f);
      const ready = await engine.executeRaw<{ slug: string }>(
        "SELECT slug FROM pages WHERE source_id=$1 AND slug LIKE 'wiki/personal/reflections/session%' ORDER BY slug", [sourceId]);
      expect(ready).toHaveLength(4);
      const children = await engine.executeRaw<{ state: string }>(
        "SELECT state FROM persistence_requests WHERE source_id=$1 AND operation='put_page' AND slug LIKE 'wiki/personal/reflections/session%'", [sourceId]);
      expect(children).toHaveLength(4);
      expect(children.every(r => r.state === 'committed')).toBe(true);
      const baseline = await engine.executeRaw<{ outstanding_count: number | string }>('SELECT outstanding_count FROM persistence_counters');
      expect(baseline.every(r => Number(r.outstanding_count) === 0)).toBe(true);
      await disposePersistenceConsumer(engine);
      const key = `persistence.limits.${scope}_outstanding`;
      const previous = await engine.getConfig(key);
      const events: unknown[] = [];
      let restoreWait: (() => void) | undefined;
      let msSpy: { mockRestore(): void } | undefined, observeSpy: { mockRestore(): void } | undefined, admitSpy: { mockRestore(): void } | undefined;
      const binding = await getWorktreeBinding(engine, sourceId);
      if (!binding) throw new Error('No worktree binding for publication barrier');
      const lock = await acquireWorktree(binding, 1000);
      if (!lock) throw new Error('Publication barrier was not acquired');
      try {
      restoreWait = __setMaintenanceWriteWaitForTests(300); // existing #5854 seam, same value
      const originalMs = MaintenanceWriteWait.prototype.ms;
      const originalObserve = MaintenanceWriteWait.prototype.observe;
      const originalAdmit = journal.admitWrite;
      msSpy = spyOn(MaintenanceWriteWait.prototype, 'ms').mockImplementation(function (this: InstanceType<typeof MaintenanceWriteWait>) {
        const ms = originalMs.call(this); events.push({ kind: 'wait_ms', ms }); return ms;
      });
      observeSpy = spyOn(MaintenanceWriteWait.prototype, 'observe').mockImplementation(function (this: InstanceType<typeof MaintenanceWriteWait>, row) {
        events.push({ kind: 'observe', request_id: row.request_id, state: row.state });
        return originalObserve.call(this, row);
      });
      admitSpy = spyOn(journal, 'admitWrite').mockImplementation(async (...args) => {
        const [eng, input] = args;
        try {
          const row = await originalAdmit(...args);
          if (eng === engine && input.sourceId === sourceId) events.push({ kind: 'admitted', request_id: row.request_id, slug: row.slug,
            state: row.state, counters: await engine.executeRaw('SELECT key,outstanding_count FROM persistence_counters ORDER BY key') });
          return row;
        } catch (error) {
          if (eng === engine && input.sourceId === sourceId) events.push({ kind: 'refusal', request_id: input.requestId, slug: input.slug,
            error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
            code: error instanceof OperationError ? error.code : null, detail: error instanceof OperationError ? error.detail : null,
            classified: isWriteCapacityWait(error), capacity: error instanceof OperationError ? outstandingCapacityOf(error) : null,
            counters: await engine.executeRaw('SELECT key,outstanding_count FROM persistence_counters ORDER BY key') });
          throw error;
        }
      });
        await engine.setConfig(key, '2'); // this entirely disposable scratch DB only
        const report = await runPhaseSynthesize(engine, ordinary);
        // Only this retryable refusal is a hold: nothing is published or stamped early.
        expect(report.status).toBe('warn');
        expect(report.error).toBeUndefined();
        expect(report.details.pages_written).toBe(0);
        expect(report.details.publish_pending).toBe(4);
        expect(events.some(e => (e as { kind: string; ms?: number }).kind === 'wait_ms' && (e as { ms?: number }).ms === 0)).toBe(true);
        const rows = await engine.executeRaw<{ state: PersistenceRequestState }>(
          "SELECT state FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='managed_maintenance_page'", [sourceId]);
        expect(rows).toHaveLength(2);
        const refused = events.filter(e => (e as { kind: string }).kind === 'refusal') as Array<{ code: string; detail: string; classified: boolean; capacity: { outstanding: number; limit: number; scope: string }; request_id: string }>;
        expect(refused).toHaveLength(2);
        expect(new Set(refused.map(row => row.request_id)).size).toBe(2);
        expect(events.filter(e => (e as { kind: string }).kind === 'admitted')).toHaveLength(2);
        for (const refusal of refused) {
          expect(refusal).toMatchObject({ code: 'queue_capacity', detail: 'outstanding=2 limit=2', classified: true, capacity: { outstanding: 2, limit: 2, scope } });
          expect(await engine.executeRaw('SELECT request_id FROM persistence_requests WHERE request_id=$1::uuid', [refusal.request_id])).toEqual([]);
        }
        expect(rows.every(r => !isTerminalRequest(r) && ['queued', 'running', 'recovering'].includes(r.state))).toBe(true);
        expect(await engine.getConfig('dream.synthesize.last_completion_ts')).toBeNull();
        for (const { slug } of ready) expect((await engine.readPageSnapshot(slug, { sourceId }))!.page.frontmatter.dream_generated).not.toBe(true);
        expect(calls()).toBe(spent);
        expect(await engine.executeRaw('SELECT id FROM minion_jobs ORDER BY id')).toEqual(jobsBefore);
      } finally {
        try {
          try { admitSpy?.mockRestore(); } finally { try { observeSpy?.mockRestore(); } finally { try { msSpy?.mockRestore(); } finally { restoreWait?.(); } } }
        } finally {
          try { if (previous === null) await engine.unsetConfig(key); else await engine.setConfig(key, previous); }
          finally { await lock.release(); }
        }
        // fixture-level finally disposes the consumer even if validation throws.
      }
      // Ordinary recovery only after actual barrier release; pending is not written.
      await disposePersistenceConsumer(engine);
      const retained = await engine.executeRaw<{ request_id: string }>(
        "SELECT request_id::text FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='managed_maintenance_page' ORDER BY sequence", [sourceId]);
      const recovery = await runPhaseSynthesize(engine, ordinary);
      expect(recovery.status).toBe('ok');
      expect(calls()).toBe(spent);
      expect(await engine.executeRaw('SELECT id FROM minion_jobs ORDER BY id')).toEqual(jobsBefore);
      for (const { slug } of ready) expect((await engine.readPageSnapshot(slug, { sourceId }))!.page.frontmatter.dream_generated).toBe(true);
      for (const row of retained) expect(await engine.executeRaw('SELECT state FROM persistence_requests WHERE request_id=$1::uuid', [row.request_id])).toEqual([{ state: 'committed' }]);
      const refusedBeforeRelease = events.filter(e => (e as { kind: string }).kind === 'refusal') as Array<{ request_id: string }>;
      expect(refusedBeforeRelease).toHaveLength(2);
      // These IDs had NO row at refusal; ordinary replay must derive the SAME IDs, not allocate replacements.
      for (const refusal of refusedBeforeRelease) expect(await engine.executeRaw(
        'SELECT state FROM persistence_requests WHERE request_id=$1::uuid', [refusal.request_id])).toEqual([{ state: 'committed' }]);
      expect((await engine.executeRaw<{ outstanding_count: number | string }>('SELECT outstanding_count FROM persistence_counters')).every(r => Number(r.outstanding_count) === 0)).toBe(true);
      expect(await engine.getConfig('dream.synthesize.last_completion_ts')).not.toBeNull();
      const stable = await engine.executeRaw('SELECT request_id::text,state FROM persistence_requests WHERE source_id=$1 ORDER BY sequence', [sourceId]);
      expect((await runPhaseSynthesize(engine, ordinary)).status).toBe('ok');
      expect(calls()).toBe(spent);
      expect(await engine.executeRaw('SELECT id FROM minion_jobs ORDER BY id')).toEqual(jobsBefore);
      expect(await engine.executeRaw('SELECT request_id::text,state FROM persistence_requests WHERE source_id=$1 ORDER BY sequence', [sourceId])).toEqual(stable);
    }, 4);
  }, 120_000); // original surrounding fixture cap, no enlargement
}

// Other refusal classes retain their original error and fail the phase.
test('synthesis preserves non-outstanding publication refusals', async () => {
  const { isWriteCapacityWait, outstandingCapacityOf } = await import('../src/core/persistence/admission-retry.ts');
  const { deferPublishOrThrow } = await import('../src/core/cycle/synthesize-postprocess.ts');
  const cases: Array<{ id: string; kind: string; code: string | null; message: string; detail: string | null; helper_expected: boolean; receipt_state?: string }> = [
    {"id": "generic-error", "kind": "Error", "code": null, "message": "Write capacity exhausted: principal outstanding requests.", "detail": "outstanding=2 limit=2", "helper_expected": false},
    {"id": "plain-object", "kind": "plain-object", "code": "queue_capacity", "message": "Write capacity exhausted: principal outstanding requests.", "detail": "outstanding=2 limit=2", "helper_expected": false},
    {"id": "generic-queue", "kind": "OperationError", "code": "queue_capacity", "message": "Generic capacity failure.", "detail": null, "helper_expected": false},
    {"id": "zero-principal-cap", "kind": "OperationError", "code": "queue_capacity", "message": "Write capacity exhausted: principal outstanding requests.", "detail": "outstanding=0 limit=0", "helper_expected": true},
    {"id": "zero-brain-cap", "kind": "OperationError", "code": "queue_capacity", "message": "Write capacity exhausted: brain outstanding requests.", "detail": "outstanding=0 limit=0", "helper_expected": true},
    {"id": "unknown-scope-structured", "kind": "OperationError", "code": "queue_capacity", "message": "Write capacity exhausted: unknown resource.", "detail": "outstanding=2 limit=2", "helper_expected": true},
    {"id": "intent-bytes", "kind": "OperationError", "code": "queue_capacity", "message": "Write capacity exhausted: principal intent bytes.", "detail": null, "helper_expected": false},
    {"id": "receipt-bytes", "kind": "OperationError", "code": "write_quota_exhausted", "message": "Reserved receipt bytes exhausted.", "detail": "persistence.limits.principal_terminal_bytes", "helper_expected": false},
    {"id": "lifetime", "kind": "OperationError", "code": "write_quota_exhausted", "message": "Permanent request IDs exhausted.", "detail": "persistence.limits.principal_lifetime_ids", "helper_expected": false},
    {"id": "permission", "kind": "OperationError", "code": "permission_denied", "message": "Write capacity exhausted: principal outstanding requests.", "detail": "outstanding=2 limit=2", "helper_expected": false},
    {"id": "storage", "kind": "OperationError", "code": "storage_error", "message": "Storage unavailable.", "detail": "disk_full", "helper_expected": false},
    {"id": "malformed-9", "kind": "OperationError", "code": "queue_capacity", "message": "Write capacity exhausted: principal outstanding requests.", "detail": "outstanding=-1 limit=2", "helper_expected": false},
    {"id": "malformed-10", "kind": "OperationError", "code": "queue_capacity", "message": "Write capacity exhausted: principal outstanding requests.", "detail": "outstanding=2 limit=2 trailing", "helper_expected": false},
    {"id": "malformed-11", "kind": "OperationError", "code": "queue_capacity", "message": "Write capacity exhausted: principal outstanding requests.", "detail": " outstanding=2 limit=2", "helper_expected": false},
    {"id": "malformed-12", "kind": "OperationError", "code": "queue_capacity", "message": "Write capacity exhausted: principal outstanding requests.", "detail": "outstanding=2", "helper_expected": false},
    {"id": "malformed-13", "kind": "OperationError", "code": "queue_capacity", "message": "Write capacity exhausted: principal outstanding requests.", "detail": "outstanding=2 limit=NaN", "helper_expected": false},
    {"id": "realcapacity-with-receipt-committed", "kind": "OperationError", "code": "queue_capacity", "message": "Write capacity exhausted: principal outstanding requests.", "detail": "outstanding=2 limit=2", "helper_expected": true, "receipt_state": "committed"},
    {"id": "realcapacity-with-receipt-queued", "kind": "OperationError", "code": "queue_capacity", "message": "Write capacity exhausted: principal outstanding requests.", "detail": "outstanding=2 limit=2", "helper_expected": true, "receipt_state": "queued"},
    {"id": "realcapacity-with-receipt-unknown", "kind": "OperationError", "code": "queue_capacity", "message": "Write capacity exhausted: principal outstanding requests.", "detail": "outstanding=2 limit=2", "helper_expected": true, "receipt_state": "unknown"},
  ];
  for (const item of cases) {
    let error: unknown;
    if (item.kind === 'plain-object') error = { code: item.code, message: item.message, detail: item.detail };
    else if (item.kind === 'Error') error = Object.assign(new Error(item.message), { detail: item.detail });
    else error = Object.assign(new OperationError(item.code as ConstructorParameters<typeof OperationError>[0], item.message, 'Inspect the refused publication.'), { detail: item.detail ?? undefined });
    if (item.receipt_state) Object.assign(error as object, { writeRequest: { request_id: '00000000-0000-4000-8000-000000000001', state: item.receipt_state } });
    expect(isWriteCapacityWait(error), item.id).toBe(item.helper_expected);
    if (item.id === 'unknown-scope-structured') expect(outstandingCapacityOf(error as OperationError).scope).toBeNull();
    let caught: unknown = Symbol('not-thrown');
    try { deferPublishOrThrow(error, 'refused-publication'); } catch (failure) { caught = failure; }
    expect(caught, item.id).toBe(error);
  }
});
