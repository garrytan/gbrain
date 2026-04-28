/**
 * add_link + manual link_type taxonomy: validator + operation handler.
 * Option A: missing/empty link_type is rejected (same path as unknown strings).
 */
import { describe, test, expect } from 'bun:test';
import { operations, OperationError } from '../src/core/operations.ts';
import type { OperationContext, Operation } from '../src/core/operations.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import {
  RELATIONSHIP,
  parseManualLinkTypeOrThrow,
  normalizeManualLinkTypeInput,
  isRecognizedManualLinkType,
  type InferredLinkType,
} from '../src/core/entity-taxonomy.ts';

const add_link = operations.find(o => o.name === 'add_link') as Operation;
if (!add_link) throw new Error('add_link op missing');

function makeCtx(overrides: Partial<OperationContext> = {}): OperationContext {
  const addLink = async () => {};
  const engine = { addLink } as unknown as BrainEngine;
  return {
    engine,
    config: { engine: 'postgres' } as any,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: false,
    ...overrides,
  };
}

describe('parseManualLinkTypeOrThrow + helpers (Option A)', () => {
  const allTypes = Object.values(RELATIONSHIP) as InferredLinkType[];

  test('each RELATIONSHIP value is accepted (representative matrix)', () => {
    for (const t of allTypes) {
      expect(parseManualLinkTypeOrThrow(t)).toBe(t);
      expect(isRecognizedManualLinkType(t)).toBe(true);
    }
  });

  test('trim: leading/trailing spaces around a valid label pass', () => {
    expect(parseManualLinkTypeOrThrow('  mentions  ')).toBe('mentions');
  });

  test('invalid or unknown strings throw', () => {
    expect(() => parseManualLinkTypeOrThrow('foo')).toThrow(/invalid link_type/);
    expect(() => parseManualLinkTypeOrThrow('Works_At')).toThrow(/invalid link_type/);
    expect(() => parseManualLinkTypeOrThrow('Mentions')).toThrow(/invalid link_type/);
  });

  test('missing, empty, and whitespace-only fail (Option A)', () => {
    expect(() => parseManualLinkTypeOrThrow(undefined)).toThrow(/link_type is required/);
    expect(() => parseManualLinkTypeOrThrow(null)).toThrow(/link_type is required/);
    expect(() => parseManualLinkTypeOrThrow('')).toThrow(/link_type is required/);
    expect(() => parseManualLinkTypeOrThrow('   ')).toThrow(/link_type is required/);
  });

  test('non-string raw input throws', () => {
    expect(() => parseManualLinkTypeOrThrow(1)).toThrow(/link_type must be a string/);
  });

  test('normalizeManualLinkTypeInput: undefined/null/whitespace', () => {
    expect(normalizeManualLinkTypeInput(undefined)).toBe('');
    expect(normalizeManualLinkTypeInput(null)).toBe('');
    expect(normalizeManualLinkTypeInput('  \t ')).toBe('');
  });
});

describe('add_link operation — validation before engine', () => {
  test('rejects bad link_type with OperationError invalid_params', async () => {
    try {
      await add_link.handler(makeCtx(), { from: 'a', to: 'b', link_type: 'nope' });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(OperationError);
      expect((e as OperationError).code).toBe('invalid_params');
    }
  });

  test('rejects missing link_type (Option A)', async () => {
    const ctx = makeCtx();
    const p = add_link.handler(ctx, { from: 'a', to: 'b' } as any);
    await expect(p).rejects.toMatchObject({ code: 'invalid_params' });
  });

  test('dry_run returns shape only after validation; invalid type still throws', async () => {
    const bad = add_link.handler(makeCtx({ dryRun: true }), { from: 'a', to: 'b', link_type: 'x' });
    await expect(bad).rejects.toBeInstanceOf(OperationError);

    const good = await add_link.handler(
      makeCtx({ dryRun: true }),
      { from: 'people/a', to: 'companies/b', link_type: 'mentions' },
    );
    expect(good).toEqual({
      dry_run: true,
      action: 'add_link',
      from: 'people/a',
      to: 'companies/b',
      link_type: 'mentions',
    });
  });

  test('calls engine.addLink with validated type', async () => {
    const calls: Parameters<BrainEngine['addLink']>[] = [];
    const engine = {
      async addLink(from: string, to: string, context: string, linkType: string) {
        calls.push([from, to, context, linkType]);
      },
    } as unknown as BrainEngine;
    await add_link.handler({ ...makeCtx(), engine }, {
      from: 'people/a',
      to: 'companies/b',
      link_type: 'founded',
      context: 'c',
    });
    expect(calls).toEqual([['people/a', 'companies/b', 'c', 'founded']]);
  });
});
