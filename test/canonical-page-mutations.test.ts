import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  applySparsePagePatch,
  CanonicalMutationError,
  commitCanonicalMutation,
  commitCanonicalMutationV2,
  exactCanonicalRevision,
} from '../src/core/canonical-page-mutations.ts';

let engine: PGLiteEngine;
let root: string;
let brainDir: string;
let journalRoot: string;
let lockRoot: string;

const ORIGINAL = `---
type: person
title: Example Person
id: person-1
company: Example Co
role: Founder
preferences:
  channel: email
tags:
  - contact
---

Original body.
`;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  root = mkdtempSync(join(tmpdir(), 'canonical-mutation-'));
  brainDir = join(root, 'brain');
  journalRoot = join(root, 'journal');
  lockRoot = join(root, 'locks');
  await engine.setConfig('sync.repo_path', brainDir);
  require('node:fs').mkdirSync(brainDir, { recursive: true });
});

function cleanup(): void {
  if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
}

afterEach(cleanup);

describe('sparse canonical patch semantics', () => {
  test('preserves omitted fields and treats nested values atomically', () => {
    const next = applySparsePagePatch(ORIGINAL, 'people/example-person', {
      frontmatter_set: { role: 'Advisor', preferences: { channel: 'signal' } },
    });
    expect(next).toContain('company: Example Co');
    expect(next).toContain('role: Advisor');
    expect(next).toContain('channel: signal');
    expect(next).toContain('Original body.');
  });

  test('explicit unset removes one field while immutable identity cannot be changed', () => {
    const next = applySparsePagePatch(ORIGINAL, 'people/example-person', {
      frontmatter_unset: ['role'],
    });
    expect(next).not.toContain('role: Founder');
    expect(next).toContain('company: Example Co');
    expect(() => applySparsePagePatch(ORIGINAL, 'people/example-person', {
      frontmatter_set: { id: 'person-2' },
    })).toThrow(CanonicalMutationError);
  });

  test('set_if_empty is three-state and never overwrites a populated value', () => {
    const next = applySparsePagePatch(ORIGINAL, 'people/example-person', {
      frontmatter_set_if_empty: { role: 'Other Role', city: 'Tokyo' },
    });
    expect(next).toContain('role: Founder');
    expect(next).toContain('city: Tokyo');
  });

  test('metadata-only patch preserves body bytes exactly', () => {
    const unusual = ORIGINAL.replace('Original body.\n', '\n  Original body with spaces.  \n\n\n');
    const beforeBody = unusual.slice(unusual.indexOf('---\n', 4) + 4);
    const next = applySparsePagePatch(unusual, 'people/example-person', {
      frontmatter_set: { role: 'Advisor' },
    });
    const afterBody = next.slice(next.indexOf('---\n', 4) + 4);
    expect(afterBody).toBe(beforeBody);
  });

  test('rejects ambiguous or prototype-polluting patch keys', () => {
    expect(() => applySparsePagePatch(ORIGINAL, 'people/example-person', {
      frontmatter_set: { role: 'Advisor' },
      frontmatter_unset: ['role'],
    })).toThrow(CanonicalMutationError);
    const dangerous = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
    expect(() => applySparsePagePatch(ORIGINAL, 'people/example-person', {
      frontmatter_set: dangerous,
    })).toThrow(CanonicalMutationError);
  });

  test('rejects active-pack graph fields supplied as additional reserved keys', () => {
    expect(() => applySparsePagePatch(
      ORIGINAL,
      'people/example-person',
      { frontmatter_set: { mentors: ['people/mentor'] } },
      new Set(['mentors']),
    )).toThrow(CanonicalMutationError);
  });
});

