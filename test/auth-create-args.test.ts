import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { parseAuthCreateArgs, parseAuthClientsArgs, parseRescopeSurfaceValue, renderTokenScopes, listClientRows, insertLegacyToken } from '../src/commands/auth.ts';
import { parseLegacyTokenScope } from '../src/core/legacy-token-scope.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

describe('parseAuthCreateArgs', () => {
  test('bare name (no flag) resolves the name — regression for the dropped-name bug', () => {
    // Pre-fix this returned name='' because rest[takesIdx+1] === rest[0] when
    // takesIdx === -1, excluding the only positional from the search.
    expect(parseAuthCreateArgs(['claude-code'])).toEqual({ name: 'claude-code', takesHolders: undefined });
  });

  test('name + --takes-holders', () => {
    expect(parseAuthCreateArgs(['claude-code', '--takes-holders', 'world,garry'])).toEqual({
      name: 'claude-code',
      takesHolders: ['world', 'garry'],
    });
  });

  test('--takes-holders before the name still finds the name', () => {
    expect(parseAuthCreateArgs(['--takes-holders', 'world', 'claude-code'])).toEqual({
      name: 'claude-code',
      takesHolders: ['world'],
    });
  });

  test('the takes-holders value is not mistaken for the name', () => {
    // 'world' is the flag value, 'mybot' is the name.
    expect(parseAuthCreateArgs(['--takes-holders', 'world', 'mybot']).name).toBe('mybot');
  });

  test('no name → empty string (caller prints usage)', () => {
    expect(parseAuthCreateArgs([]).name).toBe('');
    expect(parseAuthCreateArgs(['--takes-holders', 'world']).name).toBe('');
  });

  test('takes-holders trims + drops empties', () => {
    expect(parseAuthCreateArgs(['n', '--takes-holders', ' world , , garry ']).takesHolders).toEqual(['world', 'garry']);
  });

  test('--scopes: comma and/or whitespace separated, value excluded from positional search (#4043)', () => {
    expect(parseAuthCreateArgs(['harness', '--scopes', 'read,write']).scopes).toEqual(['read', 'write']);
    expect(parseAuthCreateArgs(['--scopes', 'read write', 'harness'])).toMatchObject({
      name: 'harness',
      scopes: ['read', 'write'],
    });
    expect(parseAuthCreateArgs(['harness', '--scopes', ' read ,  write ']).scopes).toEqual(['read', 'write']);
  });

  test('--scopes with both flags present still resolves the name', () => {
    expect(
      parseAuthCreateArgs(['--takes-holders', 'world', '--scopes', 'read,write', 'harness']).name,
    ).toBe('harness');
  });

  test('--scopes absent → no scopes key (grandfather lane); empty value → empty array for create() to refuse', () => {
    expect('scopes' in parseAuthCreateArgs(['n'])).toBe(false);
    expect(parseAuthCreateArgs(['n', '--scopes', ',']).scopes).toEqual([]);
  });

  test('missing/flag-like values fail closed — a dropped --scopes would mint a FULL-ACCESS token', () => {
    expect(parseAuthCreateArgs(['n', '--scopes']).error).toMatch(/scopes flag requires a value/);
    expect(parseAuthCreateArgs(['n', '--scopes', '--takes-holders', 'world']).error).toMatch(/scopes flag requires a value/);
    expect(parseAuthCreateArgs(['n', '--takes-holders']).error).toMatch(/takes-holders flag requires a value/);
    expect(parseAuthCreateArgs(['n', '--takes-holders', '--scopes', 'read']).error).toMatch(/takes-holders flag requires a value/);
  });

  // --source (#4780): the source grant of a legacy bearer token. Without it
  // every hand-minted token fell back to the literal 'default' in
  // parseLegacyTokenScope, which on a multi-source brain routes writes to
  // whichever source happens to be named 'default' with no warning.
  test('name + --source', () => {
    expect(parseAuthCreateArgs(['claude-code', '--source', 'workspace'])).toEqual({
      name: 'claude-code',
      takesHolders: undefined,
      source: 'workspace',
    });
  });

  test('--source before the name still finds the name', () => {
    expect(parseAuthCreateArgs(['--source', 'workspace', 'claude-code']).name).toBe('claude-code');
  });

  test('the source value is not mistaken for the name', () => {
    expect(parseAuthCreateArgs(['--source', 'workspace', 'mybot']).source).toBe('workspace');
    expect(parseAuthCreateArgs(['--source', 'workspace', 'mybot']).name).toBe('mybot');
  });

  test('--source as the last arg fails closed', () => {
    // Fail-open here would mint a token silently scoped to 'default' — the
    // exact bug this flag exists to fix.
    expect(parseAuthCreateArgs(['mybot', '--source']).error).toContain('source flag requires a value');
  });

  test('--source followed by another flag fails closed', () => {
    // The other flag gets a value here on purpose — otherwise ITS check
    // fires first: the parser checks takes-holders and scopes before source.
    expect(parseAuthCreateArgs(['mybot', '--source', '--takes-holders', 'world']).error)
      .toContain('source flag requires a value');
  });

  test('omitting --source leaves source undefined (grandfathered behaviour)', () => {
    expect(parseAuthCreateArgs(['mybot']).source).toBeUndefined();
  });

  test('--source combines with --scopes and --takes-holders', () => {
    expect(parseAuthCreateArgs([
      'mybot', '--scopes', 'read,write', '--takes-holders', 'world', '--source', 'workspace',
    ])).toEqual({
      name: 'mybot',
      takesHolders: ['world'],
      scopes: ['read', 'write'],
      source: 'workspace',
    });
  });

  test('--source=<id> (equals form) is parsed, not silently dropped', () => {
    // The CLI flag validator admits `--source=x` for `auth`; a parser that
    // only looked for the bare `--source` token would mint a default-floor
    // token without a word.
    expect(parseAuthCreateArgs(['mybot', '--source=workspace'])).toEqual({
      name: 'mybot',
      takesHolders: undefined,
      source: 'workspace',
    });
    // A name that equals the inline value is still the name.
    expect(parseAuthCreateArgs(['workspace', '--source=workspace']).name).toBe('workspace');
    expect(parseAuthCreateArgs(['mybot', '--source=']).error).toContain('source flag requires a non-empty value');
  });

  test('--scopes=<v> / --takes-holders=<v> (equals form) are parsed, not silently dropped', () => {
    // Same class as the --source= gap: the CLI flag validator admits the
    // inline form, and an unmatched --scopes= left scopes undefined, so
    // insertLegacyToken wrote scopes = NULL and minted a full-access token.
    expect(parseAuthCreateArgs(['bot', '--scopes=read'])).toEqual({ name: 'bot', takesHolders: undefined, scopes: ['read'] });
    expect(parseAuthCreateArgs(['bot', '--takes-holders=world,charlie-example'])).toEqual({
      name: 'bot',
      takesHolders: ['world', 'charlie-example'],
    });
    expect(parseAuthCreateArgs(['bot', '--scopes=']).error).toMatch(/scopes flag requires a value/);
    expect(parseAuthCreateArgs(['bot', '--scopes=--x']).error).toMatch(/scopes flag requires a value/);
    expect(parseAuthCreateArgs(['bot', '--takes-holders=']).error).toMatch(/takes-holders flag requires a value/);
    // Inline forms never occupy a value slot, so the positional survives.
    expect(parseAuthCreateArgs(['workspace', '--source=workspace', '--scopes=read,write'])).toEqual({
      name: 'workspace',
      takesHolders: undefined,
      source: 'workspace',
      scopes: ['read', 'write'],
    });
  });
});

