/**
 * #8104 item 3: the operator output of the private-pages grant axis (GBRA-156). Authoring gate:
 * (1) protects `gbrain auth list --json` (its exact field set: no token_hash, a status and a private_pages field per token),
 * the "Private pages" column of `auth list`, `auth clients` (text and JSON) and `auth rescope` (token and client), the
 * `renderPrivatePages` labels, and the top rung of the `listClientRows` fallback ladder (a brain without the column
 * reads as none); (2) fails when token_hash or another raw column reaches the JSON, a granted principal prints as none,
 * or a brain without the column errors instead of listing; (3) existing coverage pinned none of this output;
 * (4) seam: the real CLI handlers against a PGLite brain under a sandboxed GBRAIN_HOME (console.log captured).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine } from '../src/core/engine-factory.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { listClientRows, renderPrivatePages, runAuth } from '../src/commands/auth.ts';
import { privatePagesFromColumn } from '../src/core/grants/model.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { withEnv } from './helpers/with-env.ts';

let root: string, home: string, db: string;
const GRANTED = 'granted-sources (private pages in the sources this grant names)';

async function withBrain<T>(run: (engine: BrainEngine) => Promise<T>): Promise<T> {
  const config = { engine: 'pglite' as const, database_path: db };
  const engine = await createEngine(config);
  await engine.connect(config);
  try { return await run(engine); } finally { await engine.disconnect(); }
}

const env = () => ({ GBRAIN_HOME: home, HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_SOURCE: undefined });

/** Runs one `gbrain auth` command and returns what it printed to stdout. */
async function auth(args: string[]): Promise<string> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...parts: unknown[]) => { lines.push(parts.join(' ')); };
  try { await withEnv(env(), () => runAuth(args)); } finally { console.log = original; }
  return lines.join('\n');
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'gb-auth-private-pages-'));
  home = join(root, 'home');
  db = join(root, 'db');
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: db }));
  await withBrain(async engine => {
    await engine.initSchema();
    const granted = await mintLegacyToken(engine, { name: 'alice-example', scopes: ['read'], takesHolders: ['world'], sourceGrant: ['default'] });
    await engine.executeRaw("UPDATE access_tokens SET private_pages = 'granted_sources' WHERE id = $1::uuid", [granted.id]);
    await mintLegacyToken(engine, { name: 'bob-example', scopes: ['read'], takesHolders: ['world'] });
    const revoked = await mintLegacyToken(engine, { name: 'old-example', scopes: ['read'], takesHolders: ['world'] });
    await engine.executeRaw('UPDATE access_tokens SET revoked_at = now() WHERE id = $1::uuid', [revoked.id]);
    for (const [id, pages] of [['client-granted', 'granted_sources'], ['client-plain', 'none']]) {
      await engine.executeRaw(`INSERT INTO oauth_clients (client_id, client_name, scope, source_id, federated_read, private_pages)
        VALUES ($1, $1, 'read', 'default', ARRAY['default'], $2)`, [id, pages]);
    }
  });
}, 120_000);

afterAll(() => { rmSync(root, { recursive: true, force: true }); });

describe('private-pages grant output (#8104)', () => {
  test('renderPrivatePages labels the two modes; anything else reads as none', () => {
    expect(renderPrivatePages('granted_sources')).toBe(GRANTED);
    expect(renderPrivatePages('none')).toBe('none');
    expect(renderPrivatePages(undefined)).toBe('none');
    expect(privatePagesFromColumn('granted-sources')).toBe('none');
    expect(privatePagesFromColumn(null)).toBe('none');
  });

  test('auth list --json prints exactly id, name, scopes, created_at, last_used_at, status and private_pages: never token_hash', async () => {
    const tokens = JSON.parse(await auth(['list', '--json'])) as Array<Record<string, unknown>>;
    for (const t of tokens) {
      expect(Object.keys(t).sort()).toEqual(['created_at', 'id', 'last_used_at', 'name', 'private_pages', 'scopes', 'status']);
    }
    expect(JSON.stringify(tokens)).not.toContain('token_hash');
    const byName = Object.fromEntries(tokens.map(t => [t.name as string, [t.status, t.private_pages]]));
    expect(byName).toEqual({ 'alice-example': ['active', 'granted_sources'], 'bob-example': ['active', 'none'], 'old-example': ['revoked', 'none'] });
  });

  test('auth list prints a Private pages column', async () => {
    const text = await auth(['list']);
    expect(text.split('\n')[0]).toContain('Private pages');
    expect(text.split('\n').find(l => l.includes('alice-example'))).toEndWith(GRANTED);
    expect(text.split('\n').find(l => l.includes('bob-example'))).toEndWith('  none');
  });

  test('auth clients prints the private pages line and the private_pages JSON field', async () => {
    const text = await auth(['clients']);
    expect(text).toContain(`client-granted (client-granted)`);
    const block = (id: string) => text.slice(text.indexOf(`${id} (${id})`)).split('\n').slice(0, 5).join('\n');
    expect(block('client-granted')).toContain(`  private pages: ${GRANTED}`);
    expect(block('client-plain')).toContain('  private pages: none');
    const json = JSON.parse(await auth(['clients', '--json'])) as { clients: Array<{ client_id: string; private_pages: string }> };
    expect(Object.fromEntries(json.clients.map(c => [c.client_id, c.private_pages]))).toEqual({ 'client-granted': 'granted_sources', 'client-plain': 'none' });
  });

  test('auth rescope prints the private pages change for a token and the axis for a client', async () => {
    const token = await auth(['rescope', '--token', 'bob-example', '--private-pages', 'granted-sources']);
    expect(token).toContain(`  Private pages: none -> ${GRANTED}`);
    const client = await auth(['rescope', '--client', 'client-plain', '--private-pages', 'granted-sources']);
    expect(client).toContain(`  Private pages: ${GRANTED}`);
  });

  test('a brain without the private_pages column lists its clients with private pages none (the top rung of the fallback ladder)', async () => {
    // Last test of the file: the column is dropped from this throwaway brain.
    const rows = await withBrain(async engine => {
      await engine.executeRaw('ALTER TABLE oauth_clients DROP COLUMN private_pages');
      return listClientRows(engine);
    });
    const granted = rows.find(r => r.client_id === 'client-granted')!;
    expect(granted.private_pages).toBeUndefined();
    expect(granted.allowed_operations).not.toBeUndefined();
    expect(privatePagesFromColumn(granted.private_pages)).toBe('none');
    expect(await auth(['clients'])).toContain('  private pages: none');
  });
});
