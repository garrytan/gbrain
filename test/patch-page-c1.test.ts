import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, OperationError, type OperationContext } from '../src/core/operations.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { resetGateway } from '../src/core/ai/gateway.ts';
import { writePageThrough } from '../src/core/write-through.ts';

let engine: PGLiteEngine;
let root: string;
let brainDir: string;

const putPage = operations.find((op) => op.name === 'put_page')!;
const patchPage = operations.find((op) => op.name === 'patch_page')!;
const getPage = operations.find((op) => op.name === 'get_page')!;
const deletePage = operations.find((op) => op.name === 'delete_page')!;

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

function remoteCtx(): OperationContext {
  return {
    ...ctx(),
    remote: true,
    transport: 'http',
    takesHoldersAllowList: ['world'],
  } as OperationContext;
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
  root = mkdtempSync(join(tmpdir(), 'patch-page-c1-'));
  brainDir = join(root, 'brain');
  require('node:fs').mkdirSync(brainDir, { recursive: true });
  await engine.setConfig('sync.repo_path', brainDir);
  await engine.setConfig('sync.write_through', 'true');
});

afterEach(() => {
  if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
});

async function seedPerson(): Promise<{ revision: string }> {
  await putPage.handler(ctx(), {
    slug: 'people/example-person',
    content: `---
type: person
title: Example Person
id: person-1
company: Example Co
role: Founder
city: Tokyo
---

Original body.
`,
  });
  const page = await getPage.handler(ctx(), {
    slug: 'people/example-person',
    include_content: true,
  }) as { canonical_revision: string };
  return { revision: page.canonical_revision };
}

