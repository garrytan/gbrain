/**
 * #3883: generatePerChunkSynopsis must classify stopReason==='length' as
 * 'malformed' (page-level fall-back + audit) instead of embedding truncated
 * text, and the output-token cap must be overridable per call (threaded from
 * models.synopsis_max_tokens by the service layer).
 *
 * Serial: installs the process-global chat transport stub and redirects the
 * audit dir.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  generatePerChunkSynopsis,
  SYNOPSIS_MAX_TOKENS,
} from '../src/core/page-summary.ts';
import { __setChatTransportForTests, type ChatOpts } from '../src/core/ai/gateway.ts';
import { readRecentSynopsisFailures } from '../src/core/audit-synopsis.ts';

let tmpDir: string;
const originalAuditDir = process.env.GBRAIN_AUDIT_DIR;

function stubChat(overrides: { text?: string; stopReason?: 'end' | 'length' | 'refusal' }, capture?: ChatOpts[]) {
  __setChatTransportForTests(async (opts: ChatOpts) => {
    capture?.push(opts);
    return {
      text: overrides.text ?? 'A one-sentence synopsis about the chunk.',
      blocks: [],
      stopReason: overrides.stopReason ?? 'end',
      usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'anthropic:stub',
      providerId: 'anthropic',
    };
  });
}

const baseArgs = {
  documentText: 'Full document text about acme-example fundraising.',
  chunkText: 'The chunk text about the series A.',
  pageTitle: 'Acme Example',
  pageSlug: 'companies/acme-example',
  sourceId: 'default',
  chunkIndex: 0,
};

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-synopsis-length-test-'));
  process.env.GBRAIN_AUDIT_DIR = tmpDir;
});

afterAll(() => {
  __setChatTransportForTests(null);
  if (originalAuditDir === undefined) delete process.env.GBRAIN_AUDIT_DIR;
  else process.env.GBRAIN_AUDIT_DIR = originalAuditDir;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const f of fs.readdirSync(tmpDir)) fs.unlinkSync(path.join(tmpDir, f));
});

describe('stopReason length → malformed (#3883)', () => {
  test('a truncated (length-stopped) response never becomes a synopsis', async () => {
    stubChat({ text: 'This synopsis got cut off mid-sen', stopReason: 'length' });
    const result = await generatePerChunkSynopsis(baseArgs);
    expect(result.kind).toBe('malformed');
    expect((result as { detail?: string }).detail).toContain('stop_reason=length');
    expect((result as { detail?: string }).detail).toContain('models.synopsis_max_tokens');
    // Never leaks the truncated text as a success payload.
    expect('synopsis' in result).toBe(false);
  });

  test('the length failure lands in the synopsis audit trail with page-level fallback', async () => {
    stubChat({ text: 'Truncated fragm', stopReason: 'length' });
    await generatePerChunkSynopsis(baseArgs);
    const events = readRecentSynopsisFailures(10);
    expect(events.length).toBe(1);
    expect(events[0].kind).toBe('malformed');
    expect(events[0].page_level_fallback).toBe(true);
    expect(events[0].page_slug).toBe('companies/acme-example');
  });

  test('a clean end-stop still succeeds', async () => {
    stubChat({ stopReason: 'end' });
    const result = await generatePerChunkSynopsis(baseArgs);
    expect(result.kind).toBe('success');
  });
});

describe('maxTokens threading (#3883)', () => {
  test('default cap is SYNOPSIS_MAX_TOKENS when the arg is omitted', async () => {
    const captured: ChatOpts[] = [];
    stubChat({ stopReason: 'end' }, captured);
    await generatePerChunkSynopsis(baseArgs);
    expect(captured[0].maxTokens).toBe(SYNOPSIS_MAX_TOKENS);
  });

  test('explicit maxTokens arg reaches the chat call and the length detail', async () => {
    const captured: ChatOpts[] = [];
    stubChat({ stopReason: 'length' }, captured);
    const result = await generatePerChunkSynopsis({ ...baseArgs, maxTokens: 512 });
    expect(captured[0].maxTokens).toBe(512);
    expect((result as { detail?: string }).detail).toContain('maxTokens=512');
  });
});

describe('resolveSynopsisMaxTokens config resolver (#3883)', () => {
  test('reads models.synopsis_max_tokens, clamps junk to undefined', async () => {
    const { resolveSynopsisMaxTokens } = await import('../src/core/contextual-retrieval-service.ts');
    const mkEngine = (val: string | null) =>
      ({ getConfig: async () => val }) as unknown as import('../src/core/engine.ts').BrainEngine;
    expect(await resolveSynopsisMaxTokens(mkEngine('400'))).toBe(400);
    expect(await resolveSynopsisMaxTokens(mkEngine(null))).toBeUndefined();
    expect(await resolveSynopsisMaxTokens(mkEngine(''))).toBeUndefined();
    expect(await resolveSynopsisMaxTokens(mkEngine('not-a-number'))).toBeUndefined();
    expect(await resolveSynopsisMaxTokens(mkEngine('4'))).toBeUndefined();     // below floor
    expect(await resolveSynopsisMaxTokens(mkEngine('99999'))).toBeUndefined(); // above ceiling
    const throwing = ({ getConfig: async () => { throw new Error('db down'); } }) as unknown as import('../src/core/engine.ts').BrainEngine;
    expect(await resolveSynopsisMaxTokens(throwing)).toBeUndefined();          // fail-open
  });
});
