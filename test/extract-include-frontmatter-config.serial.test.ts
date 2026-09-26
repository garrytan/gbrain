/**
 * `resolveIncludeFrontmatter` is the single answer every extraction path uses
 * for "should `related:` frontmatter become link edges" (#4997 / #4999).
 *
 * The regression this pins: v0.42 added
 * `autopilot.incremental_extract_include_frontmatter`, but only the autopilot
 * cycle read it. performSync's inline extract, the GitHub/Google source inline
 * extracts, the `extract_stale` minion and `gbrain maintain` extracted body
 * links only AND then stamped `links_extracted_at`, so with the knob on a page
 * came out of an unattended sync marked fresh without its frontmatter edges,
 * and the cycle's stale drain never revisited it.
 *
 * Serial: points GBRAIN_HOME (via withEnv) at a hermetic config dir so the
 * machine's real file-plane config cannot leak into the file/DB precedence
 * assertions.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { withEnv } from './helpers/with-env.ts';
import { resolveIncludeFrontmatter, INCLUDE_FRONTMATTER_KEY } from '../src/core/extract-frontmatter.ts';

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

const inHome = <T>(fn: () => Promise<T>) => withEnv({ GBRAIN_HOME: home }, fn);

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-extract-fm-'));
  mkdirSync(join(home, '.gbrain'), { recursive: true });
});

afterEach(() => {
  try { rmSync(home, { recursive: true, force: true }); } catch {}
});

describe('resolveIncludeFrontmatter', () => {
  test('defaults to false with no config, no engine, or an engine without the key', () => inHome(async () => {
    expect(await resolveIncludeFrontmatter(null)).toBe(false);
    expect(await resolveIncludeFrontmatter(undefined)).toBe(false);
    expect(await resolveIncludeFrontmatter(engineWith({}))).toBe(false);
  }));

  test('an explicit value wins over every config plane, in both directions', () => inHome(async () => {
    writeConfigFile({ autopilot: { incremental_extract_include_frontmatter: false } });
    expect(await resolveIncludeFrontmatter(engineWith({ [INCLUDE_FRONTMATTER_KEY]: 'false' }), true)).toBe(true);

    writeConfigFile({ autopilot: { incremental_extract_include_frontmatter: true } });
    expect(await resolveIncludeFrontmatter(engineWith({ [INCLUDE_FRONTMATTER_KEY]: 'true' }), false)).toBe(false);
  }));

  test('the file plane is honoured and wins over the DB plane (engine never consulted)', () => inHome(async () => {
    writeConfigFile({ autopilot: { incremental_extract_include_frontmatter: true } });
    expect(await resolveIncludeFrontmatter(null)).toBe(true);

    const eng = engineWith({ [INCLUDE_FRONTMATTER_KEY]: 'false' });
    expect(await resolveIncludeFrontmatter(eng)).toBe(true);
    expect(eng.seen).toHaveLength(0);
  }));

  test('the DB plane accepts every canonical truthy spelling, unlike the old === "true" compare', () => inHome(async () => {
    for (const raw of ['true', 'TRUE', ' 1 ', 'yes', 'on']) {
      expect(await resolveIncludeFrontmatter(engineWith({ [INCLUDE_FRONTMATTER_KEY]: raw }))).toBe(true);
    }
    for (const raw of ['false', '0', 'no', 'off', '', 'maybe']) {
      expect(await resolveIncludeFrontmatter(engineWith({ [INCLUDE_FRONTMATTER_KEY]: raw }))).toBe(false);
    }
  }));

  test('a non-boolean file-plane value falls through to the DB plane instead of winning as false (#2120 class)', () => inHome(async () => {
    // A hand-edited config.json with "true" (string) or 1 used to short-circuit
    // to false AND shadow the DB plane — so `gbrain config set <key> true` was
    // a silent no-op. Only a real boolean is a file-plane answer.
    for (const garbled of ['true', 1, 'yes']) {
      writeConfigFile({ autopilot: { incremental_extract_include_frontmatter: garbled } });
      expect(await resolveIncludeFrontmatter(engineWith({ [INCLUDE_FRONTMATTER_KEY]: 'true' }))).toBe(true);
      expect(await resolveIncludeFrontmatter(engineWith({}))).toBe(false);
    }
  }));

  test('fails closed when the config table is unreadable', () => inHome(async () => {
    const throwing = { getConfig: async (): Promise<string | null> => { throw new Error('no config table'); } };
    expect(await resolveIncludeFrontmatter(throwing)).toBe(false);
  }));
});

/**
 * Source-text guard (the doctor-source pattern): no extraction path decides
 * this for itself. A literal `includeFrontmatter: false` at a call site is the
 * exact shape of the bug, and the resolver's own unit tests cannot see it
 * come back. The shared helpers (`extractLinksForSlugs`, `extractStaleFromDB`)
 * must resolve the default themselves so every caller — including the
 * GitHub/Google source inline extracts that pass `{ sourceId }` only — is
 * covered without per-caller threading.
 */
