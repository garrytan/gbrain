/**
 * A6 op-level companion (test-gap wave 5, eng E24): file_upload's trust
 * default is FAIL-CLOSED at the HANDLER layer.
 *
 * `OperationContext.remote` is required on the type, but the handler's strict
 * split is `ctx.remote !== false` (src/core/ops/files.ts) — anything that is
 * not literally `false`, including an `undefined` smuggled past the required
 * type by a buggy transport cast, takes the STRICT confinement path
 * (validateUploadPath(path, process.cwd(), strict=true)). Only an explicit
 * `remote: false` (local CLI, the machine owner) gets loose mode, which
 * genuinely allows uploading a regular file from anywhere on the filesystem.
 *
 * Probe design: a REAL regular file in a REAL temp dir outside process.cwd()
 * — exactly what loose mode allows and strict mode must reject. A symlink is
 * NOT a valid loose-vs-strict probe: validateUploadPath rejects
 * final-component symlinks in BOTH modes (pinned below), so loose mode's
 * permissiveness is confinement-only.
 *
 * Existing coverage this complements (why this file exists):
 *   - test/file-upload-security.test.ts pins validateUploadPath directly
 *     (validator level, strict arg passed explicitly).
 *   - test/file-upload-engine-context.test.ts pins MCP-dispatch engine
 *     ownership with remote: true.
 *   Neither exercises the handler's own `ctx.remote !== false` default.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, OperationError, type OperationContext } from '../src/core/operations.ts';

const file_upload = operations.find((o) => o.name === 'file_upload')!;

let engine: PGLiteEngine;
let outsideDir: string;
let probePath: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' } as never);
  await engine.initSchema();

  outsideDir = mkdtempSync(join(tmpdir(), 'gbrain-remote-default-'));
  probePath = join(outsideDir, 'outside-probe.txt');
  // Unique content per run so the content-hash dedupe branch
  // ('already_exists') can never mask the loose-mode 'uploaded' control.
  writeFileSync(probePath, `outside the working tree ${Date.now()}-${Math.random()}\n`);
});

afterAll(async () => {
  if (engine) await engine.disconnect();
  if (outsideDir) rmSync(outsideDir, { recursive: true, force: true });
});

// `remote` is REQUIRED on OperationContext; `undefined` here deliberately
// models a transport that bypassed the type via cast — exactly the hole the
// handler's `!== false` default closes (same cast idiom as sibling op tests).
function ctxWithRemote(remote: boolean | undefined): OperationContext {
  return {
    engine,
    // file_upload refuses outright without a storage backend (a files row
    // with no stored bytes) — the local backend keeps the accept-path
    // control real while the strict rejections throw before storage.
    config: { storage: { backend: 'local', bucket: 'test-bucket', localPath: join(outsideDir, 'storage') } },
    logger: console,
    dryRun: false,
    remote,
    sourceId: 'default',
  } as unknown as OperationContext;
}

async function expectInvalidParams(promise: Promise<unknown>, msgRe: RegExp): Promise<void> {
  let err: unknown;
  try {
    await promise;
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(OperationError);
  expect((err as OperationError).code).toBe('invalid_params');
  expect((err as Error).message).toMatch(msgRe);
}

describe('file_upload remote-trust default (ctx.remote !== false is strict)', () => {
  test('remote: undefined defaults to the STRICT confinement path — outside-cwd probe rejected', async () => {
    // Precondition: the probe genuinely lives outside the strict confinement
    // root (process.cwd()), so a rejection can only come from confinement.
    const realProbe = realpathSync(probePath);
    const realCwd = realpathSync(process.cwd());
    expect(realProbe.startsWith(realCwd + sep)).toBe(false);

    await expectInvalidParams(
      file_upload.handler(ctxWithRemote(undefined), { path: probePath }),
      /within the working directory/i,
    );
  });

  test('remote: true takes the same strict path (undefined ≡ untrusted, not a third mode)', async () => {
    await expectInvalidParams(
      file_upload.handler(ctxWithRemote(true), { path: probePath }),
      /within the working directory/i,
    );
  });

  test('control: remote: false (trusted local CLI) — loose mode genuinely accepts the same probe', async () => {
    const result = (await file_upload.handler(ctxWithRemote(false), { path: probePath })) as Record<string, unknown>;
    expect(result.status).toBe('uploaded');
    expect(result.storage_path).toMatch(/^unsorted\/[0-9a-f]{8}-outside-probe\.txt$/);
    expect(result.size_bytes).toBeGreaterThan(0);
  });

  test('final-component symlink is rejected in BOTH modes — loose mode relaxes confinement only', async () => {
    const link = join(outsideDir, 'link-to-probe.txt');
    symlinkSync(probePath, link);
    try {
      await expectInvalidParams(
        file_upload.handler(ctxWithRemote(undefined), { path: link }),
        /symlinks are not allowed/i,
      );
      await expectInvalidParams(
        file_upload.handler(ctxWithRemote(false), { path: link }),
        /symlinks are not allowed/i,
      );
    } finally {
      rmSync(link, { force: true });
    }
  });
});
