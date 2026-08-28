/**
 * #2589 — cross-source wikilink edges, END-TO-END through the DB extract
 * paths (the sibling test/extract-cross-source-links.test.ts covers only the
 * pure resolveCandidateSources helper + the config ladder). Pinned here:
 *
 *  - `extract links --source db`, flag OFF (default): a wikilink whose
 *    target exists only in another source writes NO edge, and the drop is
 *    OBSERVABLE (skipped-cross-source summary line) — never silent.
 *  - Flag ON via the env escape hatch: the edge IS written and to_page_id
 *    lands on the other source's page (the real (source_id, slug) join).
 *  - Flag ON, target in multiple foreign sources: the persisted edge points
 *    at the lexicographically smallest source (deterministic end-to-end).
 *  - `extract --stale --json`, flag OFF: the extract_stale_done event
 *    carries `skipped_cross_source` (the new JSON field).
 *  - extractStaleFromDB, flag ON via DB config: edge written, and the
 *    return shape's `skippedCrossSource` is 0.
 *  - `link_resolution.cross_source` is registered in KNOWN_CONFIG_KEYS
 *    (so `gbrain config set` accepts it without --force).
 *
 * Hermetic PGLite — no DATABASE_URL, no API keys. Harness conventions from
 * test/extract-source-aware.test.ts. Serial file: mutates process.env.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runExtract, extractStaleFromDB } from '../src/commands/extract.ts';
import { KNOWN_CONFIG_KEYS } from '../src/core/config.ts';

let engine: PGLiteEngine;

const ENV_KEY = 'GBRAIN_LINK_RESOLUTION_CROSS_SOURCE';
const savedEnv = process.env[ENV_KEY];

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
  if (engine) await engine.disconnect();
}, 60_000);

async function truncateAll(): Promise<void> {
  for (const t of ['content_chunks', 'links', 'timeline_entries', 'tags', 'raw_data', 'page_versions', 'ingest_log', 'pages']) {
    await (engine as any).db.exec(`DELETE FROM ${t}`);
  }
  await (engine as any).db.exec(`DELETE FROM sources WHERE id <> 'default'`);
  await (engine as any).db.exec(`DELETE FROM config WHERE key = 'link_resolution.cross_source'`);
}

beforeEach(async () => {
  await truncateAll();
  delete process.env[ENV_KEY];
}, 60_000); // PGLite full-migration-chain init needs breathing room (house pattern, see extract-db.test.ts)
afterEach(() => {
  delete process.env[ENV_KEY];
});

/** Seed the literal #2589 shape: a comms page wikilinks a person page that
 *  lives ONLY in vault source(s) — never 'comms', never 'default'. */
async function seedCrossSource(targetSources: string[] = ['vault-a']): Promise<void> {
  const ids = ['comms', ...targetSources];
  await engine.executeRaw(
    `INSERT INTO sources (id, name) SELECT unnest($1::text[]), unnest($1::text[])
     ON CONFLICT (id) DO NOTHING`, [ids],
  );
  for (const src of targetSources) {
    await engine.executeRaw(
      `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline)
       VALUES ('people/alice-example', $1, 'person', 'Alice', 'A person page.', '')`, [src],
    );
  }
  await engine.executeRaw(
    `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline)
     VALUES ('comms/msg-1', 'comms', 'note', 'Msg 1', 'Talked to [[people/alice-example]] today.', '')`,
  );
}

/** All persisted edges with BOTH endpoints' source ids resolved. */
async function edgeEndpoints(): Promise<Array<{ from_slug: string; from_sid: string; to_slug: string; to_sid: string }>> {
  return engine.executeRaw<{ from_slug: string; from_sid: string; to_slug: string; to_sid: string }>(
    `SELECT pf.slug AS from_slug, pf.source_id AS from_sid,
            pt.slug AS to_slug, pt.source_id AS to_sid
       FROM links l
       JOIN pages pf ON l.from_page_id = pf.id
       JOIN pages pt ON l.to_page_id = pt.id
      ORDER BY pf.slug, pt.slug`,
  );
}