describe('no extraction path hardcodes includeFrontmatter', () => {
  test('call sites do not literalise false; the shared helpers resolve the default', () => {
    // test-reads-source-ok: the bug is a literal at the call sites; only a source-text pin can see it come back.
    const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf-8');
    for (const rel of ['src/commands/jobs.ts', 'src/commands/maintain.ts', 'src/core/cycle.ts']) {
      expect(read(rel)).not.toMatch(/includeFrontmatter:\s*false/);
    }
    expect(read('src/core/cycle.ts')).toContain('resolveIncludeFrontmatter');
    expect(read('src/commands/extract.ts')).toMatch(/resolveIncludeFrontmatter\(engine/);
  });
});

/**
 * Behavioural pin on the shared seam: the sync inline hook, called exactly the
 * way sync / GitHub-source / Google-source call it (no includeFrontmatter
 * option), builds a `related:` frontmatter edge once the knob is on.
 */
describe('extractLinksForSlugs honours the knob with no per-call option', () => {
  test('a related: frontmatter edge appears only once the DB-plane key is set', () => inHome(async () => {
    const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');
    const { extractLinksForSlugs } = await import('../src/commands/extract.ts');
    const engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-extract-fm-repo-'));
    try {
      mkdirSync(join(dir, 'people'), { recursive: true });
      mkdirSync(join(dir, 'companies'), { recursive: true });
      // No body link — the ONLY edge is in frontmatter.
      writeFileSync(join(dir, 'people/alice.md'), [
        '---', 'type: person', 'title: Alice', 'related:', '  - companies/acme', '---', '', 'Alice is a founder.',
      ].join('\n'));
      writeFileSync(join(dir, 'companies/acme.md'), [
        '---', 'type: company', 'title: Acme', '---', '', 'Acme is a company.',
      ].join('\n'));
      const page = (type: 'person' | 'company', title: string) =>
        ({ type, title, compiled_truth: title, timeline: '', frontmatter: {}, content_hash: 'h' });
      await engine.putPage('people/alice', page('person', 'Alice'));
      await engine.putPage('companies/acme', page('company', 'Acme'));

      // Control: knob off → body-only extraction, no frontmatter edge.
      await extractLinksForSlugs(engine, dir, ['people/alice']);
      expect((await engine.getLinks('people/alice')).some(l => l.to_slug === 'companies/acme')).toBe(false);

      await engine.setConfig(INCLUDE_FRONTMATTER_KEY, 'true');
      const result = await extractLinksForSlugs(engine, dir, ['people/alice']);
      expect(result.processed).toEqual(['people/alice']);
      expect((await engine.getLinks('people/alice')).some(l => l.to_slug === 'companies/acme')).toBe(true);
    } finally {
      await engine.disconnect();
      rmSync(dir, { recursive: true, force: true });
    }
  }), 60_000);
});
