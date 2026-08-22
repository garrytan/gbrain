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
  RegexCatastrophicPatternError,
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

describe('megawave vm-watchdog removal (bootstrap-verify freeze)', () => {
  // Bun's `vm.runInContext(..., { timeout })` watchdog wedges the event loop
  // in processes that also host PGLite WASM: after some dozens of watchdog
  // runs, all JS timers stop firing and the next in-flight PGLite query
  // promise never resolves (repro: the bootstrap-verify corpus test hanging
  // at 240s once #3190 wired pack regex inference into put_page). The guard
  // must never route through node:vm again; bounding is structural (input
  // cap + catastrophic-shape refusal + per-page budget).
  test('redos-guard does not import node:vm (freeze regression pin)', () => {
    // Import absence is the load-bearing check: without the import, no code
    // path can reach runInContext. (The header comment intentionally KEEPS
    // the historical vm references as the record of why it was removed.)
    const src = readFileSync(join(import.meta.dir, '..', 'src', 'core', 'schema-pack', 'redos-guard.ts'), 'utf-8');
    expect(src).not.toMatch(/from ['"]node:vm['"]/);
    expect(src).not.toMatch(/require\(['"]node:vm['"]\)/);
    expect(src).not.toMatch(/from ['"]vm['"]/);
  });

  test('runRegexBounded refuses nested-quantifier patterns before executing', () => {
    expect(() => runRegexBounded('(a+)+$', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!')).toThrow(RegexCatastrophicPatternError);
  });

  test('PageRegexBudget.runBounded degrades (null) on catastrophic pattern, counts budget', () => {
    const budget = new PageRegexBudget();
    expect(budget.runBounded('verb', '(\\w+)+$', 'some ordinary context sentence')).toBeNull();
    expect(budget.getCumulativeMs()).toBeGreaterThan(0);
  });

  test('benign first-party-shaped patterns still match (plain exec path)', () => {
    const m = runRegexBounded('\\b(founded|founder of|co-?founded|started)\\b', 'alice founded acme');
    expect(m).not.toBeNull();
  });

  test('inferLinkTypeFromPack degrades a catastrophic pack regex to null (no hang)', () => {
    const pack = {
      link_types: [{ name: 'evil', inference: { regex: '(a+)+$' } }],
    } as unknown as Pick<SchemaPackManifest, 'link_types'>;
    const t0 = Date.now();
    expect(inferLinkTypeFromPack(pack, 'company', 'a'.repeat(64) + '!')).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1_000);
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
