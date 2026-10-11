/**
 * #5974: opt-in structural resolution of file/database drift. Pure
 * classifier truth table, then the reporter's page shape end to end on PGLite
 * (and an isolated Postgres database when DATABASE_URL is set): audit
 * classification, --auto-additive preview, apply, the previously blocked
 * remember, and independent readback through the MCP route.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configDir } from '../src/core/config.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { ParsedPage } from '../src/core/import-file.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { parseMarkdown, serializePageToMarkdown } from '../src/core/markdown.ts';
import { parseFactsFence } from '../src/core/facts-fence.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { registerLocalWriter, withVerifiedLocalRegistration, type LocalRegistration } from '../src/core/persistence/identity.ts';
import { runReconcileApply, runReconcilePreview } from '../src/core/persistence/reconcile.ts';
import { auditCanonicalSource } from '../src/core/persistence/reconcile-audit.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { classifyDrift, classifyTextInsertion } from '../src/core/persistence/reconcile-additive.ts';
import { operationsByName } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { withEnv } from './helpers/with-env.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const page = (over: Partial<ParsedPage> = {}): ParsedPage => ({ type: 'person', title: 'Example', compiled_truth: 'Line one.\nLine two.',
  timeline: '- **2026-01-01** | meeting — Met about the plan.', frontmatter: { contacts: ['alice-example', 'bob-example'], updated: '2026-01-01T00:00:00.000Z' },
  tags: ['friend'], ...over });
const NOW = Date.parse('2026-10-03T00:00:00Z');
const classOf = (file: ParsedPage, db = page()) => Object.fromEntries(classifyDrift(file, db, NOW).paths.map(p => [p.path, `${p.class}:${p.reason}`]));

describe('structural drift classifier', () => {
  test('inserted whole lines are suggested; changed, removed or structural insertions need review', () => {
    expect(classifyTextInsertion('A\nnew\nB\nC\nappended', 'A\nB\nC')).toEqual({ ok: true, inserted: 2 });
    expect(classifyTextInsertion('A\r\nB\r\nC', 'A\nB\nC')).toEqual({ ok: true, inserted: 0 });
    expect(classifyTextInsertion('A\nB changed\nC', 'A\nB\nC')).toEqual({ ok: false, reason: 'database_text_changed_or_removed' });
    expect(classifyTextInsertion('A\nC', 'A\nB\nC')).toEqual({ ok: false, reason: 'database_text_changed_or_removed' });
    expect(classifyTextInsertion('B\nA', 'A\nB')).toEqual({ ok: false, reason: 'database_text_changed_or_removed' });
    expect(classifyTextInsertion('A not\nB', 'A\nB')).toEqual({ ok: false, reason: 'database_text_changed_or_removed' });
    expect(classifyTextInsertion('A\n## New heading\nB', 'A\nB')).toEqual({ ok: false, reason: 'heading_insertion' });
    expect(classifyTextInsertion('A\n| 9 | row |\nB', 'A\nB')).toEqual({ ok: false, reason: 'table_insertion' });
    expect(classifyTextInsertion('A\n<!--- gbrain:facts:begin -->\nx\n<!--- gbrain:facts:end -->\nB', 'A\nB')).toEqual({ ok: false, reason: 'fence_insertion' });
    expect(classifyTextInsertion('A\n```\ncode\n```\nB', 'A\nB')).toEqual({ ok: false, reason: 'fence_insertion' });
    // Structure only: an appended contradiction is still "insertion-only", which is why prose stays suggested.
    expect(classifyTextInsertion('A\nB\nCorrection: the above is wrong.', 'A\nB')).toEqual({ ok: true, inserted: 1 });
  });

  test('contacts are append-only with multiplicity; dates advance only on the activity allowlist', () => {
    const ok = classOf(page({ frontmatter: { contacts: ['alice-example', 'bob-example', 'carol-example', 'alice-example'], updated: '2026-02-02T00:00:00.000Z' } }));
    expect(ok).toEqual({ '/frontmatter/contacts': 'auto:entries_appended', '/frontmatter/updated': 'auto:activity_date_advanced' });
    const db = page({ frontmatter: { contacts: ['a', 'a', 'b'] } });
    expect(classOf(page({ frontmatter: { contacts: ['a', 'b'] } }), db)['/frontmatter/contacts']).toBe('review:list_entries_removed');
    expect(classOf(page({ frontmatter: { contacts: ['a', 'b', 'a'] } }), db)['/frontmatter/contacts']).toBe('review:list_entries_changed_or_reordered');
    expect(classOf(page({ frontmatter: { contacts: ['a', 'a', 'b', 'c'] } }), db)['/frontmatter/contacts']).toBe('auto:entries_appended');
    expect(classOf(page({ frontmatter: { contacts: [{ name: 'a' }, 'a', 'b'] } }), db)['/frontmatter/contacts']).toBe('review:list_entries_changed_or_reordered');
    const date = (file: unknown, stored: unknown, key = 'phone_last_used') => classOf(page({ frontmatter: { [key]: file } }), page({ frontmatter: { [key]: stored } }))[`/frontmatter/${key}`];
    expect(date('2026-02-02', '2026-01-01')).toBe('auto:activity_date_advanced');
    expect(date('2025-12-31', '2026-01-01')).toBe('review:date_moved_backward');
    expect(date('2026-02-30', '2026-01-01')).toBe('review:invalid_date');
    expect(date('2026-02-02T00:00:00Z', '2026-01-01')).toBe('review:date_format_changed');
    expect(date('2030-01-01', '2026-01-01')).toBe('review:future_date');
    expect(date('2026-02-02', '2026-01-01', 'expires_at')).toBe('review:policy_field_changed');
    expect(date('2026-02-02', '2026-01-01', 'renewal_date')).toBe('review:value_changed');
  });

  test('policy, privacy, identity and tag changes always need review; one-sided ordinary fields are additive', () => {
    for (const key of ['access', 'confidentiality', 'visibility', 'grants', 'owner', 'aliases', 'trust', 'provenance']) {
      expect(classOf(page({ frontmatter: { ...page().frontmatter, [key]: 'private' } }))[`/frontmatter/${key}`]).toBe('review:policy_field_changed');
    }
    expect(classOf(page({ title: 'Renamed' }))['/title']).toBe('review:identity_field_changed');
    expect(classOf(page({ tags: ['friend', 'investor'] }))['/tags']).toBe('review:tags_changed');
    expect(classOf(page({ frontmatter: { ...page().frontmatter, phone: '555-0100' } }))['/frontmatter/phone']).toBe('auto:file_field_added');
    expect(classOf(page({ frontmatter: { contacts: ['alice-example', 'bob-example'] } }))['/frontmatter/updated']).toBe('auto:database_value_kept');
    expect(classifyDrift(page(), page(), NOW).verdict).toBe('no_drift');
    expect(classifyDrift(page({ compiled_truth: 'Line one.\nNew.\nLine two.' }), page(), NOW).verdict).toBe('additive_with_suggestions');
    expect(classifyDrift(page({ frontmatter: { ...page().frontmatter, access: 'public' } }), page(), NOW).verdict).toBe('review_required');
  });
});

const home = mkdtempSync(join(tmpdir(), 'gbrain-reconcile-additive-'));
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
const local = <T>(engine: BrainEngine, registration: LocalRegistration, fn: () => Promise<T>) => withVerifiedLocalRegistration(engine, registration, fn);

const STORED = `---\ntype: person\ntitle: Example\naccess: private\nvisibility: private\ncontacts:\n  - alice-example\n  - bob-example\nphone_last_used: '2026-01-01'\nupdated: '2026-01-01'\n---\nA synthetic biography.\n\nWorks at [[companies/acme-example]].\n\n## Timeline\n\n- **2026-01-01** | meeting — Met [[people/alice-example]] about the plan.\n`;

/** Two drifted pages: an insertion-only superset and one whose stored line was replaced. */
async function fixture(engine: BrainEngine) {
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  const id = `additive-${randomUUID().slice(0, 12)}`, root = join(home, id);
  mkdirSync(join(root, 'people'), { recursive: true });
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,\'{}\')', [id, root]);
  const write = async (slug: string, edit: (p: { compiled_truth: string; timeline: string; frontmatter: Record<string, unknown> }) => void) => {
    await importFromContent(engine, slug, STORED, { sourceId: id, sourcePath: `${slug}.md`, noEmbed: true });
    const snapshot = (await engine.readPageSnapshot(slug, { sourceId: id }))!;
    const next = { compiled_truth: snapshot.page.compiled_truth, timeline: snapshot.page.timeline ?? '', frontmatter: { ...snapshot.page.frontmatter } };
    edit(next);
    writeFileSync(join(root, `${slug}.md`), serializePageToMarkdown({ ...snapshot.page, ...next }, snapshot.tags));
    return snapshot;
  };
  const additive = await write('people/additive-example', p => {
    p.compiled_truth = p.compiled_truth.replace('A synthetic biography.', 'A synthetic biography.\nAlso advises [[companies/beta-example]].');
    p.timeline += '\n- **2026-02-02** | call — Spoke with [[people/carol-example]].';
    p.frontmatter.contacts = ['alice-example', 'bob-example', 'carol-example', 'alice-example'];
    p.frontmatter.phone_last_used = '2026-02-02';
    p.frontmatter.updated = '2026-02-02';
  });
  await write('people/replaced-example', p => { p.compiled_truth = p.compiled_truth.replace('A synthetic biography.', 'A different biography.'); });
  const binding = await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  const registration = await registerLocalWriter(engine, 'cli');
  return { id, root, binding, registration, additive };
}