function captureConsole(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  return { lines, restore: () => { console.log = orig; } };
}

function captureStdout(): { chunks: string[]; restore: () => void } {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
    return true;
  }) as any;
  return { chunks, restore: () => { process.stdout.write = orig; } };
}

describe('#2589 extract links --source db — cross-source edges end-to-end', () => {
  test('flag OFF (default): no edge written, drop surfaced in the summary (not silent)', async () => {
    await seedCrossSource(['vault-a']);
    const cap = captureConsole();
    try {
      await runExtract(engine, ['links', '--source', 'db']);
    } finally {
      cap.restore();
    }
    expect(await edgeEndpoints()).toEqual([]);
    // The observable-drop contract: the human summary names the skip count.
    const summary = cap.lines.join('\n');
    expect(summary).toContain('Skipped 1 cross-source candidate');
    expect(summary).toContain('link_resolution.cross_source');
  });

  test('flag ON (env): edge written with to_page_id in the OTHER source', async () => {
    await seedCrossSource(['vault-a']);
    process.env[ENV_KEY] = '1';
    const cap = captureConsole();
    try {
      await runExtract(engine, ['links', '--source', 'db']);
    } finally {
      cap.restore();
    }
    expect(await edgeEndpoints()).toEqual([
      { from_slug: 'comms/msg-1', from_sid: 'comms', to_slug: 'people/alice-example', to_sid: 'vault-a' },
    ]);
    // No skip line when nothing was skipped.
    expect(cap.lines.join('\n')).not.toContain('cross-source candidate');
  });

  test('flag ON, target in vault-b AND vault-a: persisted edge is deterministic (lexicographic min)', async () => {
    // vault-b listed first so enumeration order can't accidentally pass.
    await seedCrossSource(['vault-b', 'vault-a']);
    process.env[ENV_KEY] = '1';
    const cap = captureConsole();
    try {
      await runExtract(engine, ['links', '--source', 'db']);
    } finally {
      cap.restore();
    }
    const edges = await edgeEndpoints();
    expect(edges.length).toBe(1);
    expect(edges[0].to_sid).toBe('vault-a');
  });
});

describe('#2589 extract --stale — skipped_cross_source observability + config plane', () => {
  test('flag OFF: extract_stale_done JSON event carries skipped_cross_source, no edge written', async () => {
    await seedCrossSource(['vault-a']);
    const out = captureStdout();
    try {
      await runExtract(engine, ['--stale', '--json']);
    } finally {
      out.restore();
    }
    const events = out.chunks.join('').split('\n').filter(l => l.trim().startsWith('{')).map(l => JSON.parse(l));
    const done = events.find(e => e.action === 'extract_stale_done');
    expect(done).toBeDefined();
    expect(done.skipped_cross_source).toBe(1);
    expect(done.links_created).toBe(0);
    expect(await edgeEndpoints()).toEqual([]);
  });

  test('flag ON via DB config: extractStaleFromDB writes the edge; return shape counts 0 skips', async () => {
    await seedCrossSource(['vault-a']);
    await engine.setConfig('link_resolution.cross_source', 'true');
    const cap = captureConsole();
    let r: Awaited<ReturnType<typeof extractStaleFromDB>>;
    try {
      r = await extractStaleFromDB(engine, {
        dryRun: false, jsonMode: false, includeFrontmatter: false, catchUp: false,
      });
    } finally {
      cap.restore();
    }
    expect(r.skippedCrossSource).toBe(0);
    expect(r.linksCreated).toBeGreaterThanOrEqual(1);
    expect(await edgeEndpoints()).toEqual([
      { from_slug: 'comms/msg-1', from_sid: 'comms', to_slug: 'people/alice-example', to_sid: 'vault-a' },
    ]);
  });

  test('link_resolution.cross_source is a KNOWN config key (config set accepts it)', () => {
    expect(KNOWN_CONFIG_KEYS).toContain('link_resolution.cross_source');
  });
});
