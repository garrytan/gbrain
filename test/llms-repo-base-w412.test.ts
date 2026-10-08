/**
 * Wave 12 W4.12: `LLMS_REPO_BASE` (the fork override for documentation links)
 * accepts only a plain https base. Agents follow rendered `docs` links as fix
 * instructions, so a `javascript:`, `http:` or credentialed value is ignored at
 * runtime (default links, one warning) and refused by the build scripts.
 */
import { describe, expect, test } from 'bun:test';
import { docsUrl } from '../src/core/agent-output.ts';
import { parseRepoBase, repoBaseOrThrow } from '../src/core/repo-base.ts';
import { repoBlobBase } from '../scripts/portable-skill-links.ts';
import { withEnv } from './helpers/with-env.ts';

const BAD = ['javascript:alert(1)//', 'http://docs.example.test', 'https://user:pw@docs.example.test', 'https://docs.example.test/x?y=1', 'https://docs.example.test/x#y', 'ftp://docs.example.test', 'https://docs.example .test'];

describe('W4.12: LLMS_REPO_BASE must be a plain https URL', () => {
  test('a valid fork base still wins', async () => {
    await withEnv({ LLMS_REPO_BASE: 'https://raw.githubusercontent.com/fork-org/gbrain/main/' }, () => {
      expect(docsUrl('docs/guides/error-codes.md#x')).toBe('https://raw.githubusercontent.com/fork-org/gbrain/main/docs/guides/error-codes.md#x');
    });
    expect(repoBlobBase({ LLMS_REPO_BASE: 'https://raw.githubusercontent.com/fork-org/gbrain/main' })).toBe('https://github.com/fork-org/gbrain/blob/main');
  });

  for (const value of BAD) {
    test(`runtime docs links ignore ${JSON.stringify(value)}`, async () => {
      const writes: string[] = [];
      const write = process.stderr.write.bind(process.stderr);
      (process.stderr.write as unknown as (c: unknown) => boolean) = (c: unknown) => { writes.push(String(c)); return true; };
      try {
        await withEnv({ LLMS_REPO_BASE: value }, () => {
          const url = docsUrl('docs/guides/error-codes.md#x');
          expect(url.startsWith('https://github.com/garrytan/gbrain/blob/')).toBe(true);
          expect(url).not.toContain(value.replace(/\/+$/, ''));
        });
      } finally { process.stderr.write = write; }
      expect(parseRepoBase(value)).toEqual({ invalid: value.trim().replace(/\/+$/, '') });
    });

    test(`build scripts refuse ${JSON.stringify(value)}`, () => {
      expect(() => repoBlobBase({ LLMS_REPO_BASE: value })).toThrow(/LLMS_REPO_BASE must be a plain https URL/);
      expect(() => repoBaseOrThrow(value, 'https://fallback.example.test')).toThrow(/plain https URL/);
    });
  }

  test('unset or blank falls back to the default', () => {
    expect(parseRepoBase(undefined)).toBeNull();
    expect(parseRepoBase('  ')).toBeNull();
    expect(repoBlobBase({})).toBe('https://github.com/garrytan/gbrain/blob/master');
  });
});
