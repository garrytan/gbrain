/**
 * #5913: `remember` was fenced inside the persistence layer (planRememberTarget
 * fences the entity slug or `memory/unattributed` before admission) but never
 * added to `CLIENT_FENCED_WRITE_OPS`, so the fail-closed dispatch gate denied
 * it to every slug-bound client before the fence could run, and a bound
 * `memory-writer` / `coding-agent` grant (which requires prefixes) could not
 * remember anything. The op is allow-listed now; `forget`/`forget_fact` are
 * not ([UC6]: a withdrawal's write set reaches pages the fenced slug does not
 * name, so they wait for a confined closure).
 *
 * [R2] `replaces` is confined to the caller's entity and page, and a bound
 * client learns nothing about a fact outside its prefixes through it: the
 * refusal is byte-identical to the one for an id that does not exist.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { CLIENT_FENCED_WRITE_OPS, opAllowedForBoundClient, operations, type AuthInfo } from '../src/core/operations.ts';
import { resolveGrantProfile } from '../src/core/grants/profiles.ts';

const STDIO = { remote: true, transport: 'stdio' as const, sourceId: 'default' };
const parsed = (result: { content: Array<{ text: string }> }): Record<string, any> => JSON.parse(result.content[0]!.text);
const auth: AuthInfo = { token: 't', clientId: 'bound-example', principal: { kind: 'oauth_client', id: 'bound-example' },
  scopes: ['read', 'write'], sourceId: 'default', boundSlugPrefixes: ['notes/'] } as AuthInfo;
const op = (name: string) => operations.find(o => o.name === name)!;

describe('grant profiles and the bound-client allow-list (#5913)', () => {
  test('a prefix-bound memory-writer or coding-agent grant lists remember and not forget/forget_fact', () => {
    for (const profile of ['memory-writer', 'coding-agent'] as const) {
      const grant = resolveGrantProfile({ profile, sourceId: 'default', boundSlugPrefixes: ['notes/'] });
      expect(grant.allowedOperations).toContain('remember');
      expect(grant.allowedOperations).not.toContain('forget');
      expect(grant.allowedOperations).not.toContain('forget_fact');
      expect(grant.allowedOperations).toContain('recall');
    }
  });

  test('the dispatch predicate and the catalog filter agree: remember allowed, withdrawal denied, degraded fence denies everything', () => {
    expect(CLIENT_FENCED_WRITE_OPS.has('remember')).toBe(true);
    expect(CLIENT_FENCED_WRITE_OPS.has('forget')).toBe(false);
    expect(CLIENT_FENCED_WRITE_OPS.has('forget_fact')).toBe(false);
    const bound = { boundSlugPrefixes: ['notes/'] };
    expect(opAllowedForBoundClient(bound, op('remember'))).toBe(true);
    expect(opAllowedForBoundClient(bound, op('forget'))).toBe(false);
    expect(opAllowedForBoundClient(bound, op('forget_fact'))).toBe(false);
    expect(opAllowedForBoundClient({ ...bound, fenceProjectionDegraded: true }, op('remember'))).toBe(false);
    expect(opAllowedForBoundClient({ boundSlugPrefixes: [] }, op('remember'))).toBe(true);
  });
});

describe('a notes/-bound client remembering through dispatch (#5913)', () => {
  let engine: PGLiteEngine;
  let outsideFactId: string;
  const put = (slug: string, type: string) => dispatchToolCall(engine, 'put_page',
    { slug, content: `---\ntype: ${type}\ntitle: ${slug}\n---\n# ${slug}\n\nBody.\n`, request_id: randomUUID() }, { ...STDIO });
  const remember = (params: Record<string, unknown>, bound = true) =>
    dispatchToolCall(engine, 'remember', { provenance: 'test', request_id: randomUUID(), ...params }, bound ? { ...STDIO, auth } : { ...STDIO }).then(parsed);
  const facts = (slug: string) => engine.executeRaw<{ fact: string }>("SELECT fact FROM facts WHERE source_id='default' AND entity_slug=$1 AND expired_at IS NULL ORDER BY id", [slug]);

  beforeAll(async () => {
    engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
    await engine.setConfig('schema_pack', 'gbrain-base');
    await engine.setConfig('sync.write_through', 'false');
    await engine.executeRaw(`INSERT INTO oauth_clients(client_id,client_name,scope,source_id,bound_slug_prefixes)
      VALUES ('bound-example','Synthetic bound client','read write','default',$1::text[])`, [['notes/']]);
    expect(parsed(await put('notes/project-x', 'note')).state).toBe('committed');
    expect(parsed(await put('people/someone-example', 'person')).state).toBe('committed');
    const outside = await remember({ fact: 'Someone prefers tea over coffee.', entity: 'people/someone-example' }, false);
    expect(outside.status).toBe('inserted');
    outsideFactId = String(outside.id);
  }, 120_000);
  afterAll(async () => { await engine.disconnect(); });

  test('remember inside the prefix commits; outside it and unattributed are refused by the slug fence with nothing saved', async () => {
    const inside = await remember({ fact: 'Project X ships on Friday.', entity: 'notes/project-x' });
    expect(inside.error).toBeUndefined();
    expect(inside).toMatchObject({ status: 'inserted', entity_slug: 'notes/project-x' });
    expect((await facts('notes/project-x')).map(row => row.fact)).toEqual(['Project X ships on Friday.']);

    const outside = await remember({ fact: 'Someone likes hiking.', entity: 'people/someone-example' });
    expect(outside.error).toBe('scope_denied');
    expect(outside.message).toContain("remember: slug 'people/someone-example' is not under any of client bound-example's bound_slug_prefixes (notes/)");
    expect((await facts('people/someone-example')).map(row => row.fact)).toEqual(['Someone prefers tea over coffee.']);

    const unattributed = await remember({ fact: 'A stray thought.' });
    expect(unattributed.error).toBe('scope_denied');
    expect(unattributed.message).toContain("slug 'memory/unattributed' is not under");
    expect(await engine.executeRaw("SELECT id FROM facts WHERE source_id='default' AND entity_slug IS NULL")).toEqual([]);
  });

  test('[R2] replaces naming a fact outside the prefixes answers exactly like a missing id, and the fact stays active', async () => {
    const missing = await remember({ fact: 'Someone prefers coffee over tea.', entity: 'notes/project-x', replaces: '999999' });
    expect(missing.error).toBe('not_found');
    const probed = await remember({ fact: 'Someone prefers coffee over tea.', entity: 'notes/project-x', replaces: outsideFactId });
    const envelope = ({ error, code, message, suggestion }: Record<string, unknown>) =>
      ({ error, code, message: String(message).replace(/"\d+"/, '"<id>"'), suggestion });
    expect(envelope(probed)).toEqual(envelope(missing));
    expect(JSON.stringify(probed)).not.toContain('people/someone-example');
    expect((await facts('people/someone-example')).map(row => row.fact)).toEqual(['Someone prefers tea over coffee.']);
    expect((await facts('notes/project-x')).map(row => row.fact)).toEqual(['Project X ships on Friday.']);
    // An unbound caller keeps the explanatory mismatch.
    const unbound = await remember({ fact: 'Someone prefers coffee over tea.', entity: 'notes/project-x', replaces: outsideFactId }, false);
    expect(unbound.error).toBe('invalid_params');
    expect(unbound.message).toContain('replaces_entity_mismatch');
  });

  test('forget and forget_fact stay denied at dispatch for the bound client', async () => {
    for (const [name, params] of [['forget', { id: '2' }], ['forget_fact', { id: 2 }]] as const) {
      const denied = parsed(await dispatchToolCall(engine, name, { ...params, request_id: randomUUID() }, { ...STDIO, auth }));
      expect(denied.error).toBe('permission_denied');
      expect(denied.message).toContain(`${name} is not available to slug-bound clients`);
    }
    expect((await facts('notes/project-x')).map(row => row.fact)).toEqual(['Project X ships on Friday.']);
  });
});
