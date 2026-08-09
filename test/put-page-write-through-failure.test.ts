/**
 * put_page must not report success when the disk write-through fails.
 *
 * The DB row is a derived cache; the markdown file under a source's working
 * tree is the system of record (docs/architecture/system-of-record.md). If
 * `writePageThrough` can't produce that file — the write throws, or a guard
 * refuses it for a reason that isn't the deliberate "no repo configured at
 * all" case — `put_page` must reject the call instead of returning
 * `created_or_updated`, and a brand-new page's DB row must not survive as an
 * index-only orphan.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operations, OperationError } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { resetGateway } from '../src/core/ai/gateway.ts';

let engine: PGLiteEngine;
let tmpRoot: string;

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
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-put-page-wt-'));
});

function makeCtx(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine,
    config: { engine: 'pglite' as const },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: false,
    sourceId: 'default',
    ...overrides,
  };
}

const putPage = operations.find((o) => o.name === 'put_page')!;
const PAGE_CONTENT = '---\ntitle: T\ntype: note\n---\n\n# Body\n\nSome content.';

async function expectRejected(ctx: OperationContext, params: Record<string, unknown>): Promise<OperationError> {
  try {
    await putPage.handler(ctx, params);
  } catch (e) {
    expect(e).toBeInstanceOf(OperationError);
    return e as OperationError;
  }
  throw new Error('expected put_page to reject when write-through failed, but it reported success');
}

describe('put_page — write-through failure must not report success', () => {
  test('write-through throws (blocked parent dir) → put_page rejects and rolls back the new page', async () => {
    const sourceDir = path.join(tmpRoot, 'wt-fail-source');
    fs.mkdirSync(sourceDir, { recursive: true });
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config) VALUES ('wt-fail', 'WT Fail', $1, '{}'::jsonb)`,
      [sourceDir],
    );
    // `notes` is a FILE, not a directory, so mkdir -p `notes/x` throws ENOTDIR
    // inside writePageThrough — the write-through-write-fails repro.
    fs.writeFileSync(path.join(sourceDir, 'notes'), 'blocker');

    const slug = 'notes/x';
    const err = await expectRejected(makeCtx({ sourceId: 'wt-fail' }), { slug, content: PAGE_CONTENT });
    expect(err.code).toBe('storage_error');

    // No orphan: the brand-new page must not survive with no markdown file.
    expect(await engine.getPage(slug, { sourceId: 'wt-fail' })).toBeNull();
    expect(fs.existsSync(path.join(sourceDir, 'notes.md'))).toBe(false);
  });

  test('write-through skip that is a refusal, not deliberate config (repo_not_found) → put_page rejects', async () => {
    const fileAsRepo = path.join(tmpRoot, 'not-a-dir');
    fs.writeFileSync(fileAsRepo, 'x');
    await engine.setConfig('sync.repo_path', fileAsRepo);

    const slug = 'inbox/repo-missing';
    const err = await expectRejected(makeCtx(), { slug, content: PAGE_CONTENT });
    expect(err.code).toBe('storage_error');
    expect(await engine.getPage(slug, { sourceId: 'default' })).toBeNull();
  });

  test('no sync.repo_path configured at all (DB-only by design) still succeeds', async () => {
    await engine.setConfig('sync.repo_path', '');
    const slug = 'inbox/db-only';
    const result = (await putPage.handler(makeCtx(), { slug, content: PAGE_CONTENT })) as {
      status: string;
      write_through?: { skipped?: string };
    };
    expect(result.status).toBe('created_or_updated');
    expect(result.write_through?.skipped).toBe('no_repo_configured');
    expect(await engine.getPage(slug, { sourceId: 'default' })).not.toBeNull();
  });
});
