import { test, expect, describe } from 'bun:test';
import { parseAuthCreateArgs, parseAuthClientsArgs, parseRescopeSurfaceValue, renderTokenScopes } from '../src/commands/auth.ts';

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
