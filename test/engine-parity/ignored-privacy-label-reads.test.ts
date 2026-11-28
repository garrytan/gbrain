/**
 * BrainEngine parity: the page reads behind the import notice for ignored privacy labels (`readIgnoredPrivacyLabelPages`,
 * `readLivePageFrontmatter`).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every arm, the labelled pages the bulk read returns are the live pages of the source, in the scope, whose
 *    labels gbrain ignores, with no `readable_by` and no folder rule; the limit applies after that filter; the single-page read
 *    returns a live page's stored type and frontmatter and null for a missing or deleted one.
 *  - Regression: the Rust scan kept a labelled page a folder rule covers, which the SQL read excludes (`folder_rule_ids IS NULL`),
 *    so the notice counted and named a page the folder already hides.
 *  - Why existing coverage misses it: the SQL notice cases (privacy-label-ignored.test.ts) seed no folder rule on the Rust
 *    shape, and the Rust store's own test reads the store directly, not through the TypeScript adapter that applies the label rule.
 *  - Seam: the Rust arm's folder rule is written through the store's own put_access_rule (BrainEngine has no typed member
 *    for it); the SQL arms insert the rule row before the page, as the stamping trigger needs.
 */
import { expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { RustEngine } from '../../src/core/rust-engine.ts';
import { createSource, parityArms, type ParityBackend } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const label = (mark: string, extra: Record<string, unknown> = {}) => ({ type: 'note' as const, title: mark, compiled_truth: `body ${mark}`, frontmatter: { access: 'team-only', mark, ...extra } });

/** A folder rule over `prefix` of `sourceId`: SQL rows on the SQL arms, the store's own rule on the Rust arm. */
async function ruleOver(engine: BrainEngine, backend: ParityBackend, sourceId: string, prefix: string): Promise<void> {
  if (backend === 'rust') {
    const brain = (engine as unknown as RustEngine).openStore('restrictFolder').brain as unknown as {
      putAccessPolicyState(sourceId: string): Promise<void>;
      putAccessRule(rule: Record<string, unknown>): Promise<void>;
    };
    await brain.putAccessPolicyState(sourceId);
    await brain.putAccessRule({ source_id: sourceId, rule_id: 'parity-rule', prefix, readable_by: ['member:parity'], revision: 1 });
    return;
  }
  await engine.executeRaw('INSERT INTO access_policy_state (source_id) VALUES ($1) ON CONFLICT (source_id) DO NOTHING', [sourceId]);
  await engine.executeRaw(`INSERT INTO access_rules (source_id, rule_id, prefix, readable_by, revision) VALUES ($1, 'parity-rule', $2, ARRAY['member:parity'], 1)`, [sourceId, prefix]);
}

const marks = (rows: Array<{ frontmatter: Record<string, unknown> | null }>) => rows.map(row => String(row.frontmatter?.mark)).sort();

async function seed(engine: BrainEngine, backend: ParityBackend): Promise<void> {
  await createSource(engine, backend, 'other');
  await ruleOver(engine, backend, 'default', 'secret/');
  await engine.putPage('notes/open', label('open'));
  await engine.putPage('notes/open-two', label('open-two'));
  await engine.putPage('secret/folder', label('folder'));
  await engine.putPage('notes/readers', label('readers', { readable_by: ['member:alice-example'] }));
  await engine.putPage('notes/recognized', label('recognized', { visibility: 'private' }));
  await engine.putPage('notes/plain', { type: 'note', title: 'plain', compiled_truth: 'plain', frontmatter: { mark: 'plain' } });
  await engine.putPage('notes/elsewhere', label('elsewhere'), { sourceId: 'other' });
  await engine.putPage('notes/gone', label('gone'));
  await engine.softDeletePage('notes/gone');
}

parityTest('the bulk read excludes a page a folder rule covers, a page naming readers and a page with a recognized label', { methods: ['readIgnoredPrivacyLabelPages', 'putPage', 'softDeletePage'] }, async (engine, backend) => {
  await seed(engine, backend);
  const slugs = ['notes/open', 'notes/open-two', 'secret/folder', 'notes/readers', 'notes/recognized', 'notes/plain', 'notes/elsewhere', 'notes/gone'];
  const bySlug = marks(await engine.readIgnoredPrivacyLabelPages('default', { slugs }));
  const bySince = marks(await engine.readIgnoredPrivacyLabelPages('default', { since: '2000-01-01T00:00:00Z' }));
  expect(bySlug).toEqual(['open', 'open-two']);
  expect(bySince).toEqual(['open', 'open-two']);
  return { bySlug, bySince };
});

parityTest('the limit applies to the pages that pass, not to the pages scanned', { methods: ['readIgnoredPrivacyLabelPages', 'putPage', 'softDeletePage'] }, async (engine, backend) => {
  await seed(engine, backend);
  const limited = await engine.readIgnoredPrivacyLabelPages('default', { since: '2000-01-01T00:00:00Z' }, { limit: 1 });
  const none = await engine.readIgnoredPrivacyLabelPages('default', { since: '2000-01-01T00:00:00Z' }, { limit: 0 });
  expect(limited).toHaveLength(1);
  expect(['open', 'open-two']).toContain(String(limited[0]!.frontmatter?.mark));
  expect(none).toEqual([]);
  return { limited: limited.length, none: none.length };
});

parityTest('the single-page read returns a live page\'s stored type and frontmatter, and null for a missing or deleted page', { methods: ['readLivePageFrontmatter', 'putPage', 'softDeletePage'] }, async (engine, backend) => {
  await seed(engine, backend);
  const open = await engine.readLivePageFrontmatter('default', 'notes/open');
  const folder = await engine.readLivePageFrontmatter('default', 'secret/folder');
  const gone = await engine.readLivePageFrontmatter('default', 'notes/gone');
  const missing = await engine.readLivePageFrontmatter('default', 'notes/never');
  const elsewhere = await engine.readLivePageFrontmatter('default', 'notes/elsewhere');
  expect(open?.type).toBe('note');
  expect(open?.frontmatter?.mark).toBe('open');
  expect(gone).toBeNull();
  expect(missing).toBeNull();
  expect(elsewhere).toBeNull();
  return { open: open?.frontmatter?.mark, folder: folder?.frontmatter?.mark, gone, missing, elsewhere };
});
