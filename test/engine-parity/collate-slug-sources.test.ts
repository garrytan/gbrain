/**
 * BrainEngine parity — the reads that find one slug in several sources list (or pick from) those sources in byte
 * order on every engine and locale.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: for a slug held in several sources, these return the sources in byte order of source id on every engine
 *    arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1), as PGLite and the Rust
 *    store sort: `gbrain access who-can-read` (whoCanRead), the trust page-ref ambiguity error (resolvePageRef), `gbrain
 *    quarantine clear`'s "exists in N sources" error, `extract-conversation-facts --grammar`'s ambiguity error, the
 *    guest-promotion ambiguity error (promoteGuestNote), the scoped get_links miss hint, explain-target's probe rows
 *    (probeTarget), the relational chain anchors (resolveChainAnchors), and readPageSnapshot's pick when the preferred
 *    source does not hold the slug (the lowest source id).
 *  - Regression: an en_US Postgres sorted source ids by its locale, which skips `-` (`a0, ab, a-z` instead of `a-z, a0,
 *    ab`), so these errors, hints and picks named another order or another source than on PGLite and Rust brains.
 *  - Why existing coverage misses it: the tests for these paths hold a slug in one or two sources whose ids sort the
 *    same in every locale, and CI's Postgres runs in C.UTF-8. Every case here uses ids that differ by byte and by
 *    en_US; run it against an en_US Postgres to see it fail.
 *  - Seam: the CLI cases stub process.exit and capture console.error; the link-hint case captures the logger. Source
 *    rows come from the createSource fixture and guest-source rows from the typed upsertGuestSource, written after
 *    the pages.
 */
import { describe, expect, spyOn } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { operations } from '../../src/core/operations.ts';
import { whoCanRead } from '../../src/commands/access.ts';
import { runQuarantine } from '../../src/commands/quarantine.ts';
import { runExtractConversationFacts } from '../../src/commands/extract-conversation-facts.ts';
import { resolvePageRef } from '../../src/core/trust/refs.ts';
import { promoteGuestNote } from '../../src/core/guests/promote.ts';
import { GUEST_TRUST_CEILING } from '../../src/core/guests/sources.ts';
import { OperationError } from '../../src/core/ops/contract.ts';
import { probeTarget } from '../../src/core/search/explain-target.ts';
import { resolveChainAnchors } from '../../src/core/search/relational-chain.ts';
import { createSource, parityArms } from './harness.ts';
import { isCapabilityRefusal } from './arm-capabilities.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { byteOrder } from '../helpers/byte-order.ts';

const { parityTest } = parityArms(testBackends());

/** Source ids (lower case, digits and `-` only): en_US sorts them `a0, ab, a-z`; bytes put `a-z` first. */
const MIXED_SOURCES = ['ab', 'a0', 'a-z'];
const BYTE_SOURCES = byteOrder(MIXED_SOURCES);
const SLUG = 'notes/shared';

function ctxFor(engine: BrainEngine, over: Partial<OperationContext> = {}): OperationContext {
  return { engine, config: { engine: engine.kind }, remote: false, dryRun: false, sourceId: 'default',
    logger: { info() {}, warn() {}, error() {} }, ...over } as unknown as OperationContext;
}

async function seed(engine: BrainEngine, backend: Parameters<typeof createSource>[1], slug = SLUG, body = `${slug} body`) {
  for (const id of MIXED_SOURCES) {
    await createSource(engine, backend, id);
    await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: body, timeline: '' }, { sourceId: id });
  }
}

/** The error `run` throws; a raw_sql capability refusal (the Rust arm) propagates so the harness counts it. */
const errorOf = async (run: () => Promise<unknown>) => {
  try { await run(); } catch (e) { if (isCapabilityRefusal(e, 'raw_sql')) throw e; return e as Error; }
  throw new Error('expected a refusal');
};

/** Runs a CLI command with process.exit stubbed (it throws) and console.error captured. */
async function cli(run: () => Promise<void>): Promise<string> {
  const err: string[] = [];
  const exit = spyOn(process, 'exit').mockImplementation(((n: number) => { throw new Error(`__exit_${n}__`); }) as never);
  const error = spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(a.join(' ')); });
  try {
    await run().catch((e: Error) => { if (isCapabilityRefusal(e, 'raw_sql')) throw e; err.push(e.message); });
  } finally {
    exit.mockRestore();
    error.mockRestore();
  }
  return err.join('\n');
}

/** The source ids in `text`, in the order they appear. */
const named = (text: string) => MIXED_SOURCES.filter(id => text.includes(id)).sort((a, b) => text.indexOf(`${a}`) - text.indexOf(`${b}`));

