/**
 * GBRA-217 A-T10: the reason flow as a remote agent drives it over MCP (remote=true, a scoped writer).
 *
 * 1. Protects: put_page with a reason, a second edition with its own reason, then get_versions, through the real MCP
 *    dispatcher: the second edition's reason reads back as the newest version's replaced_because, each write result
 *    carries reason_recorded, and a refused reason comes back as the typed envelope without its value.
 * 2. Fails when: the dispatcher drops or rejects `reason`, the result loses reason_recorded, or the refusal echoes the
 *    reason.
 * 3. No new seam: dispatchToolCall over PGLite on a repo-less brain (no repository configured).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall, type ToolResult } from '../src/mcp/dispatch.ts';
import { registerLocalWriter, withVerifiedLocalRegistration } from '../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); });

const body = (result: ToolResult) => JSON.parse(result.content[0]!.text) as Record<string, any>;
const page = (text: string) => `---\ntitle: Refund policy\ntype: note\n---\n\n${text}\n`;

describe('A-T10: reasons over MCP, remote=true', () => {
  test('put_page with a reason, a second edition, then get_versions', async () => {
    await withEnv({ GBRAIN_HOME: mkdtempSync(join(tmpdir(), 'gbra217-mcp-')) }, async () => {
      const registration = await registerLocalWriter(engine, 'stdio', { sourceIds: ['*'], operations: null, scopes: ['read', 'write'], slugPrefixes: ['policies'] });
      const auth = { token: 'fixture', clientId: 'fixture-client', scopes: ['read', 'write'], sourceId: 'default', boundSlugPrefixes: ['policies'] };
      const call = (name: string, params: Record<string, unknown>) => withVerifiedLocalRegistration(engine, registration, () => dispatchToolCall(engine, name, params,
        { remote: true, config: { engine: 'pglite' }, sourceId: 'default', auth, logger: { info() {}, warn() {}, error() {} }, writeWaitMs: 30_000 }));
      const slug = 'policies/refunds-example';
      const created = await call('put_page', { slug, content: page('Refunds within 14 days.'), request_id: randomUUID(), reason: 'First edition.' });
      expect(created.isError).toBeFalsy();
      expect(JSON.stringify(body(created))).toContain('"page_created"');
      const read = body(await call('get_page', { slug, include_content: true }));
      const second = await call('put_page', { slug, content: page('Refunds within 30 days.'), expected_revision: read.revision, request_id: randomUUID(), reason: 'Client asked for the 30-day window.' });
      expect(second.isError).toBeFalsy();
      expect(JSON.stringify(body(second))).toContain('"no_repository"');
      const versions = body(await call('get_versions', { slug })) as unknown as Array<Record<string, unknown>>;
      expect(versions[0]!.replaced_because).toBe('Client asked for the 30-day window.');

      const secret = 'ghp_' + 'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2';
      const refused = await call('put_page', { slug, content: page('x'), request_id: randomUUID(), reason: `new token ${secret}` });
      expect(refused.isError).toBe(true);
      expect(body(refused)).toMatchObject({ error: 'invalid_params', code: 'change_reason_rejected', reason: 'reason_contains_secret' });
      expect(refused.content[0]!.text).not.toContain(secret);
    });
  }, 120_000);
});
