/**
 * Tests for the `put_page` --file flag (v0.18.3+).
 *
 * Covers:
 *  - --file reads the file into content (dry-run short-circuits before the engine call)
 *  - --file + --content → invalid_params (mutex)
 *  - --file over size cap → invalid_params
 *  - --file with remote=true (MCP) → permission_denied (no host filesystem access from agents)
 *  - Empty content (no --file, no --content, no stdin) → invalid_params with guidance
 */

import { afterAll, beforeAll, describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { operations, OperationError } from '../src/core/operations.ts';
import type { Operation, OperationContext } from '../src/core/operations.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const put_page = operations.find(o => o.name === 'put_page') as Operation;
if (!put_page) throw new Error('put_page op missing');

function makeCtx(overrides: Partial<OperationContext> = {}): OperationContext {
  const engine = {} as BrainEngine;
  return {
    engine,
    config: { engine: 'postgres' } as any,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: true, // short-circuits before engine call so we never need a real DB
    remote: false,
    ...overrides,
  };
}

const SAMPLE = `---
title: Sample
type: concept
---

# Sample

Body text.
`;

let tmpDir: string;
let samplePath: string;
let bigPath: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'gbrain-put-file-'));
  samplePath = join(tmpDir, 'sample.md');
  writeFileSync(samplePath, SAMPLE, 'utf-8');
  bigPath = join(tmpDir, 'too-big.md');
  // 5MB cap; write 5,000,001 bytes to trip the size check.
  writeFileSync(bigPath, 'x'.repeat(5_000_001), 'utf-8');
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('put_page --file', () => {
  test('reads file and passes through the content pipeline (dry-run)', async () => {
    const ctx = makeCtx();
    const result = await put_page.handler(ctx, { slug: 'concepts/sample', file: samplePath });
    expect(result).toMatchObject({ dry_run: true, action: 'put_page', slug: 'concepts/sample' });
  });

  test('rejects --file + --content with invalid_params', async () => {
    const ctx = makeCtx();
    await expect(
      put_page.handler(ctx, { slug: 'concepts/sample', file: samplePath, content: 'inline' }),
    ).rejects.toBeInstanceOf(OperationError);
    try {
      await put_page.handler(ctx, { slug: 'concepts/sample', file: samplePath, content: 'inline' });
    } catch (e) {
      expect((e as OperationError).code).toBe('invalid_params');
      expect((e as OperationError).message).toContain('Cannot use both');
    }
  });

  test('rejects oversized file with invalid_params', async () => {
    const ctx = makeCtx();
    try {
      await put_page.handler(ctx, { slug: 'concepts/big', file: bigPath });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(OperationError);
      expect((e as OperationError).code).toBe('invalid_params');
      expect((e as OperationError).message).toMatch(/exceeds/);
    }
  });

  test('rejects --file from remote callers with permission_denied', async () => {
    const ctx = makeCtx({ remote: true });
    try {
      await put_page.handler(ctx, { slug: 'concepts/sample', file: samplePath });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(OperationError);
      expect((e as OperationError).code).toBe('permission_denied');
      expect((e as OperationError).message).toMatch(/remote|MCP/);
    }
  });

  test('rejects missing content (no --file, no --content)', async () => {
    const ctx = makeCtx();
    try {
      await put_page.handler(ctx, { slug: 'concepts/blank' });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(OperationError);
      expect((e as OperationError).code).toBe('invalid_params');
      expect((e as OperationError).message).toMatch(/--content|--file|stdin/);
    }
  });

  test('rejects empty string content (same as missing)', async () => {
    const ctx = makeCtx();
    try {
      await put_page.handler(ctx, { slug: 'concepts/empty', content: '' });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(OperationError);
      expect((e as OperationError).code).toBe('invalid_params');
    }
  });
});