describe('a slug held in several sources lists those sources by byte', () => {
  parityTest('whoCanRead lists the sources by byte', { methods: ['putPage', 'readWhoCanReadRows'] }, async (engine, backend) => {
    await seed(engine, backend);
    const sources = (await whoCanRead(engine, SLUG)).map(e => e.source_id);
    expect(sources).toEqual(BYTE_SOURCES);
    return sources;
  });

  parityTest('resolvePageRef names the sources by byte, and suggests the first', { methods: ['putPage', 'listLiveSlugSourceIds'] }, async (engine, backend) => {
    await seed(engine, backend);
    const e = await errorOf(() => resolvePageRef(engine, { kind: 'page', sourceId: null, slug: SLUG } as never)) as OperationError;
    expect(e.message).toContain(`exists in 3 sources: ${BYTE_SOURCES.join(', ')}.`);
    expect(e.suggestion).toContain(`--source ${BYTE_SOURCES[0]} `);
    return { message: e.message, suggestion: e.suggestion };
  });

  parityTest('quarantine clear names the sources by byte', { methods: ['putPage', 'listLiveSlugSourceIds'] }, async (engine, backend) => {
    await seed(engine, backend);
    const err = await cli(() => runQuarantine(engine, ['clear', SLUG]));
    expect(err).toContain(`exists in 3 sources: ${BYTE_SOURCES.join(', ')}.`);
    return err;
  });

  parityTest('extract-conversation-facts --grammar names the sources by byte', { methods: ['putPage', 'listLiveSlugSourceIds'] }, async (engine, backend) => {
    await seed(engine, backend);
    const err = await cli(() => runExtractConversationFacts(engine, ['--slug', SLUG, '--grammar', 'none', '--dry-run']));
    expect(err).toContain(`is in 3 sources (${BYTE_SOURCES.join(', ')})`);
    return named(err);
  });

  parityTest('promoteGuestNote names the guest sources by byte', { methods: ['putPage', 'upsertGuestSource', 'listGuestNotes'] }, async (engine, backend) => {
    await seed(engine, backend);
    // The pages come first: a guest source takes no write from an owner path, and the row is all the note read needs.
    for (const id of MIXED_SOURCES) await engine.upsertGuestSource(id, [], GUEST_TRUST_CEILING);
    const e = await errorOf(() => promoteGuestNote(ctxFor(engine), { slug: SLUG }));
    expect(e.message).toContain(`exists in several guest sources (${BYTE_SOURCES.join(', ')})`);
    return e.message;
  });

  parityTest('the scoped get_links miss hint names the other sources by byte', { methods: ['putPage', 'addLink', 'getLinks', 'listAllSources'] }, async (engine, backend) => {
    await seed(engine, backend);
    for (const id of MIXED_SOURCES) {
      await engine.putPage('notes/target', { type: 'note', title: 't', compiled_truth: 't', timeline: '' }, { sourceId: id });
      await engine.addLink(SLUG, 'notes/target', 'ctx', 'mentions', undefined, undefined, undefined, { fromSourceId: id, toSourceId: id });
    }
    const warned: string[] = [];
    const ctx = ctxFor(engine, { logger: { info() {}, warn: (m: string) => { warned.push(m); }, error() {} } as never });
    const op = operations.find(o => o.name === 'get_links')!;
    await op.handler(ctx, { slug: SLUG });
    const hint = warned.join('\n');
    expect(hint).toContain(`found ${BYTE_SOURCES.map(id => `1 in source ${id}`).join(', ')}.`);
    return hint;
  });

  parityTest('probeTarget and resolveChainAnchors list the sources by byte', { methods: ['putPage', 'probeTargetRows', 'resolveChainAnchorRows'] }, async (engine, backend) => {
    await seed(engine, backend);
    const probe = (await probeTarget(engine, SLUG, {})).map(r => r.source_id);
    const anchors = (await resolveChainAnchors(engine, SLUG, {})).map(a => a.source_id);
    expect({ probe, anchors }).toEqual({ probe: BYTE_SOURCES, anchors: BYTE_SOURCES });
    return { probe, anchors };
  });

  parityTest('readPageSnapshot picks the lowest source id by byte when the preferred source lacks the slug', { methods: ['putPage', 'readPageSnapshot'] }, async (engine, backend) => {
    await seed(engine, backend);
    await createSource(engine, backend, 'zz');
    const picked = (await engine.readPageSnapshot(SLUG, { sourceIds: ['zz', ...MIXED_SOURCES] }))?.page.source_id;
    expect(picked).toBe(BYTE_SOURCES[0]);
    return picked;
  });
});
