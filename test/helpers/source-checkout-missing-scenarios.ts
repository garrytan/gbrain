/**
 * GST-465: a source-scoped token's page writes when the source's directory is missing on the brain host.
 *
 * Two shapes, each run on PGLite (keyless) and Postgres through a real bearer token granted only the member's source
 * (remote, the serve-http path):
 * - the source is a subdirectory of a checkout and that subdirectory is missing (Git keeps no empty directory, so a
 *   fresh clone of a repository whose member folder has no files yet lacks it): put_page, private or not, capture and
 *   add_timeline_entry write the page, the missing directory is created, and the same token reads the page back.
 * - the source's whole checkout is missing (a brain copied to another machine or container without its source
 *   directories): every page write refuses with the classified source_checkout_missing refusal, not a storage_error
 *   that tells the agent to repair file permissions; a remote caller is not shown the host path; nothing is written.
 * Regression: both shapes refused every page write with storage_error ("The canonical file target cannot be accessed
 * as a regular file") because the file target was resolved against the source directory itself.
 */
import { expect } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { AuthInfo } from '../../src/core/ops/contract.ts';
import { GBrainOAuthProvider } from '../../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../../src/core/sql-query.ts';
import { mintLegacyToken } from '../../src/core/token-mint.ts';
import { parseRescopeTokenArgs, rescopeLegacyToken } from '../../src/core/grants/legacy-token.ts';
import { runManagedSourceLifecycle } from '../../src/core/persistence/source-lifecycle.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { managedBrain } from './managed-brain.ts';

const page = (title: string, extra = '') => `---\ntitle: ${title}\ntype: note\n${extra}---\n\n${title} body.\n`;

async function memberToken(engine: BrainEngine, sourceId: string): Promise<AuthInfo> {
  const name = `bot-${sourceId}`;
  const minted = await mintLegacyToken(engine, { name, scopes: ['read', 'write'], takesHolders: ['world'] });
  await rescopeLegacyToken(engine, parseRescopeTokenArgs([name, '--sources', sourceId, '--private-pages', 'granted-sources']));
  const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
  const auth = await provider.verifyAccessToken(minted.token) as unknown as AuthInfo;
  expect(auth).toMatchObject({ sourceId, allowedSources: [sourceId] });
  return auth;
}

function caller(engine: BrainEngine, auth: AuthInfo) {
  return async (op: string, args: Record<string, unknown>) => {
    const out = await dispatchToolCall(engine, op, args, { remote: true, transport: 'http', sourceId: auth.sourceId, auth });
    const text = (out.content[0] as { text: string }).text;
    return { isError: out.isError === true, text, body: JSON.parse(text) as Record<string, any> };
  };
}

export function missingSourceSubdirectory(databaseUrl?: string) {
  return managedBrain(async ({ engine, root }) => {
    const checkout = join(root, '..', 'workspace');
    const memberDir = join(checkout, 'member-a');
    mkdirSync(memberDir, { recursive: true });
    writeFileSync(join(checkout, 'README.md'), 'workspace\n');
    execFileSync('git', ['-C', checkout, 'init', '-q']);
    await runManagedSourceLifecycle(engine, { operation: 'add', sourceId: 'member-a', path: memberDir });
    rmSync(memberDir, { recursive: true, force: true });
    const call = caller(engine, await memberToken(engine, 'member-a'));

    for (const [slug, extra] of [['notes/plain-a', ''], ['notes/private-a', 'visibility: private\n']] as const) {
      const put = await call('put_page', { slug, content: page(slug, extra) });
      expect({ slug, error: put.body.error ?? null }).toEqual({ slug, error: null });
      expect(put.body).toMatchObject({ slug, source_id: 'member-a' });
      expect(readFileSync(join(memberDir, `${slug}.md`), 'utf8')).toContain(`${slug} body.`);
      const read = await call('get_page', { slug });
      expect({ slug, error: read.body.error ?? null, source: read.body.source_id }).toEqual({ slug, error: null, source: 'member-a' });
      expect(read.body.compiled_truth).toContain(`${slug} body.`);
    }
    const captured = await call('capture', { content: 'Captured by the member token.', slug: 'notes/captured-a' });
    expect(captured.body.error ?? null).toBeNull();
    expect((await call('get_page', { slug: 'notes/captured-a' })).body.compiled_truth).toContain('Captured by the member token.');
    const timeline = await call('add_timeline_entry', { slug: 'notes/plain-a', date: '2026-10-31', summary: 'Member timeline entry' });
    expect(timeline.body.error ?? null).toBeNull();
    expect((await call('get_page', { slug: 'notes/plain-a' })).body.timeline).toContain('Member timeline entry');
  }, { databaseUrl });
}

export function missingSourceCheckout(databaseUrl?: string) {
  return managedBrain(async ({ engine, root }) => {
    const memberDir = join(root, '..', 'staging', 'member-b');
    mkdirSync(memberDir, { recursive: true });
    await runManagedSourceLifecycle(engine, { operation: 'add', sourceId: 'member-b', path: memberDir });
    rmSync(join(root, '..', 'staging'), { recursive: true, force: true });
    const call = caller(engine, await memberToken(engine, 'member-b'));

    for (const [op, args] of [
      ['put_page', { slug: 'notes/plain-b', content: page('notes/plain-b') }],
      ['put_page', { slug: 'notes/private-b', content: page('notes/private-b', 'visibility: private\n') }],
      ['capture', { content: 'Captured into a missing checkout.', slug: 'notes/captured-b' }],
    ] as const) {
      const out = await call(op, { ...args });
      expect({ op, isError: out.isError, code: out.body.code, detail: out.body.detail }).toEqual({ op, isError: true, code: 'recovery_required', detail: 'source_checkout_missing' });
      expect(out.body.message).toContain("source 'member-b'");
      expect(out.text).not.toContain(memberDir);
      expect((await call('get_page', { slug: args.slug })).body.error).toBe('page_not_found');
    }
    expect(existsSync(memberDir)).toBe(false);
  }, { databaseUrl });
}
