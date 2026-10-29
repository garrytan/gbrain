/**
 * `gbrain repair file-drift --prefer file` keeps the file's bytes. When the reviewed result still differs from the
 * file (a tag or protected key only the database holds, a timeline entry only the database holds, scan state only
 * the file holds), the apply rewrites only those lines; the rest of the file keeps its key order, quoting, list
 * style and whitespace.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { liveFileDrift } from '../src/core/persistence/drift-conflicts.ts';
import { repairRunner } from '../src/core/repair/registry.ts';
import { resolveRepairScope } from '../src/core/repair/core.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { withEnv } from './helpers/with-env.ts';

const logger = { info() {}, warn() {}, error() {} };
const SLUG = 'notes/styled';

describe('repair file-drift --prefer file keeps the file bytes it does not have to change', () => {
  let engine: BrainEngine;
  const dataDir = mkdtempSync(join(tmpdir(), 'gbrain-keep-bytes-db-'));
  beforeAll(async () => {
    configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
    const pglite = new PGLiteEngine();
    await pglite.connect({ database_path: dataDir }); await pglite.initSchema(); engine = pglite;
  }, 120_000);
  afterAll(async () => {
    await disposePersistenceConsumer(engine);
    await engine.disconnect();
    resetGateway(); rmSync(dataDir, { recursive: true, force: true });
  });

  async function fixture(run: (input: { root: string; sourceId: string; ctx: OperationContext }) => Promise<void>): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-keep-bytes-'));
    const root = join(dir, 'brain'); mkdirSync(root);
    execFileSync('git', ['init', '-q'], { cwd: root });
    const sourceId = `keep-${randomUUID().slice(0, 8)}`;
    try {
      await withEnv({ GBRAIN_HOME: join(dir, 'home') }, async () => {
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
        await engine.setConfig('sync.write_through', 'true');
        await claimWorktree(engine, sourceId, root);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
        const ctx = { engine, sourceId, remote: false, config: { engine: engine.kind, embedding_disabled: true } as never, dryRun: false, logger } as OperationContext;
        await run({ root, sourceId, ctx });
      });
    } finally {
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const put = (ctx: OperationContext, content: string) =>
    submitPageMutation(ctx, { operation: 'put_page', params: { slug: SLUG, content, request_id: randomUUID() } });
  const repair = async (sourceId: string) => {
    const scope = await resolveRepairScope(engine, sourceId);
    const options = { explicit: true, sourceFlag: sourceId, slugs: [SLUG], prefer: 'file' as const };
    const preview = await (await repairRunner(engine, { apply: false, logger })).run('file-drift', scope, options);
    return (await repairRunner(engine, { apply: true, logger })).run('file-drift', scope, { ...options, expect: preview.preview_hash! });
  };
  /** The written file restyled by hand: keys reordered, values double-quoted, lists in other styles, extra blank lines. */
  const restyle = (written: string, extra: string, stamps = /^(source_kind|ingested_via|ingested_at|trust_tier):/) => {
    const [, head, body] = written.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)!;
    const stamped = head.split('\n').filter(line => stamps.test(line)).reverse()
      .map(line => line.replace(/^(\w+): '?([^']*)'?$/, '$1: "$2"'));
    return `---\ntitle: "Styled Note"\n${stamped.join('\n')}\n${extra}aliases: [ 'first', "second" ]\ntype: note\n---\n\n\n`
      + `${body.trim().replace('Stored body.', 'Stored body.\n\n\nEdited in the file.')}\n\n`;
  };

  test('a tag only the database holds is appended to the file\'s tag list, a protected key it lacks is added, and nothing else changes', () => fixture(async ({ root, sourceId, ctx }) => {
    await put(ctx, '---\ntype: note\ntitle: Styled Note\naliases: [first, second]\ntags: [alpha, beta]\n---\nStored body.\n');
    const file = join(root, `${SLUG}.md`);
    const before = restyle(readFileSync(file, 'utf8'), 'tags:\n- "alpha"\n', /^(ingested_via|ingested_at|trust_tier):/);
    writeFileSync(file, before);
    expect((await liveFileDrift(engine, sourceId, SLUG)).still_present).toBe(true);

    expect((await repair(sourceId)).outcomes).toEqual({ repaired: 1 });
    expect(readFileSync(file, 'utf8')).toBe(before.replace('- "alpha"\n', '- "alpha"\n- beta\n').replace('type: note\n---', 'type: note\nsource_kind: put_page\n---'));
    expect(await engine.getTags(SLUG, { sourceId })).toEqual(['alpha', 'beta']);
    expect((await liveFileDrift(engine, sourceId, SLUG)).still_present).toBe(false);
  }), 240_000);

  test('a timeline entry only the database holds is added to the file\'s timeline section, file-only scan state is dropped, and nothing else changes', () => fixture(async ({ root, sourceId, ctx }) => {
    await put(ctx, '---\ntype: note\ntitle: Styled Note\naliases: [first, second]\n---\nStored body.\n\n<!-- timeline -->\n\n- **2024-01-02** | Stored entry.\n');
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.addTimelineEntry(SLUG, { date: '2024-03-04', summary: 'Database-only entry.', source: 'test' }, { sourceId });
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const file = join(root, `${SLUG}.md`);
    const before = restyle(readFileSync(file, 'utf8'), 'atoms_scan_hash: "file-only"\n');
    writeFileSync(file, before);
    expect((await liveFileDrift(engine, sourceId, SLUG)).still_present).toBe(true);

    expect((await repair(sourceId)).outcomes).toEqual({ repaired: 1 });
    const after = readFileSync(file, 'utf8'), kept = before.replace('atoms_scan_hash: "file-only"\n', '').trimEnd();
    expect(after.slice(0, kept.length)).toBe(kept);
    expect(after.slice(kept.length)).toMatch(/^\n<!-- gbrain:materialized v1 [0-9a-f]+ -->\n- \*\*2024-03-04\*\* \| test — Database-only entry\.\n\n$/);
    expect((await liveFileDrift(engine, sourceId, SLUG)).still_present).toBe(false);
  }), 240_000);
});