describe('canonical-first coordinator', () => {
  test('a failed create projection resumes with base_revision=null', async () => {
    const first = await commitCanonicalMutation({
      engine,
      slug: 'people/new-person',
      operation: 'put_page',
      baseRevision: null,
      journalRoot,
      lockRoot,
      buildContent: () => ORIGINAL,
      project: async () => { throw new Error('projection offline'); },
    });
    expect(first.projection_state).toBe('pending');

    const second = await commitCanonicalMutation({
      engine,
      slug: 'people/new-person',
      operation: 'put_page',
      baseRevision: null,
      journalRoot,
      lockRoot,
      buildContent: () => ORIGINAL,
      project: async (_content, revision) => revision,
    });
    expect(second.projection_state).toBe('current');
    expect(second.resumed).toBe(true);
    expect(second.canonical_revision).toBe(first.canonical_revision);
  });

  test('prepared journal resumes when canonical rename landed before state advancement', async () => {
    const first = await commitCanonicalMutation({
      engine,
      slug: 'people/crash-window',
      operation: 'put_page',
      baseRevision: null,
      journalRoot,
      lockRoot,
      buildContent: () => ORIGINAL,
      project: async () => { throw new Error('projection offline'); },
    });
    const intent = JSON.parse(readFileSync(first.journal_path, 'utf8'));
    intent.state = 'prepared';
    require('node:fs').writeFileSync(first.journal_path, `${JSON.stringify(intent, null, 2)}\n`);

    const resumed = await commitCanonicalMutation({
      engine,
      slug: 'people/crash-window',
      operation: 'put_page',
      baseRevision: null,
      journalRoot,
      lockRoot,
      buildContent: () => ORIGINAL,
      project: async (_content, revision) => revision,
    });
    expect(resumed.projection_state).toBe('current');
    expect(resumed.resumed).toBe(true);
  });

  test('stale revision conflicts before canonical or projected mutation', async () => {
    const file = join(brainDir, 'people/example-person.md');
    require('node:fs').mkdirSync(join(brainDir, 'people'), { recursive: true });
    require('node:fs').writeFileSync(file, ORIGINAL);
    const before = readFileSync(file, 'utf8');
    await expect(commitCanonicalMutation({
      engine,
      slug: 'people/example-person',
      operation: 'patch_page',
      baseRevision: 'sha256:stale',
      journalRoot,
      lockRoot,
      buildContent: () => applySparsePagePatch(ORIGINAL, 'people/example-person', { frontmatter_set: { role: 'Advisor' } }),
      project: async () => { throw new Error('must not run'); },
    })).rejects.toMatchObject({ code: 'revision_conflict' });
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  test('projection failure retains canonical bytes and resumes idempotently', async () => {
    const file = join(brainDir, 'people/example-person.md');
    require('node:fs').mkdirSync(join(brainDir, 'people'), { recursive: true });
    require('node:fs').writeFileSync(file, ORIGINAL);
    const base = exactCanonicalRevision(ORIGINAL);
    const build = () => applySparsePagePatch(ORIGINAL, 'people/example-person', { frontmatter_set: { role: 'Advisor' } });
    const first = await commitCanonicalMutation({
      engine,
      slug: 'people/example-person',
      operation: 'patch_page',
      baseRevision: base,
      journalRoot,
      lockRoot,
      buildContent: build,
      project: async () => { throw new Error('projection offline'); },
    });
    expect(first.projection_state).toBe('pending');
    expect(readFileSync(file, 'utf8')).toContain('role: Advisor');
    expect(JSON.parse(readFileSync(first.journal_path, 'utf8')).state).toBe('index_pending');

    const second = await commitCanonicalMutation({
      engine,
      slug: 'people/example-person',
      operation: 'patch_page',
      baseRevision: base,
      journalRoot,
      lockRoot,
      buildContent: build,
      project: async (_content, revision) => revision,
    });
    expect(second.projection_state).toBe('current');
    expect(second.resumed).toBe(true);
    expect(second.projected_revision).toBe(first.canonical_revision);
    expect(JSON.parse(readFileSync(second.journal_path, 'utf8')).state).toBe('projected');
  });

  test('a pending old intent cannot overwrite or project a newer canonical edit', async () => {
    const file = join(brainDir, 'people/example-person.md');
    require('node:fs').mkdirSync(join(brainDir, 'people'), { recursive: true });
    require('node:fs').writeFileSync(file, ORIGINAL);
    const base = exactCanonicalRevision(ORIGINAL);
    const build = () => applySparsePagePatch(ORIGINAL, 'people/example-person', {
      frontmatter_set: { role: 'Advisor' },
    });
    const first = await commitCanonicalMutation({
      engine,
      slug: 'people/example-person',
      operation: 'patch_page',
      baseRevision: base,
      journalRoot,
      lockRoot,
      buildContent: build,
      project: async () => { throw new Error('projection offline'); },
    });
    expect(first.projection_state).toBe('pending');

    const newer = applySparsePagePatch(readFileSync(file, 'utf8'), 'people/example-person', {
      frontmatter_set: { role: 'Operator' },
    });
    require('node:fs').writeFileSync(file, newer);
    let projectedOldIntent = false;
    await expect(commitCanonicalMutation({
      engine,
      slug: 'people/example-person',
      operation: 'patch_page',
      baseRevision: base,
      journalRoot,
      lockRoot,
      buildContent: build,
      project: async () => {
        projectedOldIntent = true;
        return null;
      },
    })).rejects.toMatchObject({ code: 'revision_conflict' });
    expect(projectedOldIntent).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(newer);
  });
});

describe('canonical-first v2 immutable receipts', () => {
  function seed(slug: string, content = ORIGINAL): string {
    const file = join(brainDir, `${slug}.md`);
    require('node:fs').mkdirSync(join(file, '..'), { recursive: true });
    require('node:fs').writeFileSync(file, content);
    return file;
  }

  test('replays the original receipt after a later canonical page mutation', async () => {
    const slug = 'people/receipt-replay';
    const file = seed(slug);
    const projected = new Set<string>();
    let projectCalls = 0;
    const invoke = () => commitCanonicalMutationV2({
      engine,
      principalId: 'oauth:client-a',
      slug,
      operation: 'append_page_event',
      idempotencyKey: 'gmail:message-1:people/receipt-replay',
      semanticRequest: { date: '2026-09-02', channel: 'email', note: 'Discussed renewal.' },
      baseRevision: exactCanonicalRevision(ORIGINAL),
      journalRoot,
      lockRoot,
      buildContent: (current) => applySparsePagePatch(current.content!, slug, { frontmatter_set: { last_contacted: '2026-09-02' } }),
      project: async (_content, revision) => { projectCalls += 1; projected.add(revision); },
      verifyProjection: async (_content, revision) => projected.has(revision),
    });

    const first = await invoke();
    expect(first.outcome).toBe('applied');
    if (first.outcome === 'pending') throw new Error('unexpected pending result');
    const originalReceipt = JSON.parse(JSON.stringify(first.receipt));

    const later = applySparsePagePatch(readFileSync(file, 'utf8'), slug, { frontmatter_set: { role: 'Operator' } });
    require('node:fs').writeFileSync(file, later);
    const replay = await invoke();
    expect(replay.outcome).toBe('replayed');
    if (replay.outcome === 'pending') throw new Error('unexpected pending result');
    expect(replay.receipt).toEqual(originalReceipt);
    expect(projectCalls).toBe(1);
    expect(readFileSync(file, 'utf8')).toBe(later);
  });

  test("'latest' binds an append to the revision read inside the page lock", async () => {
    const slug = 'people/latest-under-lock';
    seed(slug);
    const projected = new Set<string>();
    const result = await commitCanonicalMutationV2({
      engine,
      principalId: 'oauth:client-a',
      slug,
      operation: 'append_page_event',
      idempotencyKey: 'gmail:message-latest:people/latest-under-lock',
      semanticRequest: { note: 'Uses the lock-owned latest revision' },
      baseRevision: 'latest',
      journalRoot,
      lockRoot,
      buildContent: (current) => applySparsePagePatch(current.content!, slug, { frontmatter_set: { last_contacted: '2026-09-02' } }),
      project: async (_content, revision) => { projected.add(revision); },
      verifyProjection: async (_content, revision) => projected.has(revision),
    });
    expect(result.outcome).toBe('applied');
    if (result.outcome === 'pending') throw new Error('unexpected pending result');
    expect(result.receipt.base_revision).toBe(exactCanonicalRevision(ORIGINAL));
  });

  test('same receipt identity with a changed request or slug fails closed', async () => {
    const slug = 'people/idempotency-owner';
    const otherSlug = 'people/idempotency-other';
    const file = seed(slug);
    seed(otherSlug);
    const projected = new Set<string>();
    const call = (targetSlug: string, note: string) => commitCanonicalMutationV2({
      engine,
      principalId: 'oauth:client-a',
      slug: targetSlug,
      operation: 'append_page_event',
      idempotencyKey: 'gmail:message-2:people/idempotency-owner',
      semanticRequest: { date: '2026-09-02', channel: 'email', note },
      baseRevision: exactCanonicalRevision(ORIGINAL),
      journalRoot,
      lockRoot,
      buildContent: (current) => applySparsePagePatch(current.content!, targetSlug, { frontmatter_set: { last_contacted: '2026-09-02' } }),
      project: async (_content, revision) => { projected.add(revision); },
      verifyProjection: async (_content, revision) => projected.has(revision),
    });
    await call(slug, 'Original note');
    const after = readFileSync(file, 'utf8');
    await expect(call(slug, 'Changed note')).rejects.toMatchObject({ code: 'idempotency_conflict' });
    await expect(call(otherSlug, 'Original note')).rejects.toMatchObject({ code: 'idempotency_conflict' });
    expect(readFileSync(file, 'utf8')).toBe(after);
    expect(readFileSync(join(brainDir, `${otherSlug}.md`), 'utf8')).toBe(ORIGINAL);
  });

  test('same textual key is isolated by principal and source', async () => {
    const projected = new Set<string>();
    const invoke = (principalId: string, sourceId: string, slug: string) => commitCanonicalMutationV2({
      engine,
      principalId,
      sourceId,
      slug,
      operation: 'append_page_event',
      idempotencyKey: 'shared-textual-key',
      semanticRequest: { note: slug },
      baseRevision: null,
      journalRoot,
      lockRoot,
      buildContent: () => ORIGINAL.replace('Example Person', slug),
      project: async (_content, revision) => { projected.add(`${sourceId}:${revision}`); },
      verifyProjection: async (_content, revision) => projected.has(`${sourceId}:${revision}`),
    });
    const a = await invoke('oauth:a', 'default', 'people/principal-a');
    const b = await invoke('oauth:b', 'default', 'people/principal-b');
    const c = await invoke('oauth:a', 'secondary', 'people/source-secondary');
    expect([a.outcome, b.outcome, c.outcome]).toEqual(['applied', 'applied', 'applied']);
    expect(new Set([a.journal_path, b.journal_path, c.journal_path]).size).toBe(3);
  });

  test('two concurrent identical requests append once and share one immutable receipt', async () => {
    const slug = 'people/concurrent-receipt';
    const file = seed(slug);
    const projected = new Set<string>();
    let builds = 0;
    let projections = 0;
    const invoke = () => commitCanonicalMutationV2({
      engine,
      principalId: 'oauth:client-a',
      slug,
      operation: 'append_page_event',
      idempotencyKey: 'gmail:message-concurrent:people/concurrent-receipt',
      semanticRequest: { note: 'Concurrent event' },
      baseRevision: exactCanonicalRevision(ORIGINAL),
      journalRoot,
      lockRoot,
      buildContent: (current) => {
        builds += 1;
        return applySparsePagePatch(current.content!, slug, { frontmatter_set: { last_contacted: '2026-09-02' } });
      },
      project: async (_content, revision) => { projections += 1; projected.add(revision); },
      verifyProjection: async (_content, revision) => projected.has(revision),
    });
    const [first, second] = await Promise.all([invoke(), invoke()]);
    expect(new Set([first.outcome, second.outcome])).toEqual(new Set(['applied', 'replayed']));
    expect(builds).toBe(1);
    expect(projections).toBe(1);
    expect(readFileSync(file, 'utf8').match(/last_contacted:/g)?.length).toBe(1);
    if (first.outcome === 'pending' || second.outcome === 'pending') throw new Error('unexpected pending result');
    expect(first.receipt).toEqual(second.receipt);
  });

  test('recovers a lost projection response without projecting twice', async () => {
    const slug = 'people/projection-crash';
    seed(slug);
    const projected = new Set<string>();
    let projectCalls = 0;
    const invoke = () => commitCanonicalMutationV2({
      engine,
      principalId: 'oauth:client-a',
      slug,
      operation: 'append_page_event',
      idempotencyKey: 'gmail:message-crash:people/projection-crash',
      semanticRequest: { note: 'Crash window event' },
      baseRevision: exactCanonicalRevision(ORIGINAL),
      journalRoot,
      lockRoot,
      buildContent: (current) => applySparsePagePatch(current.content!, slug, { frontmatter_set: { last_contacted: '2026-09-02' } }),
      project: async (_content, revision) => {
        projectCalls += 1;
        projected.add(revision);
        throw new Error('response lost after committed projection');
      },
      verifyProjection: async (_content, revision) => projected.has(revision),
    });
    const first = await invoke();
    expect(first.outcome).toBe('pending');
    const second = await invoke();
    expect(second.outcome).toBe('applied');
    expect(projectCalls).toBe(1);
    const third = await invoke();
    expect(third.outcome).toBe('replayed');
    if (second.outcome === 'pending' || third.outcome === 'pending') throw new Error('unexpected pending result');
    expect(third.receipt).toEqual(second.receipt);
  });

  test('rejects a corrupted committed receipt instead of replaying success', async () => {
    const slug = 'people/corrupt-receipt';
    seed(slug);
    const projected = new Set<string>();
    const invoke = () => commitCanonicalMutationV2({
      engine,
      principalId: 'oauth:client-a',
      slug,
      operation: 'append_page_event',
      idempotencyKey: 'gmail:message-corrupt:people/corrupt-receipt',
      semanticRequest: { note: 'Receipt integrity event' },
      baseRevision: 'latest',
      journalRoot,
      lockRoot,
      buildContent: (current) => applySparsePagePatch(current.content!, slug, { frontmatter_set: { last_contacted: '2026-09-02' } }),
      project: async (_content, revision) => { projected.add(revision); },
      verifyProjection: async (_content, revision) => projected.has(revision),
    });
    const first = await invoke();
    expect(first.outcome).toBe('applied');
    const journal = JSON.parse(readFileSync(first.journal_path, 'utf8'));
    journal.receipt.slug = 'people/copied-elsewhere';
    require('node:fs').writeFileSync(first.journal_path, `${JSON.stringify(journal, null, 2)}\n`);
    await expect(invoke()).rejects.toMatchObject({ code: 'invalid_canonical' });
  });

  test('rejects a malformed pending journal envelope', async () => {
    const slug = 'people/malformed-pending';
    seed(slug);
    const invoke = () => commitCanonicalMutationV2({
      engine,
      principalId: 'oauth:client-a',
      slug,
      operation: 'append_page_event',
      idempotencyKey: 'gmail:message-malformed:people/malformed-pending',
      semanticRequest: { note: 'Pending envelope event' },
      baseRevision: 'latest',
      journalRoot,
      lockRoot,
      buildContent: (current) => applySparsePagePatch(current.content!, slug, { frontmatter_set: { last_contacted: '2026-09-02' } }),
      project: async () => { throw new Error('projection offline'); },
      verifyProjection: async () => false,
    });
    const first = await invoke();
    expect(first.outcome).toBe('pending');
    const journal = JSON.parse(readFileSync(first.journal_path, 'utf8'));
    journal.intended_revision = 'sha256:not-a-revision';
    require('node:fs').writeFileSync(first.journal_path, `${JSON.stringify(journal, null, 2)}\n`);
    await expect(invoke()).rejects.toMatchObject({ code: 'invalid_canonical' });
  });

  test('a pending receipt never reprojects or overwrites after canonical advances', async () => {
    const slug = 'people/pending-advanced';
    const file = seed(slug);
    let projectCalls = 0;
    const invoke = () => commitCanonicalMutationV2({
      engine,
      principalId: 'oauth:client-a',
      slug,
      operation: 'append_page_event',
      idempotencyKey: 'gmail:message-pending:people/pending-advanced',
      semanticRequest: { note: 'Pending projection event' },
      baseRevision: 'latest',
      journalRoot,
      lockRoot,
      buildContent: (current) => applySparsePagePatch(current.content!, slug, { frontmatter_set: { last_contacted: '2026-09-02' } }),
      project: async () => { projectCalls += 1; throw new Error('projection offline'); },
      verifyProjection: async () => false,
    });
    const first = await invoke();
    expect(first.outcome).toBe('pending');
    const later = applySparsePagePatch(readFileSync(file, 'utf8'), slug, { frontmatter_set: { role: 'Operator' } });
    require('node:fs').writeFileSync(file, later);
    const second = await invoke();
    expect(second).toMatchObject({ outcome: 'pending', retryable: false });
    expect(projectCalls).toBe(1);
    expect(readFileSync(file, 'utf8')).toBe(later);
  });

  test('recovers a prepared journal when canonical rename did not land', async () => {
    const slug = 'people/prepared-before-rename';
    const file = seed(slug);
    const projected = new Set<string>();
    const invoke = () => commitCanonicalMutationV2({
      engine,
      principalId: 'oauth:client-a',
      slug,
      operation: 'append_page_event',
      idempotencyKey: 'gmail:message-prepared:people/prepared-before-rename',
      semanticRequest: { note: 'Prepared recovery event' },
      baseRevision: 'latest',
      journalRoot,
      lockRoot,
      buildContent: (current) => applySparsePagePatch(current.content!, slug, { frontmatter_set: { last_contacted: '2026-09-02' } }),
      project: async (_content, revision) => { projected.add(revision); },
      verifyProjection: async (_content, revision) => projected.has(revision),
    });
    const first = await invoke();
    expect(first.outcome).toBe('applied');
    const journal = JSON.parse(readFileSync(first.journal_path, 'utf8'));
    journal.state = 'prepared';
    delete journal.receipt;
    journal.updated_at = journal.created_at;
    require('node:fs').writeFileSync(first.journal_path, `${JSON.stringify(journal, null, 2)}\n`);
    require('node:fs').writeFileSync(file, ORIGINAL);
    projected.clear();

    const recovered = await invoke();
    expect(recovered.outcome).toBe('applied');
    expect(readFileSync(file, 'utf8')).toMatch(/last_contacted:\s+['"]?2026-09-02['"]?/);
  });

  test('retries a projection that failed before committing', async () => {
    const slug = 'people/projection-retry';
    seed(slug);
    const projected = new Set<string>();
    let projectCalls = 0;
    let admissibilityCalls = 0;
    const invoke = () => commitCanonicalMutationV2({
      engine,
      principalId: 'oauth:client-a',
      slug,
      operation: 'append_page_event',
      idempotencyKey: 'gmail:message-projection-retry:people/projection-retry',
      semanticRequest: { note: 'Projection retry event' },
      baseRevision: 'latest',
      journalRoot,
      lockRoot,
      assertNewRequest: () => { admissibilityCalls += 1; },
      buildContent: (current) => applySparsePagePatch(current.content!, slug, { frontmatter_set: { last_contacted: '2026-09-02' } }),
      project: async (_content, revision) => {
        projectCalls += 1;
        if (projectCalls === 1) throw new Error('projection failed before commit');
        projected.add(revision);
      },
      verifyProjection: async (_content, revision) => projected.has(revision),
    });
    const first = await invoke();
    expect(first.outcome).toBe('pending');
    const second = await invoke();
    expect(second.outcome).toBe('applied');
    const third = await invoke();
    expect(third.outcome).toBe('replayed');
    expect(projectCalls).toBe(2);
    expect(admissibilityCalls).toBe(1);
  });
});
