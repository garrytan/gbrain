/**
 * Fix wave 4 lane B (TODOS "user timeline bullets on pages other preserving
 * writers regenerate"): add_timeline_entry marks the bullet on every page a
 * writer regenerates from its own inputs, so that writer's preserving
 * republish carries it instead of deleting it. Ordinary pages stay unmarked.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { maintenancePreflight, publishMaintenancePage } from '../src/core/persistence/prepared-maintenance.ts';
import { withEnv } from './helpers/with-env.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';

let engine: PGLiteEngine;
const dir = mkdtempSync(join(tmpdir(), 'gbrain-regenerated-timeline-'));
const root = join(dir, 'brain');
const home = join(dir, 'home');
const sourceId = 'regenerated-timeline';
let ctx: OperationContext;
const submit = (operation: string, params: Record<string, unknown>) => submitPageMutation(ctx, { operation, params: { request_id: randomUUID(), ...params } });
beforeAll(async () => {
  mkdirSync(root);
  engine = new PGLiteEngine();
  ctx = { engine, config: { engine: 'pglite' }, sourceId, remote: false, dryRun: false, logger: { info() {}, warn() {}, error() {} } } as OperationContext;
  await engine.connect({}); await engine.initSchema();
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
  await withEnv({ GBRAIN_HOME: home }, () => claimWorktree(engine, sourceId, root));
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
}, 120_000);
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); rmSync(dir, { recursive: true, force: true }); });

const writers = [
  { slug: 'dream/summary-2026-09-01', frontmatter: 'dream_generated: true\ndream_cycle_date: 2026-09-01\n', regenerated: true },
  { slug: 'life/events/2026-09-01-abcd1234', frontmatter: 'captured_via: life-chronicle:auto\n', regenerated: true },
  { slug: 'reports/drift-2026-09-01', frontmatter: '', regenerated: true },
  { slug: 'notes/ordinary', frontmatter: '', regenerated: false },
];

for (const writer of writers) {
  test(`${writer.slug}: a user bullet is ${writer.regenerated ? 'marked and survives the writer\'s preserving republish' : 'unmarked on an ordinary page'}`, async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const page = (body: string) => `---\ntype: note\ntitle: Example\n${writer.frontmatter}---\n${body}\n`;
    await submit('put_page', { slug: writer.slug, content: page('Generated body v1') });
    await submit('add_timeline_entry', { slug: writer.slug, date: '2026-09-15', summary: 'User note added by hand', source: 'user' });
    const added = (await engine.readPageSnapshot(writer.slug, { sourceId }))!;
    expect(added.page.timeline.includes('gbrain:materialized')).toBe(writer.regenerated);
    // The writer republishes from its own inputs through its preserving maintenance publication.
    const authority = (await maintenancePreflight(engine, sourceId, root))!;
    await publishMaintenancePage(engine, authority, writer.slug, page('Generated body v2'), { expectedRevision: added.revision, file: false });
    const after = (await engine.readPageSnapshot(writer.slug, { sourceId }))!;
    expect(after.page.compiled_truth).toContain('Generated body v2');
    const rows = await engine.getTimeline(writer.slug, { sourceId });
    expect(rows.some(row => row.summary === 'User note added by hand')).toBe(writer.regenerated);
    expect(after.page.timeline.includes('User note added by hand')).toBe(writer.regenerated);
  }), 60_000);
}

test('repeating an identical entry written before the page was regenerated-owned is still a duplicate, not a conflict', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  const slug = 'dream/legacy-entry';
  await submit('put_page', { slug, content: '---\ntype: note\ntitle: Legacy\n---\nBody\n' });
  const entry = { slug, date: '2026-09-16', summary: 'Pre-upgrade user note', source: 'user' };
  await submit('add_timeline_entry', entry);
  const before = (await engine.readPageSnapshot(slug, { sourceId }))!;
  expect(before.page.timeline).not.toContain('gbrain:materialized');
  await submit('put_page', { slug, content: serializePageToMarkdown({ ...before.page, frontmatter: { ...before.page.frontmatter, dream_generated: true } }, before.tags),
    expected_revision: before.revision });
  const replay = await submit('add_timeline_entry', entry);
  expect(replay.status).toBe('skipped');
}), 60_000);
