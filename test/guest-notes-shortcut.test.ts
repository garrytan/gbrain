/**
 * Guest notes (GBRA-504): no config key can hide a guest source.
 *
 * Protects: whether a read stamps guest notes is decided from the sources themselves, never from a separate marker, so
 * a source marked guest by a config edit alone (no `gbrain guests init`), or listed in guest_sources after its config
 * lost the guest key (a restored database, a config rewrite), still has its pages marked when a remote caller reads
 * them; and a failed guest-source check marks or refuses the read, never returns it bare.
 *
 * Real seams: MCP dispatch of list_pages over stdio as the owner on a repo-less PGLite brain; the source changes are
 * plain SQL.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { addMember } from '../src/core/access/members.ts';
import { setOwner } from '../src/core/access/owner.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { GUEST_NOTES_MIGRATION } from '../src/core/guests/migration.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';

const OWNER = 'alice-example';
const EDITED = 'source-edited';
const LISTED = 'source-listed';
const FAILED = 'source-failed';
const SLUG = 'notes/visitor';

let engine: PGLiteEngine;

/** list_pages: an op with no trust stamp of its own, so only the read-time guest stamp can mark its rows. */
async function readAsOwner(sourceId: string) {
  const out = await dispatchToolCall(engine, 'list_pages', {}, { remote: true, transport: 'stdio', stdioMember: OWNER, sourceId, takesHoldersAllowList: ['world'] });
  const text = out.content[0]!.text;
  let rows: any[] = [];
  try { const parsed = JSON.parse(text); rows = Array.isArray(parsed) ? parsed : parsed.pages ?? []; } catch { /* an error text */ }
  return { isError: out.isError === true, text, json: rows.find(r => r.slug === SLUG) ?? null };
}
const marked = (out: Awaited<ReturnType<typeof readAsOwner>>) =>
  ({ isError: out.isError, origin: out.json?.origin, tier: out.json?.trust_tier, unattributed: out.json?.guest?.unattributed });
const MARKED = { isError: false, origin: 'guest', tier: 'external_untrusted', unattributed: true };

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await addMember(engine, OWNER);
  await setOwner(engine, OWNER);
  for (const id of [EDITED, LISTED, FAILED]) {
    await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [id]);
    await importFromContent(engine, SLUG, '---\ntype: note\ntitle: Visitor note\n---\n# Visitor note\n\nA visitor wrote this in ' + id + '.\n', { sourceId: id });
  }
}, 240_000);
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); }, 60_000);

describe('a guest source the guests command never set up', () => {
  test('a source marked guest by a config edit alone is marked on a remote read', async () => {
    const before = await readAsOwner(EDITED);
    expect({ isError: before.isError, found: before.json !== null, origin: before.json?.origin === 'guest' }).toEqual({ isError: false, found: true, origin: false });
    await engine.executeRaw(`UPDATE sources SET config = config || '{"guest": true}'::jsonb WHERE id = $1`, [EDITED]);
    expect(marked(await readAsOwner(EDITED))).toEqual(MARKED);
  }, 60_000);

  test('a source in guest_sources whose config lost the guest key is marked on a remote read', async () => {
    await engine.executeRaw(`INSERT INTO guest_sources (source_id, writers, trust_ceiling) VALUES ($1, '{}'::text[], 'external_untrusted')`, [LISTED]);
    const [row] = await engine.executeRaw<{ guest: string | null }>(`SELECT config->>'guest' AS guest FROM sources WHERE id = $1`, [LISTED]);
    expect(row!.guest).toBeNull();
    expect(marked(await readAsOwner(LISTED))).toEqual(MARKED);
  }, 60_000);

  test('a failed guest-source check marks or refuses the read, never returns it bare', async () => {
    await engine.executeRaw(`UPDATE sources SET config = config || '{"guest": true}'::jsonb WHERE id = $1`, [FAILED]);
    const real = PGLiteEngine.prototype.executeRaw;
    (engine as any).executeRaw = function (this: PGLiteEngine, sql: string, params?: unknown[]) {
      if (/guest/.test(sql) && !/\bpages\b/.test(sql)) return Promise.reject(new Error('guest-source check unavailable'));
      return real.call(this, sql, params as never);
    };
    let out: Awaited<ReturnType<typeof readAsOwner>>;
    try { out = await readAsOwner(FAILED); } finally { delete (engine as any).executeRaw; }
    expect(out.isError || out.json?.origin === 'guest').toBe(true);
  }, 60_000);
});

describe('a brain whose schema is behind migration v' + GUEST_NOTES_MIGRATION, () => {
  test('reads still work without the guest tables, and a config-marked guest source is still marked', async () => {
    const old = new PGLiteEngine();
    await old.connect({});
    await old.initSchema();
    try {
      await addMember(old, OWNER);
      await setOwner(old, OWNER);
      for (const id of [EDITED, LISTED]) {
        await old.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [id]);
        await importFromContent(old, SLUG, '---\ntype: note\ntitle: Visitor note\n---\n# Visitor note\n\nA visitor wrote this in ' + id + '.\n', { sourceId: id });
      }
      await old.executeRaw(`UPDATE sources SET config = config || '{"guest": true}'::jsonb WHERE id = $1`, [EDITED]);
      await old.executeRaw('DROP TABLE guest_promotions, guest_marks, guest_sources CASCADE');
      const read = async (op: string, params: Record<string, unknown>, sourceId: string) => {
        const out = await dispatchToolCall(old, op, params, { remote: true, transport: 'stdio', stdioMember: OWNER, sourceId, takesHoldersAllowList: ['world'] });
        const text = out.content[0]!.text;
        let json: any = null;
        try { json = JSON.parse(text); } catch { /* an error text */ }
        return { isError: out.isError === true, text, json };
      };
      const plain = await read('get_page', { slug: SLUG }, LISTED);
      expect({ isError: plain.isError, text: plain.isError ? plain.text : '', origin: plain.json?.origin === 'guest' }).toEqual({ isError: false, text: '', origin: false });
      const listed = await read('list_pages', {}, EDITED);
      const row = (Array.isArray(listed.json) ? listed.json : listed.json?.pages ?? []).find((r: any) => r.slug === SLUG);
      expect({ isError: listed.isError, origin: row?.origin, tier: row?.trust_tier }).toEqual({ isError: false, origin: 'guest', tier: 'external_untrusted' });
    } finally {
      await disposePersistenceConsumer(old);
      await old.disconnect();
    }
  }, 120_000);
});
