import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { encodeDeepResearchId, decodeDeepResearchId } from '../src/core/deep-research-id.ts';
import { stampDeepResearchIds } from '../src/core/ops/context.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { deepResearchContract } from './helpers/deep-research-contract.ts';

describe('deep research result id codec', () => {
  test('uses canonical versioned base64url JSON, not delimiter splitting', () => {
    const id = encodeDeepResearchId('beta', 'notes/a:b?c#d');
    expect(id).toBe('gbrain-page:v1:' + Buffer.from('["beta","notes/a:b?c#d"]').toString('base64url'));
    expect(decodeDeepResearchId(id)).toEqual({ sourceId: 'beta', slug: 'notes/a:b?c#d' });
    expect(decodeDeepResearchId('notes/legacy')).toBeNull();
  });

  test('rejects malformed versions, payloads, UTF-8, escaping and noncanonical encodings', () => {
    const wrap = (text: string) => 'gbrain-page:v1:' + Buffer.from(text).toString('base64url');
    for (const id of [
      'gbrain-page:v2:abc', 'gbrain-page:v1:', 'gbrain-page:v1:abc=', 'gbrain-page:v1:!!',
      ` ${encodeDeepResearchId('beta', 'notes/x')}`, `${encodeDeepResearchId('beta', 'notes/x')} `,
      'gbrain-page:v1:_w', wrap('null'), wrap('{}'), wrap('["beta"]'), wrap('["beta",1]'),
      wrap('["beta","notes/x","extra"]'), wrap('["__all__","notes/x"]'), wrap('["beta","../x"]'),
      wrap('["beta","notes/%2fx"]'), wrap('["beta","notes/\\u0000"]'), wrap('["beta","notes/X"]'),
      wrap('["beta", "notes/x"]'), wrap('["beta","notes/\\u0078"]'),
    ]) expect(() => decodeDeepResearchId(id)).toThrow();
  });

  test('missing hit source never guesses the ambient or default source', () => {
    expect(() => stampDeepResearchIds([{ slug: 'notes/x' } as any])).toThrow('Invalid search result identity');
  });
});

describe('PGLite deep research matrix', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 60_000);
  beforeEach(async () => { await resetPgliteState(engine); });
  afterAll(async () => { if (engine) await engine.disconnect(); });
  deepResearchContract(() => engine);
});
