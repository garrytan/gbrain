import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, OperationError, type OperationContext } from '../src/core/operations.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { resetGateway } from '../src/core/ai/gateway.ts';

let engine: PGLiteEngine;
let root: string;
let brainDir: string;

const putPage = operations.find((op) => op.name === 'put_page')!;
const patchPage = operations.find((op) => op.name === 'patch_page')!;
const getPage = operations.find((op) => op.name === 'get_page')!;
const capture = operations.find((op) => op.name === 'capture')!;

function ctx(): OperationContext {
  return {
    engine,
    config: { engine: 'pglite' as const },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: false,
    sourceId: 'default',
  };
}

async function rejection(params: Record<string, unknown>): Promise<OperationError> {
  try {
    await putPage.handler(ctx(), params);
  } catch (error) {
    return error as OperationError;
  }
  throw new Error('expected put_page rejection');
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  resetGateway();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  resetGateway();
  root = mkdtempSync(join(tmpdir(), 'c1-containment-'));
  brainDir = join(root, 'brain');
  require('node:fs').mkdirSync(brainDir, { recursive: true });
  await engine.setConfig('sync.repo_path', brainDir);
});

afterEach(() => {
  if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
});

describe('C1 containment activation', () => {
  test('feature is off by default for backward compatibility', async () => {
    const result = await putPage.handler(ctx(), {
      slug: 'concepts/legacy-create',
      content: '---\ntype: concept\ntitle: Legacy\n---\n\nbody',
    }) as { status: string };
    expect(result.status).toBe('created_or_updated');
  });

  test('unsupported create writes no canonical or derived page', async () => {
    await engine.setConfig('writer.c1_containment', 'true');
    const error = await rejection({
      slug: 'concepts/blocked',
      content: '---\ntype: concept\ntitle: Blocked\n---\n\nbody',
    });
    expect(error.code).toBe('unsupported_type');
    expect(await engine.getPage('concepts/blocked', { sourceId: 'default' })).toBeNull();
    expect(existsSync(join(brainDir, 'concepts/blocked.md'))).toBe(false);
  });

  test('supported create remains on the legacy path in the narrow first slice', async () => {
    await engine.setConfig('writer.c1_containment', 'true');
    const result = await putPage.handler(ctx(), {
      slug: 'people/legacy-create',
      content: '---\ntype: person\ntitle: Legacy Create\n---\n\nbody',
    }) as { status: string };
    expect(result.status).toBe('created_or_updated');
    expect(await engine.getPage('people/legacy-create', { sourceId: 'default' })).not.toBeNull();
  });

  test('supported typed create with safety core succeeds', async () => {
    await engine.setConfig('writer.c1_containment', 'true');
    const result = await putPage.handler(ctx(), {
      slug: 'people/safe-create',
      content: `---
type: person
title: Safe Create
tenant_id: tenant-example
privacy: private
immutable_identity:
  scheme: owner-created
  value: person-safe-create
lineage:
  source: user-confirmed
---

body
`,
    }) as { status: string };
    expect(result.status).toBe('created_or_updated');
    expect(await engine.getPage('people/safe-create', { sourceId: 'default' })).not.toBeNull();
  });

  test('unsupported type admission is case and whitespace normalized', async () => {
    await engine.setConfig('writer.c1_containment', 'true');
    const error = await rejection({
      slug: 'concepts/case-bypass',
      content: '---\ntype: " Concept "\ntitle: Case Bypass\n---\n\nbody',
    });
    expect(error.code).toBe('unsupported_type');
    expect(await engine.getPage('concepts/case-bypass', { sourceId: 'default' })).toBeNull();
  });

  test('new capture still works while explicit existing capture remains blocked', async () => {
    await engine.setConfig('writer.c1_containment', 'true');
    const result = await capture.handler(ctx(), { content: 'new captured note' }) as { status: string; slug: string };
    expect(result.status).toBe('created_or_updated');
    expect(await engine.getPage(result.slug, { sourceId: 'default' })).not.toBeNull();
  });

  test('existing whole-page replacement is blocked; revision-bound patch remains available', async () => {
    await putPage.handler(ctx(), {
      slug: 'people/existing',
      content: '---\ntype: person\ntitle: Existing\ncompany: Example Co\n---\n\nbody',
    });
    await engine.setConfig('writer.c1_containment', 'true');
    const error = await rejection({
      slug: 'people/existing',
      content: '---\ntype: person\ntitle: Existing\nrole: Advisor\n---\n\nbody',
    });
    expect(error.code).toBe('revision_required');

    const page = await getPage.handler(ctx(), { slug: 'people/existing' }) as { canonical_revision: string };
    const patched = await patchPage.handler(ctx(), {
      slug: 'people/existing',
      base_revision: page.canonical_revision,
      frontmatter_set: { role: 'Advisor' },
    }) as { status: string };
    expect(patched.status).toBe('patched');
    expect((await engine.getPage('people/existing', { sourceId: 'default' }))?.frontmatter.company).toBe('Example Co');
  });

  test('capture with an explicit existing slug cannot bypass revision-bound updates', async () => {
    await putPage.handler(ctx(), {
      slug: 'notes/existing-capture',
      content: '---\ntype: note\ntitle: Existing Capture\nowner: original\n---\n\noriginal body',
    });
    await engine.setConfig('writer.c1_containment', 'true');
    let error: OperationError | undefined;
    try {
      await capture.handler(ctx(), {
        slug: 'notes/existing-capture',
        content: 'replacement body',
      });
    } catch (caught) {
      error = caught as OperationError;
    }
    expect(error?.code).toBe('revision_required');
    expect((await engine.getPage('notes/existing-capture', { sourceId: 'default' }))?.frontmatter.owner).toBe('original');
  });

  test('canonical file without a derived row is still treated as existing', async () => {
    const file = join(brainDir, 'people/file-only.md');
    require('node:fs').mkdirSync(join(brainDir, 'people'), { recursive: true });
    require('node:fs').writeFileSync(file, '---\ntype: person\ntitle: File Only\ncompany: Preserve Me\n---\n\noriginal');
    await engine.setConfig('writer.c1_containment', 'true');
    const error = await rejection({
      slug: 'people/file-only',
      content: '---\ntype: person\ntitle: File Only\nrole: Replacement\n---\n\nreplacement',
    });
    expect(error.code).toBe('revision_required');
    expect(require('node:fs').readFileSync(file, 'utf8')).toContain('company: Preserve Me');
    expect(await engine.getPage('people/file-only', { sourceId: 'default' })).toBeNull();
  });

  test('concurrent same-slug creates serialize so only one can create', async () => {
    await engine.setConfig('writer.c1_containment', 'true');
    const attempts = await Promise.allSettled([
      putPage.handler(ctx(), { slug: 'people/race', content: '---\ntype: person\ntitle: First\n---\n\nfirst' }),
      putPage.handler(ctx(), { slug: 'people/race', content: '---\ntype: person\ntitle: Second\n---\n\nsecond' }),
    ]);
    expect(attempts.filter((result) => result.status === 'fulfilled').length).toBe(1);
    const rejected = attempts.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect((rejected.reason as OperationError).code).toBe('revision_required');
    expect(await engine.getPage('people/race', { sourceId: 'default' })).not.toBeNull();
  });

  test('duplicate-id redirect cannot rewrite an existing canonical page', async () => {
    await putPage.handler(ctx(), {
      slug: 'people/canonical-owner',
      content: '---\ntype: person\ntitle: Canonical Owner\nid: shared-person-id\nrole: Founder\n---\n\noriginal',
    });
    const ownerFile = join(brainDir, 'people/canonical-owner.md');
    writeFileSync(ownerFile, readFileSync(ownerFile, 'utf8').replace('role: Founder', 'role: Founder\nfile_only_note: preserve-me'));
    await engine.setConfig('writer.c1_containment', 'true');

    const error = await rejection({
      slug: 'people/duplicate-request',
      content: '---\ntype: person\ntitle: Duplicate Request\nid: shared-person-id\nrole: Replacement\n---\n\nreplacement',
    });
    expect(error.code).toBe('revision_required');
    expect(readFileSync(ownerFile, 'utf8')).toContain('file_only_note: preserve-me');
    expect(readFileSync(ownerFile, 'utf8')).toContain('role: Founder');
    expect(await engine.getPage('people/duplicate-request', { sourceId: 'default' })).toBeNull();
  });
});