describe('renderTokenScopes', () => {
  test('NULL grandfathers, [] denies, arrays filter to strings', () => {
    expect(renderTokenScopes(null)).toBe('admin (grandfathered)');
    expect(renderTokenScopes(undefined)).toBe('admin (grandfathered)');
    expect(renderTokenScopes([])).toBe('(deny-all)');
    expect(renderTokenScopes(['read', 'write'])).toBe('read,write');
    expect(renderTokenScopes(['read', 7, 'write'])).toBe('read,write');
  });

  test('rendering matches the ENFORCEMENT path (normalizeTokenScopes), never claims admin on scoped/denied rows', () => {
    // Undecoded TEXT[] string form: the serve scopes this — list must not say admin.
    expect(renderTokenScopes('{read,write}')).toBe('read,write');
    // Representation drift on a written row: the serve DENIES this — list must not say admin.
    expect(renderTokenScopes('weird')).toBe('(deny-all)');
    expect(renderTokenScopes(42)).toBe('(deny-all)');
  });
});

// WP4: `auth rescope-client --surface` value parsing. 'clear' → null (clears
// the pin), the three known surfaces pass through, anything else → undefined
// (caller errors with usage).
describe('parseRescopeSurfaceValue (WP4)', () => {
  test('known surfaces pass through', () => {
    expect(parseRescopeSurfaceValue('verbs')).toBe('verbs');
    expect(parseRescopeSurfaceValue('starter')).toBe('starter');
    expect(parseRescopeSurfaceValue('full')).toBe('full');
  });

  test("'clear' → null (removes the operator pin)", () => {
    expect(parseRescopeSurfaceValue('clear')).toBe(null);
  });

  test('anything else → undefined (loud CLI error)', () => {
    expect(parseRescopeSurfaceValue('everything')).toBeUndefined();
    expect(parseRescopeSurfaceValue('')).toBeUndefined();
    expect(parseRescopeSurfaceValue('none')).toBeUndefined();
  });
});

