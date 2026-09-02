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
