/**
 * BrainEngine parity: the link reads a remote entity card and a remote record continuation make over the served wire: the
 * relationship note of a card (listRelationshipNoteRows) and the record metadata of the referrers get_backlinks pages
 * (listRecordMetadataRows).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every arm (PGLite; Postgres with DATABASE_URL; the Rust arm, embedded or served) a remote caller (read policy
 *    world-only, excludePrivate true) gets the same answer from the loaders those operations call, and the answer names no private page.
 *    - loadRelationshipNotes (link-relationship-notes.ts, the card's note) names the company a person left, never a private company
 *      (a private target).
 *    - readRecordMetadata (mentions/referrers.ts, the record continuation) carries the amends link of a referrer to a readable record,
 *      never the amends link to a private page, and none of a private referrer.
 *  - Regression: on the served arm each member was refused for a remote caller (not on OWNER_IPC_REMOTE_TYPED_READS), so the card lost
 *    its note (the loader fails open) and the record continuation failed with a typed engine_capability_missing refusal.
 *  - Why existing coverage misses it: link-temporal.test.ts calls the members and the loaders on the arm's own engine with a scope the
 *    test builds; no case marked the caller remote, so the served wire never carried either.
 *  - Seam: none. Pages, links and transitions are written with putPage, addLink and writeManualLinkTransitions. The whole entity and
 *    get_backlinks operations are not the proof: on the served arm they also need members no served group owns (readReferrerGroupRows,
 *    readReferrerTypes, readReferrerTargetCounts), so the loaders are called directly under a remote world-only caller.
 */
import { expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { withRemoteCaller } from '../../src/core/remote-caller.ts';
import { withCallerAccess } from '../../src/core/search/private-visibility.ts';
import { loadRelationshipNotes, relationshipNoteKey } from '../../src/core/link-relationship-notes.ts';
import { readRecordMetadata } from '../../src/core/mentions/referrers.ts';
import { writeManualTransitions } from '../../src/core/link-temporal-apply.ts';

const { parityTest } = parityArms(testBackends());

const page = (title: string, type: string, frontmatter: Record<string, unknown> = {}) => ({ type: type as never, title, compiled_truth: `${title}.`, timeline: '', frontmatter });

const worldOnly = <T>(fn: () => Promise<T>) => withRemoteCaller(true, () => withCallerAccess({ identity: [], audience: null, audienceIdentities: [] }, fn));

parityTest('a remote world-only read of the relationship note that names the company a person left, never a private one', {
  methods: ['putPage', 'addLink', 'writeManualLinkTransitions', 'listRelationshipNoteRows'], timeout: 240_000,
}, async (engine: BrainEngine) => {
  await engine.putPage('people/notemark-alice', page('Notemark Alice', 'person'));
  await engine.putPage('companies/notemark-open-co', page('Notemark Open Co', 'company'));
  await engine.putPage('companies/notemark-hidden-co', page('Notemark Hidden Co', 'company', { visibility: 'private' }));
  for (const to of ['companies/notemark-open-co', 'companies/notemark-hidden-co']) {
    await engine.addLink('people/notemark-alice', to, 'works at', 'works_at', 'manual');
    await writeManualTransitions(engine, { from: 'people/notemark-alice', to, linkType: 'works_at', sourceId: 'default' }, { validFrom: '2020-01-01', validUntil: '2022-06-30' });
  }
  const notes = await worldOnly(() => loadRelationshipNotes(engine, [{ slug: 'people/notemark-alice', source_id: 'default', summary: 'Alice summary.' }], { excludePrivate: true }));
  const note = notes.get(relationshipNoteKey('default', 'people/notemark-alice')) ?? '';
  expect(note).toContain('notemark-open-co');
  expect(note).not.toContain('notemark-hidden-co');
  return { note };
});

parityTest('a remote world-only read of the record metadata carries the amends link to a readable record, never one to a private page or from a private referrer', {
  methods: ['putPage', 'getPage', 'addLink', 'listRecordMetadataRows'], timeout: 240_000,
}, async (engine: BrainEngine) => {
  await engine.putPage('crm/recmark-acme', page('Recmark Acme', 'company'));
  await engine.putPage('contracts/recmark-msa', page('Recmark MSA', 'contract'));
  await engine.putPage('contracts/recmark-amend', page('Recmark Amend', 'contract'));
  await engine.putPage('contracts/recmark-hidden-original', page('Recmark Hidden Original', 'contract', { visibility: 'private' }));
  await engine.putPage('contracts/recmark-private-amend', page('Recmark Private Amend', 'contract', { visibility: 'private' }));
  for (const from of ['contracts/recmark-msa', 'contracts/recmark-amend', 'contracts/recmark-private-amend']) {
    await engine.addLink(from, 'crm/recmark-acme', 'for Acme', 'mentions', 'manual');
  }
  await engine.addLink('contracts/recmark-amend', 'contracts/recmark-msa', 'amends', 'amends', 'manual');
  await engine.addLink('contracts/recmark-amend', 'contracts/recmark-hidden-original', 'amends', 'amends', 'manual');
  await engine.addLink('contracts/recmark-private-amend', 'contracts/recmark-msa', 'amends', 'amends', 'manual');
  const ids = new Map<string, number>();
  for (const slug of ['contracts/recmark-msa', 'contracts/recmark-amend', 'contracts/recmark-private-amend']) ids.set(slug, Number((await engine.getPage(slug))!.id));
  const meta = await worldOnly(() => readRecordMetadata(engine, [...ids.values()], { referrerSources: ['default'], excludePrivate: true }));
  const view = [...ids].map(([slug, id]) => ({ slug, amends: meta.get(id)?.amends?.map(a => a.slug) ?? null }));
  expect(view.find(r => r.slug === 'contracts/recmark-amend')?.amends).toEqual(['contracts/recmark-msa']);
  expect(JSON.stringify(view)).not.toContain('recmark-hidden-original');
  return view;
});