// E4 (WP4): `auth clients [--usage] [--days N] [--json]` flag parsing.
describe('parseAuthClientsArgs (E4)', () => {
  test('defaults: no usage join, 30d window, human output', () => {
    expect(parseAuthClientsArgs([])).toEqual({ usage: false, days: 30, json: false });
  });

  test('--usage and --json flags, in any order', () => {
    expect(parseAuthClientsArgs(['--usage', '--json'])).toEqual({ usage: true, days: 30, json: true });
    expect(parseAuthClientsArgs(['--json', '--usage'])).toEqual({ usage: true, days: 30, json: true });
  });

  test('--days accepts integers in [1, 3650]', () => {
    expect(parseAuthClientsArgs(['--days', '1']).days).toBe(1);
    expect(parseAuthClientsArgs(['--days', '90']).days).toBe(90);
    expect(parseAuthClientsArgs(['--days', '3650']).days).toBe(3650);
  });

  test('a token named after its source keeps its name (value equality must not swallow the positional)', () => {
    expect(parseAuthCreateArgs(['workspace', '--source', 'workspace'])).toEqual({ name: 'workspace', source: 'workspace' });
    expect(parseAuthCreateArgs(['--source', 'workspace', 'workspace'])).toEqual({ name: 'workspace', source: 'workspace' });
    expect(parseAuthCreateArgs(['read', '--scopes', 'read'])).toEqual({ name: 'read', scopes: ['read'] });
  });

  test('--days rejects out-of-bounds and non-integer values loudly', () => {
    expect(() => parseAuthClientsArgs(['--days', '0'])).toThrow(/--days/);
    expect(() => parseAuthClientsArgs(['--days', '3651'])).toThrow(/--days/);
    expect(() => parseAuthClientsArgs(['--days', '1.5'])).toThrow(/--days/);
    expect(() => parseAuthClientsArgs(['--days', 'soon'])).toThrow(/--days/);
    expect(() => parseAuthClientsArgs(['--days'])).toThrow(/--days/);
  });

  test('unknown flags reject loudly', () => {
    expect(() => parseAuthClientsArgs(['--nope'])).toThrow(/Unknown flag/);
  });
});

