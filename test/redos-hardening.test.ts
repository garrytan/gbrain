// v0.41.37.0 #1569 — ReDoS hardening + diagnostics for schema-pack regexes.
//
// The real exposure was link-inference.ts:85 running `new RegExp(pattern)
// .test(context)` UNBOUNDED when no PageRegexBudget was passed. Fix: an input-
// length cap (the runtime safety net) + routing that path through the bounded
// executor + an advisory star-height lint rule.
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  runRegexBounded,
  PageRegexBudget,
  RegexInputTooLargeError,
  MAX_REGEX_INPUT_CHARS,
} from '../src/core/schema-pack/redos-guard.ts';
import { inferLinkTypeFromPack } from '../src/core/schema-pack/link-inference.ts';
import { linkRegexCatastrophicBacktrack } from '../src/core/schema-pack/lint-rules.ts';
import type { SchemaPackManifest } from '../src/core/schema-pack/manifest-v1.ts';

describe('#1569 input-length cap', () => {
  test('runRegexBounded throws RegexInputTooLargeError over the cap', () => {
    const big = 'a'.repeat(MAX_REGEX_INPUT_CHARS + 1);
    expect(() => runRegexBounded('a', big)).toThrow(RegexInputTooLargeError);
  });

  test('runRegexBounded works normally under the cap', () => {
    const m = runRegexBounded('wor', 'hello world');
    expect(m).not.toBeNull();
    expect(runRegexBounded('zzz', 'hello world')).toBeNull();
  });

  test('PageRegexBudget.runBounded degrades (null) on oversize input', () => {
    const budget = new PageRegexBudget();
    const big = 'a'.repeat(MAX_REGEX_INPUT_CHARS + 1);
    expect(budget.runBounded('verb', 'a', big)).toBeNull();
  });

  test('inferLinkTypeFromPack (no budget) does NOT run regex unbounded on huge input', () => {
    // Pre-#1569 this ran new RegExp().test() with no length cap → ReDoS risk.
    // A catastrophic pattern + a long input must NOT hang; the cap skips it.
    const pack = {
      link_types: [{ name: 'founded', inference: { regex: '(a+)+$' } }],
    } as unknown as Pick<SchemaPackManifest, 'link_types'>;
    const huge = 'a'.repeat(MAX_REGEX_INPUT_CHARS + 100) + '!';
    const t0 = Date.now();
    const result = inferLinkTypeFromPack(pack, 'company', huge);
    // Skipped via the cap → no match, and fast (no catastrophic backtrack).
    expect(result).toBeNull();
    expect(Date.now() - t0).toBeLessThan(2_000);
  });
});

describe('#1569 star-height lint rule', () => {
  const mk = (regex: string): SchemaPackManifest =>
    ({ name: 'testpack', page_types: [], link_types: [{ name: 'founded', inference: { regex } }] }) as unknown as SchemaPackManifest;

  test('flags classic nested-quantifier shapes as warnings', () => {
    for (const bad of ['(a+)+', '(a*)*', '(a+)*', '(\\w+)+$', '(.*)+']) {
      const issues = linkRegexCatastrophicBacktrack(mk(bad)) as ReturnType<typeof linkRegexCatastrophicBacktrack> & any[];
      expect(issues.length).toBe(1);
      expect(issues[0].severity).toBe('warning');
      expect(issues[0].rule).toBe('link_regex_catastrophic_backtrack');
      expect(issues[0].link).toBe('founded');
    }
  });

  test('does NOT flag benign patterns', () => {
    for (const ok of ['a+', '(abc)+', '(a|b)+', 'founded\\s+\\w+', '[a-z]+@[a-z]+']) {
      const issues = linkRegexCatastrophicBacktrack(mk(ok)) as any[];
      expect(issues.length).toBe(0);
    }
  });

  test('no regex → no issue', () => {
    const manifest = { name: 'p', page_types: [], link_types: [{ name: 'x' }] } as unknown as SchemaPackManifest;
    expect((linkRegexCatastrophicBacktrack(manifest) as any[]).length).toBe(0);
  });
});

describe('#1569 --no-schema-pack + heartbeat wiring (structural)', () => {
  const SYNC = readFileSync(join(import.meta.dir, '..', 'src', 'commands', 'sync.ts'), 'utf-8');

  test('SyncOpts carries noSchemaPack and it gates loadActivePack', () => {
    expect(SYNC).toContain('noSchemaPack?: boolean');
    expect(SYNC).toContain("args.includes('--no-schema-pack')");
    expect(SYNC).toContain('if (opts.noSchemaPack)');
  });

  test('begin heartbeat fires before importFile (GBRAIN_SYNC_TRACE)', () => {
    const beginIdx = SYNC.indexOf('begin import:');
    const importIdx = SYNC.indexOf('importFile(eng, filePath, path');
    expect(beginIdx).toBeGreaterThan(0);
    expect(importIdx).toBeGreaterThan(0);
    expect(beginIdx).toBeLessThan(importIdx);
  });
});
