/**
 * #8109: a person page whose frontmatter contact rows drifted (one row's
 * last_used moved forward in the file) no longer blocks an unrelated remember,
 * and the drift reconciles under --auto-additive as structurally additive.
 * Body, title and policy-field drift keep refusing. PGLite, and an isolated
 * Postgres database when DATABASE_URL is set.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { parseMarkdown, serializePageToMarkdown } from '../src/core/markdown.ts';
import { parseFactsFence } from '../src/core/facts-fence.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { registerLocalWriter, withVerifiedLocalRegistration } from '../src/core/persistence/identity.ts';
import { runReconcileApply, runReconcilePreview } from '../src/core/persistence/reconcile.ts';
import { liveFileDrift } from '../src/core/persistence/drift-conflicts.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { operationsByName } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { withEnv } from './helpers/with-env.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-contact-drift-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
beforeAll(async () => {
  const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); engines.push(engine);
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);
afterAll(async () => {
  await withEnv({ GBRAIN_HOME: home }, async () => { for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); } });
  await closePostgres?.(); rmSync(home, { recursive: true, force: true });
});
const isolated = (fn: (engine: BrainEngine) => Promise<void>) => withEnv({ GBRAIN_HOME: home, OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined }, async () => {
  for (const engine of engines) await fn(engine);
});

const SLUG = 'people/alice-example';
// The writer's shape: every touch appended a row, so the same phone is written three times. Unquoted YAML dates.
const STORED = `---
type: person
title: Alice Example
visibility: private
contacts:
  - type: phone
    value: '+15550100'
    last_used: 2026-10-01
  - type: email
    value: alice@example.com
    last_used: 2026-09-01
  - type: phone
    value: '+15550100'
    last_used: 2026-10-02
  - type: phone
    value: '+15550100'
    last_used: 2026-10-03
---
Alice Example is a synthetic person.

## Timeline

- **2026-01-01** | meeting — Met about the plan.
`;
type Editable = { title: string; compiled_truth: string; timeline: string; frontmatter: Record<string, unknown> };

async function fixture(engine: BrainEngine, edit: (page: Editable) => void) {
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  const id = `contacts-${randomUUID().slice(0, 12)}`, root = join(home, id);
  mkdirSync(join(root, 'people'), { recursive: true });
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,\'{}\')', [id, root]);
  await importFromContent(engine, SLUG, STORED, { sourceId: id, sourcePath: `${SLUG}.md`, noEmbed: true });
  const snapshot = (await engine.readPageSnapshot(SLUG, { sourceId: id }))!;
  const next: Editable = { title: snapshot.page.title, compiled_truth: snapshot.page.compiled_truth, timeline: snapshot.page.timeline ?? '',
    frontmatter: structuredClone(snapshot.page.frontmatter) };
  edit(next);
  writeFileSync(join(root, `${SLUG}.md`), serializePageToMarkdown({ ...snapshot.page, ...next }, snapshot.tags));
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  const registration = await registerLocalWriter(engine, 'cli');
  const ctx: OperationContext = { engine, remote: false, sourceId: id, config: { engine: engine.kind }, dryRun: false, logger: { info() {}, warn() {}, error() {} } };
  const local = <T>(fn: () => Promise<T>) => withVerifiedLocalRegistration(engine, registration, fn);
  return { id, root, file: join(root, `${SLUG}.md`), ctx, local, stored: snapshot };
}
const contactsOf = (frontmatter: Record<string, unknown>) => frontmatter.contacts as Array<Record<string, unknown>>;
const advance = (page: Editable) => { contactsOf(page.frontmatter)[2].last_used = '2026-10-30T00:00:00.000Z'; };
const remember = (ctx: OperationContext, fact: string) => operationsByName.remember!.handler(ctx,
  { fact, provenance: 'Synthetic operator conversation', entity: SLUG, visibility: 'private', request_id: randomUUID() }) as Promise<Record<string, unknown>>;

test('#8109: a last_used bump in the file does not block remember; the file keeps its frontmatter, and the drift reconciles as structurally additive', () => isolated(async engine => {
  const f = await fixture(engine, advance);
  await f.local(async () => {
    expect((await liveFileDrift(engine, f.id, SLUG)).reason).toBe('file_database_drift');
    const fact = 'Prefers the synthetic morning review.';
    const saved = await remember(f.ctx, fact);
    expect(saved).toMatchObject({ status: 'inserted', state: 'committed' });

    const db = (await engine.readPageSnapshot(SLUG, { sourceId: f.id }))!;
    expect(parseFactsFence(db.page.compiled_truth).facts).toEqual(expect.arrayContaining([expect.objectContaining({ claim: fact })]));
    // The database's frontmatter is untouched; the file keeps its advanced last_used and carries the same body.
    expect(db.page.frontmatter).toEqual(f.stored.page.frontmatter);
    const onDisk = parseMarkdown(readFileSync(f.file, 'utf8'), SLUG);
    expect(contactsOf(onDisk.frontmatter)[2].last_used).toBe('2026-10-30T00:00:00.000Z');
    expect(onDisk.compiled_truth).toBe(db.page.compiled_truth);
    expect(onDisk.timeline).toBe(db.page.timeline);
    // The frontmatter drift is still reported, for its own path.
    expect((await liveFileDrift(engine, f.id, SLUG)).reason).toBe('file_database_drift');

    // A second write lands the same way.
    expect(await remember(f.ctx, 'Reads synthetic newsletters.')).toMatchObject({ status: 'inserted', state: 'committed' });

    const ready = await runReconcilePreview(engine, { source_id: f.id, slug: SLUG, auto_additive: true });
    expect(ready).toMatchObject({ status: 'ready', classification: 'structurally_additive', auto_decided_paths: ['/frontmatter/contacts'] });
    expect(ready.preview.auto_decisions!.map(d => d.rule)).toEqual(['contacts_activity_advance']);
    expect((await runReconcileApply(engine, { source_id: f.id, slug: SLUG, preview: ready.preview, request_id: randomUUID() })).state).toBe('committed');
    const reconciled = (await engine.readPageSnapshot(SLUG, { sourceId: f.id }))!;
    expect(contactsOf(reconciled.page.frontmatter)[2].last_used).toBe('2026-10-30T00:00:00.000Z');
    expect(parseFactsFence(reconciled.page.compiled_truth).facts.map(row => row.claim)).toEqual(expect.arrayContaining([fact, 'Reads synthetic newsletters.']));
    expect((await liveFileDrift(engine, f.id, SLUG)).reason).toBe('agrees');
  });
}), 180_000);

for (const [name, edit] of [
  ['a policy field', (page: Editable) => { advance(page); page.frontmatter.visibility = 'public'; }],
  ['the body', (page: Editable) => { advance(page); page.compiled_truth += '\n\nA line added by hand.'; }],
  ['the title', (page: Editable) => { page.title = 'Alice Renamed'; page.frontmatter.title = 'Alice Renamed'; }],
] as const) {
  test(`#8109: drift in ${name} still refuses remember and leaves both copies as they were`, () => isolated(async engine => {
    const f = await fixture(engine, edit);
    const before = readFileSync(f.file, 'utf8');
    await f.local(async () => {
      await expect(remember(f.ctx, 'A fact that must wait.')).rejects.toMatchObject({ writeError: 'source_changed' });
    });
    expect(readFileSync(f.file, 'utf8')).toBe(before);
    expect((await engine.readPageSnapshot(SLUG, { sourceId: f.id }))!.revision).toBe(f.stored.revision);
  }), 180_000);
}

test('#8109: a write that changes frontmatter over frontmatter drift still refuses', () => isolated(async engine => {
  const f = await fixture(engine, advance);
  const before = readFileSync(f.file, 'utf8');
  await f.local(async () => {
    const content = serializePageToMarkdown({ ...f.stored.page, frontmatter: { ...f.stored.page.frontmatter, company: 'acme-example' } }, f.stored.tags);
    await expect(submitPageMutation({ ...f.ctx, sourceId: f.id }, { operation: 'put_page', params: { slug: SLUG, source_id: f.id, content,
      expected_revision: f.stored.revision, request_id: randomUUID() } })).rejects.toMatchObject({ code: 'source_changed' });
  });
  expect(readFileSync(f.file, 'utf8')).toBe(before);
}), 180_000);