// cathedral-6: `auth clients` projection widen — source_id + federated_read
// ride the same SELECT (zero extra round trips) with a degrade ladder for
// pre-migration brains. PGLite-backed: proves the full-shape query is valid
// SQL on a current schema and the row shape carries the new columns.
describe('listClientRows (projection widen)', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  test('full-shape rows carry scope, surface, source_id and federated_read', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('proj-widget', 'proj-widget')`,
    );
    await engine.executeRaw(
      `INSERT INTO oauth_clients (client_id, client_name, scope, surface, surface_set_by, source_id, federated_read)
       VALUES ('c-aurora', 'aurora-coder', 'read write', 'starter', 'operator', 'proj-widget', $1)`,
      [['proj-widget', 'default']],
    );
    const rows = await listClientRows(engine);
    const aurora = rows.find(r => r.client_id === 'c-aurora');
    expect(aurora).toBeDefined();
    expect(aurora!.client_name).toBe('aurora-coder');
    expect(aurora!.scope).toBe('read write');
    expect(aurora!.surface).toBe('starter');
    expect(aurora!.surface_set_by).toBe('operator');
    expect(aurora!.source_id).toBe('proj-widget');
    expect(aurora!.federated_read).toEqual(['proj-widget', 'default']);
  });
});

describe('insertLegacyToken (auth create mint core, PGLite)', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('workspace-a', 'workspace-a')`);
    await engine.executeRaw(
      `INSERT INTO sources (id, name, archived, archived_at) VALUES ('old-import', 'old-import', true, now())`,
    );
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  const permissionsOf = async (name: string): Promise<Record<string, unknown>> => {
    const rows = await engine.executeRaw<{ permissions: Record<string, unknown> }>(
      `SELECT permissions FROM access_tokens WHERE name = $1`,
      [name],
    );
    expect(rows.length).toBe(1);
    return rows[0].permissions;
  };

  test('--source lands in permissions.source_id as a one-element grant that parseLegacyTokenScope confines to', async () => {
    await insertLegacyToken(engine, {
      name: 'scoped-bot', hash: 'h-scoped', takesHolders: ['world'], scopes: ['read', 'write'], source: 'workspace-a',
    });
    const perms = await permissionsOf('scoped-bot');
    expect(perms.takes_holders).toEqual(['world']);
    // Same shape token-mint.ts (bootstrap harness) writes: ARRAY, element 0 =
    // write floor — so both legacy mint paths emit one shape.
    expect(perms.source_id).toEqual(['workspace-a']);
    const scope = parseLegacyTokenScope(perms.source_id);
    expect(scope.sourceId).toBe('workspace-a');
    expect(scope.allowedSources).toEqual(['workspace-a']);
  });

  test('omitting --source writes no source_id → the historical default floor (grandfathered)', async () => {
    await insertLegacyToken(engine, { name: 'plain-bot', hash: 'h-plain', takesHolders: ['world'] });
    const perms = await permissionsOf('plain-bot');
    expect('source_id' in perms).toBe(false);
    expect(parseLegacyTokenScope(perms.source_id)).toEqual({ sourceId: 'default' });
  });

  test('unknown source refuses loudly at mint time and inserts nothing', async () => {
    await expect(insertLegacyToken(engine, {
      name: 'typo-bot', hash: 'h-typo', takesHolders: ['world'], source: 'workspace-b',
    })).rejects.toThrow(/source "workspace-b" does not exist/);
    const rows = await engine.executeRaw(`SELECT 1 FROM access_tokens WHERE name = 'typo-bot'`);
    expect(rows.length).toBe(0);
  });

  test('archived source refuses — writes must not land in a search-excluded import', async () => {
    await expect(insertLegacyToken(engine, {
      name: 'archived-bot', hash: 'h-archived', takesHolders: ['world'], source: 'old-import',
    })).rejects.toThrow(/source "old-import" is archived/);
    const rows = await engine.executeRaw(`SELECT 1 FROM access_tokens WHERE name = 'archived-bot'`);
    expect(rows.length).toBe(0);
  });

  test('malformed source id is rejected before the sources query', async () => {
    await expect(insertLegacyToken(engine, {
      name: 'bad-id-bot', hash: 'h-bad', takesHolders: ['world'], source: 'Not A Source!',
    })).rejects.toThrow(/Invalid source_id/);
  });
});