test('the reporter\'s additive page reconciles under --auto-additive; a replaced page stays blocked; remember then commits and reads back', async () => isolated(async engine => {
  const f = await fixture(engine), slug = 'people/additive-example', file = join(f.root, `${slug}.md`);
  const ctx: OperationContext = { engine, remote: false, sourceId: f.id, config: { engine: engine.kind }, dryRun: false, logger: { info() {}, warn() {}, error() {} } };
  await local(engine, f.registration, async () => {
    const fact = 'Prefers the synthetic morning review.', provenance = 'Synthetic operator conversation';
    await expect(operationsByName.remember!.handler(ctx, { fact, provenance, entity: slug, visibility: 'private', request_id: randomUUID() }))
      .rejects.toMatchObject({ writeError: 'source_changed' });

    const audit = await auditCanonicalSource(engine, f.id, { classify: true });
    expect(audit.classified).toEqual({ structurally_additive: 0, additive_with_suggestions: 1, review_required: 1, formatting_only: 0, slug_rule_mismatch: 0, error: 0 });
    expect(JSON.stringify(audit)).not.toContain('carol-example');
    expect(audit.findings.find(x => x.slug === 'people/replaced-example')).toMatchObject({ classification: 'review_required',
      drift_paths: [{ path: '/compiled_truth', class: 'review', reason: 'database_text_changed_or_removed' }] });

    const blocked = await runReconcilePreview(engine, { source_id: f.id, slug: 'people/replaced-example', auto_additive: true });
    expect(blocked).toMatchObject({ status: 'needs_resolution', classification: 'review_required', auto_decided_paths: [] });

    const suggested = await runReconcilePreview(engine, { source_id: f.id, slug, auto_additive: true });
    expect(suggested).toMatchObject({ status: 'needs_resolution', classification: 'additive_with_suggestions',
      auto_decided_paths: ['/frontmatter/contacts', '/frontmatter/phone_last_used', '/frontmatter/updated'], conflict_paths: ['/compiled_truth', '/timeline'] });
    expect(String(suggested.next_action)).toContain('--accept-suggested');

    const ready = await runReconcilePreview(engine, { source_id: f.id, slug, auto_additive: true, accept_suggested: true });
    expect(ready.status).toBe('ready');
    expect(ready.preview.format_version).toBe(2);
    expect(ready.preview.auto_decisions!.map(d => d.rule)).toEqual(['text_insertion_only', 'contacts_append_only', 'activity_date_advance', 'activity_date_advance', 'text_insertion_only']);

    const tampered = structuredClone(ready.preview);
    tampered.auto_decisions![0].evidence_digest = '0'.repeat(64);
    await expect(runReconcileApply(engine, { source_id: f.id, slug, preview: tampered, request_id: randomUUID() })).rejects.toMatchObject({ code: 'source_changed' });

    const applied = await runReconcileApply(engine, { source_id: f.id, slug, preview: ready.preview, request_id: randomUUID() });
    expect(applied.state).toBe('committed');
    const backup = join(configDir(), 'reconciliation-previews', (applied.outcome as { backup_reference: string }).backup_reference);
    expect(existsSync(backup)).toBe(true);
    expect(JSON.parse(readFileSync(backup, 'utf8')).preview.preimages.database.page.compiled_truth).toBe(f.additive.page.compiled_truth);

    const reconciled = (await engine.readPageSnapshot(slug, { sourceId: f.id }))!;
    expect(reconciled.page.compiled_truth).toContain('Also advises [[companies/beta-example]].');
    expect(reconciled.page.timeline).toContain('Spoke with [[people/carol-example]]');
    expect(reconciled.page.frontmatter).toMatchObject({ access: 'private', visibility: 'private', phone_last_used: '2026-02-02',
      contacts: ['alice-example', 'bob-example', 'carol-example', 'alice-example'] });

    const saved = await operationsByName.remember!.handler(ctx, { fact, provenance, entity: slug, visibility: 'private', request_id: randomUUID() }) as Record<string, unknown>;
    expect(saved).toMatchObject({ status: 'inserted', state: 'committed' });
    const current = (await engine.readPageSnapshot(slug, { sourceId: f.id }))!;
    expect(parseFactsFence(current.page.compiled_truth).facts).toEqual(expect.arrayContaining([expect.objectContaining({ claim: fact, visibility: 'private' })]));
    expect(parseMarkdown(readFileSync(file, 'utf8'), slug).compiled_truth).toBe(current.page.compiled_truth);

    const read = await dispatchToolCall(engine, 'get_page', { slug, source_id: f.id }, { remote: false, sourceId: f.id, config: { engine: engine.kind },
      logger: { info() {}, warn() {}, error() {} } });
    expect(read.isError).toBeFalsy();
    expect((read.content[0] as { text: string }).text).toContain(fact);

    const stillBlocked = await operationsByName.remember!.handler({ ...ctx }, { fact, provenance, entity: 'people/replaced-example', visibility: 'private', request_id: randomUUID() })
      .then(() => null, e => e);
    expect(stillBlocked).toMatchObject({ writeError: 'source_changed' });
  });
}), 180_000);

test('a file change after an --auto-additive preview makes apply refuse instead of publishing stale decisions', async () => isolated(async engine => {
  const f = await fixture(engine), slug = 'people/additive-example', file = join(f.root, `${slug}.md`);
  await local(engine, f.registration, async () => {
    const ready = await runReconcilePreview(engine, { source_id: f.id, slug, auto_additive: true, accept_suggested: true });
    writeFileSync(file, readFileSync(file, 'utf8') + '\nA concurrent edit.\n');
    await expect(runReconcileApply(engine, { source_id: f.id, slug, preview: ready.preview, request_id: randomUUID() })).rejects.toMatchObject({ code: 'source_changed' });
    const again = await runReconcilePreview(engine, { source_id: f.id, slug, auto_additive: true, accept_suggested: true });
    expect(again.status).toBe('ready');
  });
}), 180_000);
