/**
 * Agent operator contract v1 version skew (A1 thin client):
 * - old client (frozen copy of v0.60.37.0's parser) × new server: the v1
 *   goldens parse; the legacy `error`, `suggestion` and receipts survive;
 *   success bodies stay content[0]-only even with notice blocks.
 * - new client × old server: an envelope without `code` gets the canonical
 *   code derived; nothing is invented.
 * - new client × new server: code/reason/why/fix/notices/contract_version
 *   and receipts are preserved on RemoteMcpError and its toJSON().
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { oldReadError, oldUnpack } from './fixtures/agent-contract/frozen-thin-client-v0.60.37.ts';
import { extractNotices, extractToolErrorDetail, RemoteMcpError, unpackToolResult } from '../src/core/mcp-client.ts';

const golden = (name: string) => JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'agent-contract', 'v1', name), 'utf8'));

describe('old client × new server (frozen v0.60.37.0 parser)', () => {
  test('error results are one block, so the old join-all parse still reads them', () => {
    for (const name of ['error-with-fix.json', 'error-with-notices.json', 'legacy-error-value.json']) {
      const res = golden(name);
      expect(res.content).toHaveLength(1);
      const d = oldReadError(res);
      expect(typeof d.code).toBe('string');
      expect(typeof d.suggestion).toBe('string');
    }
    expect(oldReadError(golden('legacy-error-value.json')).code).toBe('unknown_operation');
  });

  test('receipt-bearing errors keep write_request + write_error for the old client', () => {
    const d = oldReadError(golden('receipt-error.json'));
    expect(d).toMatchObject({ code: 'write_pending', write_error: 'write_pending' });
    expect((d.write_request as { request_id: string }).request_id).toBe('11111111-2222-4333-8444-555555555555');
  });

  test('success bodies with notice blocks: the old client reads content[0] only', () => {
    expect(oldUnpack(golden('bare-array-result.json'))).toEqual([]);
    expect(oldUnpack(golden('object-result.json'))).toEqual({ slug: 'notes/alpha-example', title: 'Alpha example' });
  });
});

describe('new client', () => {
  test('× new server: every v1 field is preserved', () => {
    const text = golden('error-with-notices.json').content[0].text;
    const d = extractToolErrorDetail(text);
    expect(d).toMatchObject({ code: 'unavailable', reason: 'embeddings_disabled', contract_version: 1 });
    expect(d.notices?.[0]).toMatchObject({ code: 'backup_coverage', kind: 'safety' });
    const json = new RemoteMcpError('tool_error', 'x', d).toJSON() as Record<string, unknown>;
    expect(json).toMatchObject({ error: 'unavailable', code: 'unavailable', reason: 'embeddings_disabled', contract_version: 1 });
    expect(json.notices).toHaveLength(1);
    expect(json.fix).toMatchObject({ command: 'gbrain doctor --json --brain host' });
  });

  test('× new server: frozen error value and canonical code both survive', () => {
    const d = extractToolErrorDetail(golden('legacy-error-value.json').content[0].text);
    expect(d).toMatchObject({ code: 'unknown_operation', canonical_code: 'unknown_tool' });
    expect(new RemoteMcpError('tool_error', 'x', d).toJSON()).toMatchObject({ error: 'unknown_operation', code: 'unknown_tool' });
  });

  test('× new server: receipts survive', () => {
    const d = extractToolErrorDetail(golden('receipt-error.json').content[0].text);
    expect(d.write_request?.request_id).toBe('11111111-2222-4333-8444-555555555555');
    expect(d.write_error).toBe('write_pending');
  });

  test('× old server: code derived from the legacy value; no v1 fields invented', () => {
    const d = extractToolErrorDetail(JSON.stringify({ error: 'unknown_operation', message: 'Unknown: x' }));
    const json = new RemoteMcpError('tool_error', 'x', d).toJSON() as Record<string, unknown>;
    expect(json).toMatchObject({ error: 'unknown_operation', code: 'unknown_tool' });
    expect(json).not.toHaveProperty('contract_version');
    expect(json).not.toHaveProperty('fix');
  });

  test('success: body from content[0]; notices from _meta, else from prefixed blocks', () => {
    const res = golden('bare-array-result.json');
    expect(unpackToolResult<unknown[]>(res)).toEqual([]);
    expect(extractNotices(res)[0]).toMatchObject({ code: 'empty_retrieval', kind: 'info' });
    const noMeta = { content: res.content };
    expect(extractNotices(noMeta)[0]).toMatchObject({ code: 'empty_retrieval', kind: 'info', fix: 'gbrain doctor --json --brain host' });
    expect(extractNotices(golden('object-result.json')).length).toBe(0);
  });
});