describe('patch_page C1 operation', () => {
  test('get_page exposes exact revision and patch preserves omitted fields and body', async () => {
    const { revision } = await seedPerson();
    expect(revision).toMatch(/^sha256:[0-9a-f]{64}$/);

    const result = await patchPage.handler(ctx(), {
      slug: 'people/example-person',
      base_revision: revision,
      frontmatter_set: { role: 'Advisor' },
    }) as { status: string; projection_state: string; canonical_revision: string };
    expect(result.status).toBe('patched');
    expect(result.projection_state).toBe('current');
    expect(result.canonical_revision).not.toBe(revision);

    const canonical = readFileSync(join(brainDir, 'people/example-person.md'), 'utf8');
    expect(canonical).toContain('company: Example Co');
    expect(canonical).toContain('role: Advisor');
    expect(canonical).toContain('city: Tokyo');
    expect(canonical).toContain('Original body.');
    expect((await engine.getPage('people/example-person', { sourceId: 'default' }))?.frontmatter.company).toBe('Example Co');
    expect((await engine.getVersions('people/example-person', { sourceId: 'default' })).length).toBe(1);
  });

  test('dedicated type and title fields retype and retitle a page while frontmatter and body survive', async () => {
    const { revision } = await seedPerson();
    const result = await patchPage.handler(ctx(), {
      slug: 'people/example-person',
      base_revision: revision,
      type: 'company',
      title: 'Example Co (retitled)',
    }) as { status: string };
    expect(result.status).toBe('patched');

    const canonical = readFileSync(join(brainDir, 'people/example-person.md'), 'utf8');
    expect(canonical).toContain('type: company');
    expect(canonical).not.toContain('type: person');
    expect(canonical).toContain('title: Example Co (retitled)');
    expect(canonical).not.toContain('title: Example Person');
    expect(canonical.match(/^type: /gm)?.length).toBe(1);
    expect(canonical.match(/^title: /gm)?.length).toBe(1);
    expect(canonical).toContain('company: Example Co');
    expect(canonical).toContain('Original body.');
    const projected = await engine.getPage('people/example-person', { sourceId: 'default' });
    expect(projected?.type).toBe('company');
    expect(projected?.title).toBe('Example Co (retitled)');
  });

  test('title rejects blank and multi-line values before touching the page', async () => {
    const { revision } = await seedPerson();
    await expect(patchPage.handler(ctx(), { slug: 'people/example-person', base_revision: revision, title: '   ' })).rejects.toBeInstanceOf(OperationError);
    await expect(patchPage.handler(ctx(), { slug: 'people/example-person', base_revision: revision, title: 'two\nlines' })).rejects.toBeInstanceOf(OperationError);
    const canonical = readFileSync(join(brainDir, 'people/example-person.md'), 'utf8');
    expect(canonical).toContain('title: Example Person');
  });

  test('two sessions cannot erase each other: stale write conflicts, refreshed retry preserves both', async () => {
    const { revision: sharedBase } = await seedPerson();
    const first = await patchPage.handler(ctx(), {
      slug: 'people/example-person',
      base_revision: sharedBase,
      frontmatter_set: { role: 'Advisor' },
    }) as { canonical_revision: string };

    let conflict: OperationError | undefined;
    try {
      await patchPage.handler(ctx(), {
        slug: 'people/example-person',
        base_revision: sharedBase,
        frontmatter_set: { how_met: 'Introduced by a mutual friend' },
      });
    } catch (error) {
      conflict = error as OperationError;
    }
    expect(conflict?.code).toBe('revision_conflict');

    const retry = await patchPage.handler(ctx(), {
      slug: 'people/example-person',
      base_revision: first.canonical_revision,
      frontmatter_set: { how_met: 'Introduced by a mutual friend' },
    }) as { projection_state: string };
    expect(retry.projection_state).toBe('current');
    const canonical = readFileSync(join(brainDir, 'people/example-person.md'), 'utf8');
    expect(canonical).toContain('role: Advisor');
    expect(canonical).toContain('how_met: Introduced by a mutual friend');
    expect(canonical).toContain('company: Example Co');
  });

  test('rejects untyped structured params before canonical mutation', async () => {
    const { revision } = await seedPerson();
    const path = join(brainDir, 'people/example-person.md');
    const before = readFileSync(path, 'utf8');
    await expect(patchPage.handler(ctx(), {
      slug: 'people/example-person',
      base_revision: revision,
      frontmatter_set: '{"role":"Advisor"}',
    })).rejects.toMatchObject({ code: 'invalid_params' });
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  test('completed request replay is idempotent and does not create another version', async () => {
    const { revision } = await seedPerson();
    const params = {
      slug: 'people/example-person',
      base_revision: revision,
      frontmatter_set: { role: 'Advisor' },
    };
    await patchPage.handler(ctx(), params);
    const replay = await patchPage.handler(ctx(), params) as { resumed: boolean; projection_state: string };
    expect(replay.resumed).toBe(true);
    expect(replay.projection_state).toBe('current');
    expect((await engine.getVersions('people/example-person', { sourceId: 'default' })).length).toBe(1);
  });

  test('sparse patch and generic DB-to-file rewrite share one page lock', async () => {
    const { revision } = await seedPerson();
    let projectionEntered!: () => void;
    let releaseProjection!: () => void;
    const entered = new Promise<void>((resolve) => { projectionEntered = resolve; });
    const gate = new Promise<void>((resolve) => { releaseProjection = resolve; });
    const delayed = Object.create(engine) as PGLiteEngine;
    delayed.transaction = async (fn) => {
      projectionEntered();
      await gate;
      return engine.transaction(fn);
    };
    const delayedCtx = { ...ctx(), engine: delayed };

    const patch = patchPage.handler(delayedCtx, {
      slug: 'people/example-person',
      base_revision: revision,
      frontmatter_set: { role: 'Advisor' },
    });
    await entered;
    const file = join(brainDir, 'people/example-person.md');
    expect(readFileSync(file, 'utf8')).toContain('role: Advisor');

    let rewriteSettled = false;
    const rewrite = writePageThrough(engine, 'people/example-person', { sourceId: 'default' })
      .finally(() => { rewriteSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(rewriteSettled).toBe(false);
    expect(readFileSync(file, 'utf8')).toContain('role: Advisor');

    releaseProjection();
    await patch;
    await rewrite;
    expect(readFileSync(file, 'utf8')).toContain('role: Advisor');
  });

  test('delete waits for an in-flight sparse patch and removes the completed revision', async () => {
    const { revision } = await seedPerson();
    let projectionEntered!: () => void;
    let releaseProjection!: () => void;
    const entered = new Promise<void>((resolve) => { projectionEntered = resolve; });
    const gate = new Promise<void>((resolve) => { releaseProjection = resolve; });
    const delayed = Object.create(engine) as PGLiteEngine;
    delayed.transaction = async (fn) => {
      projectionEntered();
      await gate;
      return engine.transaction(fn);
    };
    const patch = patchPage.handler({ ...ctx(), engine: delayed }, {
      slug: 'people/example-person',
      base_revision: revision,
      frontmatter_set: { role: 'Advisor' },
    });
    await entered;

    let deleteSettled = false;
    const deletion = deletePage.handler(ctx(), { slug: 'people/example-person' })
      .finally(() => { deleteSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(deleteSettled).toBe(false);
    releaseProjection();
    await patch;
    await deletion;

    expect(existsSync(join(brainDir, 'people/example-person.md'))).toBe(false);
    expect((await engine.getPage('people/example-person', { sourceId: 'default', includeDeleted: true }))?.deleted_at).not.toBeNull();
  });

  test('explicit unset removes exactly one mutable field', async () => {
    const { revision } = await seedPerson();
    await patchPage.handler(ctx(), {
      slug: 'people/example-person',
      base_revision: revision,
      frontmatter_unset: ['city'],
    });
    const canonical = readFileSync(join(brainDir, 'people/example-person.md'), 'utf8');
    expect(canonical).not.toContain('city: Tokyo');
    expect(canonical).toContain('company: Example Co');
    expect(canonical).toContain('role: Founder');
  });

  test('explicit write-through opt-out fails closed without canonical or DB mutation', async () => {
    const { revision } = await seedPerson();
    const file = join(brainDir, 'people/example-person.md');
    const before = readFileSync(file, 'utf8');
    await engine.setConfig('sync.write_through', 'false');
    let error: OperationError | undefined;
    try {
      await patchPage.handler(ctx(), {
        slug: 'people/example-person',
        base_revision: revision,
        frontmatter_set: { role: 'Advisor' },
      });
    } catch (caught) {
      error = caught as OperationError;
    }
    expect(error?.code).toBe('unavailable');
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect((await engine.getPage('people/example-person', { sourceId: 'default' }))?.frontmatter.role).toBe('Founder');
  });

  test('canonical revision is source-bound at the patch operation boundary', async () => {
    const { revision } = await seedPerson();
    let error: OperationError | undefined;
    try {
      await patchPage.handler(remoteCtx(), {
        slug: 'people/example-person',
        source_id: 'federated-read-source',
        base_revision: revision,
        frontmatter_set: { role: 'Advisor' },
      });
    } catch (caught) {
      error = caught as OperationError;
    }
    expect(error?.code).toBe('permission_denied');
    expect((await engine.getPage('people/example-person', { sourceId: 'default' }))?.frontmatter.role).toBe('Founder');
  });

  test('remote sparse patch preserves private canonical facts it cannot read', async () => {
    const privateClaim = 'PRIVATE_C1_FACT_must_survive_sparse_patch';
    await putPage.handler(ctx(), {
      slug: 'people/private-fact-owner',
      content: `---
type: person
title: Private Fact Owner
privacy: world
quarantine: review
---

Visible body.

<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
| 1 | ${privateClaim} | fact | 1.0 | private | high | 2026-01-01 |  | test |  |
<!--- gbrain:facts:end -->
`,
    });
    const visible = await getPage.handler(remoteCtx(), {
      slug: 'people/private-fact-owner',
      include_content: true,
    }) as { content: string; canonical_revision: string };
    expect(visible.content).not.toContain(privateClaim);
    expect(visible.canonical_revision).toMatch(/^sha256:[0-9a-f]{64}$/);

    await patchPage.handler(remoteCtx(), {
      slug: 'people/private-fact-owner',
      base_revision: visible.canonical_revision,
      frontmatter_set: { role: 'Advisor' },
    });
    const canonical = readFileSync(join(brainDir, 'people/private-fact-owner.md'), 'utf8');
    expect(canonical).toContain(privateClaim);
    expect(canonical).toContain('role: Advisor');
    expect(canonical).toContain('quarantine: review');
    expect((await engine.getPage('people/private-fact-owner', { sourceId: 'default' }))?.frontmatter.quarantine).toBe('review');

    let markerError: OperationError | undefined;
    const refreshed = await getPage.handler(remoteCtx(), {
      slug: 'people/private-fact-owner',
    }) as { canonical_revision: string };
    try {
      await patchPage.handler(remoteCtx(), {
        slug: 'people/private-fact-owner',
        base_revision: refreshed.canonical_revision,
        frontmatter_unset: ['quarantine'],
      });
    } catch (error) {
      markerError = error as OperationError;
    }
    expect(markerError?.code).toBe('invalid_params');
  });
});
