/**
 * Unit tests: buildOperationContext honours GBRAIN_SOURCE env var (stdio MCP support).
 *
 * These tests do NOT require a live DB. We pass a stub engine and just assert
 * that the returned OperationContext has (or doesn't have) defaultSourceId.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { buildOperationContext } from '../src/mcp/dispatch.ts';
import type { BrainEngine } from '../src/core/engine.ts';

// Minimal stub engine — none of its methods are called by buildOperationContext.
const stubEngine = {} as unknown as BrainEngine;

describe('buildOperationContext — GBRAIN_SOURCE env', () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.GBRAIN_SOURCE;
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.GBRAIN_SOURCE;
    } else {
      process.env.GBRAIN_SOURCE = savedEnv;
    }
  });

  test('sets defaultSourceId when GBRAIN_SOURCE is valid', () => {
    process.env.GBRAIN_SOURCE = 'reisponde';
    const ctx = buildOperationContext(stubEngine, {});
    expect(ctx.defaultSourceId).toBe('reisponde');
  });

  test('does NOT set defaultSourceId when GBRAIN_SOURCE is absent', () => {
    delete process.env.GBRAIN_SOURCE;
    const ctx = buildOperationContext(stubEngine, {});
    expect(ctx.defaultSourceId).toBeUndefined();
  });

  test('does NOT set defaultSourceId when GBRAIN_SOURCE is empty string', () => {
    process.env.GBRAIN_SOURCE = '';
    const ctx = buildOperationContext(stubEngine, {});
    expect(ctx.defaultSourceId).toBeUndefined();
  });

  test('ignores GBRAIN_SOURCE with invalid format (uppercase)', () => {
    process.env.GBRAIN_SOURCE = 'INVALID_SOURCE';
    const ctx = buildOperationContext(stubEngine, {});
    expect(ctx.defaultSourceId).toBeUndefined();
  });

  test('ignores GBRAIN_SOURCE with leading dash', () => {
    process.env.GBRAIN_SOURCE = '-bad-id';
    const ctx = buildOperationContext(stubEngine, {});
    expect(ctx.defaultSourceId).toBeUndefined();
  });

  test('accepts single-char valid source id', () => {
    process.env.GBRAIN_SOURCE = 'r';
    const ctx = buildOperationContext(stubEngine, {});
    expect(ctx.defaultSourceId).toBe('r');
  });

  test('backward compat: remote defaults to true without GBRAIN_SOURCE', () => {
    delete process.env.GBRAIN_SOURCE;
    const ctx = buildOperationContext(stubEngine, {});
    expect(ctx.remote).toBe(true);
    expect(ctx.defaultSourceId).toBeUndefined();
  });
});
