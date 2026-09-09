/**
 * `resolveIncludeFrontmatter` is the single answer every extraction path uses
 * for "should `related:` frontmatter become link edges".
 *
 * The regression this pins: v0.42 added
 * `autopilot.incremental_extract_include_frontmatter`, but only the autopilot
 * cycle's extract phase ever read it. performSync's inline extract, the
 * `extract_stale` minion and `gbrain maintain` all hardcoded `false` with no
 * way to opt in — so any unattended sync (cron, webhook, git hook) imported
 * pages and silently left their frontmatter relationships unextracted. For a
 * schema pack that keeps relationships in frontmatter rather than body
 * wikilinks, the graph then reports nothing depends on anything.
 *
 * Serial because it mutates GBRAIN_HOME to get a hermetic config file.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { KNOWN_CONFIG_KEYS } from '../src/core/config.ts';
import { resolveIncludeFrontmatter } from '../src/core/extract-frontmatter.ts';

const ENV_KEYS = ['GBRAIN_HOME'] as const;
const envSnapshot: Record<string, string | undefined> = {};
let home: string;

/** Minimal engine stub: only getConfig is consulted. */
function engineWith(values: Record<string, string | null>) {
  const seen: string[] = [];
  return {
    seen,
    getConfig: async (key: string): Promise<string | null> => {
      seen.push(key);
      return key in values ? values[key] : null;
    },
  };
}

function writeConfigFile(cfg: Record<string, unknown>) {
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify(cfg, null, 2) + '\n');
}

beforeEach(() => {
  for (const k of ENV_KEYS) envSnapshot[k] = process.env[k];
  home = mkdtempSync(join(tmpdir(), 'gbrain-extract-fm-'));
  process.env.GBRAIN_HOME = home;
  mkdirSync(join(home, '.gbrain'), { recursive: true });
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (envSnapshot[k] === undefined) delete process.env[k];
    else process.env[k] = envSnapshot[k];
  }
  try { rmSync(home, { recursive: true, force: true }); } catch {}
});

describe('resolveIncludeFrontmatter', () => {
  test('defaults to false with no config and no engine', async () => {
    expect(await resolveIncludeFrontmatter(null)).toBe(false);
    expect(await resolveIncludeFrontmatter(undefined)).toBe(false);
  });

  test('defaults to false when the engine has neither key set', async () => {
    expect(await resolveIncludeFrontmatter(engineWith({}))).toBe(false);
  });

  test('an explicit value wins over every config plane', async () => {
    writeConfigFile({ extract: { include_frontmatter: false } });
    expect(await resolveIncludeFrontmatter(engineWith({ 'extract.include_frontmatter': 'false' }), true)).toBe(true);

    writeConfigFile({ extract: { include_frontmatter: true } });
    expect(await resolveIncludeFrontmatter(engineWith({ 'extract.include_frontmatter': 'true' }), false)).toBe(false);
  });

  test('honours the general key on the file plane', async () => {
    writeConfigFile({ extract: { include_frontmatter: true } });
    expect(await resolveIncludeFrontmatter(null)).toBe(true);
  });

  test('honours the general key on the DB plane', async () => {
    expect(await resolveIncludeFrontmatter(engineWith({ 'extract.include_frontmatter': 'true' }))).toBe(true);
  });

  test('still honours the legacy autopilot key on both planes', async () => {
    writeConfigFile({ autopilot: { incremental_extract_include_frontmatter: true } });
    expect(await resolveIncludeFrontmatter(null)).toBe(true);

    writeConfigFile({});
    const eng = engineWith({ 'autopilot.incremental_extract_include_frontmatter': 'true' });
    expect(await resolveIncludeFrontmatter(eng)).toBe(true);
    // the general key is consulted first
    expect(eng.seen[0]).toBe('extract.include_frontmatter');
  });

  test('the general key takes precedence over the legacy key', async () => {
    writeConfigFile({
      extract: { include_frontmatter: false },
      autopilot: { incremental_extract_include_frontmatter: true },
    });
    expect(await resolveIncludeFrontmatter(null)).toBe(false);

    writeConfigFile({});
    expect(await resolveIncludeFrontmatter(engineWith({
      'extract.include_frontmatter': 'false',
      'autopilot.incremental_extract_include_frontmatter': 'true',
    }))).toBe(false);
  });

  test('the file plane wins over the DB plane', async () => {
    writeConfigFile({ extract: { include_frontmatter: true } });
    const eng = engineWith({ 'extract.include_frontmatter': 'false' });
    expect(await resolveIncludeFrontmatter(eng)).toBe(true);
    expect(eng.seen).toHaveLength(0); // engine never consulted
  });

  test('accepts every canonical truthy spelling, unlike the old === true compare', async () => {
    for (const raw of ['true', 'TRUE', ' 1 ', 'yes', 'on']) {
      expect(await resolveIncludeFrontmatter(engineWith({ 'extract.include_frontmatter': raw }))).toBe(true);
    }
    for (const raw of ['false', '0', 'no', 'off', '', 'maybe']) {
      expect(await resolveIncludeFrontmatter(engineWith({ 'extract.include_frontmatter': raw }))).toBe(false);
    }
  });

  test('fails closed when the config table is unreadable', async () => {
    const throwing = { getConfig: async (): Promise<string | null> => { throw new Error('no config table'); } };
    expect(await resolveIncludeFrontmatter(throwing)).toBe(false);
  });

  test('the general key is registered, so config set does not reject it', () => {
    expect(KNOWN_CONFIG_KEYS).toContain('extract.include_frontmatter');
  });
});

/**
 * Source-text guard (the doctor-source pattern): the whole point of the change
 * is that no extraction path decides this for itself. A future edit that
 * reintroduces a hardcoded `false` would silently restore the bug in a way the
 * resolver's own unit tests cannot see.
 */
describe('no extraction path hardcodes includeFrontmatter', () => {
  const CALL_SITES = [
    'src/commands/sync.ts',
    'src/commands/jobs.ts',
    'src/commands/maintain.ts',
    'src/core/cycle.ts',
  ] as const;

  test('every call site resolves the flag instead of literalising it', async () => {
    // test-reads-source-ok: the bug is a literal in four call sites; only a source-text pin can see it come back, and the resolver's own unit tests cannot.
    const { readFileSync } = await import('node:fs');
    for (const rel of CALL_SITES) {
      const src = readFileSync(new URL(`../${rel}`, import.meta.url), 'utf-8');
      expect(src).toContain('resolveIncludeFrontmatter');
      // A literal `includeFrontmatter: false` is the exact shape of the bug.
      expect(src).not.toMatch(/includeFrontmatter:\s*false/);
    }
  });

  test('the sync inline extract passes the resolved flag through', async () => {
    // test-reads-source-ok: extractLinksForSlugs' signature is the seam that makes sync's resolution effective; a behavioural test would need a full sync fixture.
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/commands/extract.ts', import.meta.url), 'utf-8');
    // extractLinksForSlugs must accept and forward the option, or sync's
    // resolution is inert.
    expect(src).toMatch(/extractLinksForSlugs\([\s\S]{0,220}includeFrontmatter\?: boolean/);
    expect(src).toMatch(/extractLinksFromFile\(content, slug \+ '\.md', allSlugs, \{[^}]*includeFrontmatter/);
  });
});
