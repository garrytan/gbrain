/**
 * Per-source outcomes on extract receipts + the zero-atom receipt gap.
 *
 * Motivation: an ingest-coverage audit ("is every staged transcript
 * drained?") needs receipts to answer two questions per source:
 *   1. Was it ATTEMPTED this round?
 *   2. What did it yield (rows, 0 rows, or an error)?
 * Pre-fix, receipts carried only aggregate counts ("N atoms from M
 * transcripts") AND a round whose every source yielded 0 atoms wrote no
 * receipt at all — "processed, legitimately atom-less" was
 * indistinguishable from "never reached" without joining atom
 * frontmatter back to staged content by hand.
 *
 * Pins:
 *  - writeReceipt renders per-source rows in body + frontmatter, with the
 *    MAX_RECEIPT_SOURCES cap and a true sources_total.
 *  - runPhaseExtractAtoms writes a receipt on an all-zero-yield round
 *    (the gap), with rows:0 outcomes for each attempted source.
 *  - failures carry an error note; mixed rounds record per-source rows.
 *  - extractors that omit `sources` produce byte-identical receipts to
 *    before (additive change).
 */

import { describe, it, expect } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import {
  writeReceipt,
  MAX_RECEIPT_SOURCES,
  type ExtractReceiptInput,
} from '../src/core/extract/receipt-writer.ts';
import { runPhaseExtractAtoms } from '../src/core/cycle/extract-atoms.ts';

type PutPageCall = { slug: string; page: Record<string, unknown> };

function fakeEngine(): { engine: BrainEngine; puts: PutPageCall[] } {
  const puts: PutPageCall[] = [];
  const engine = {
    executeRaw: async () => [],
    putPage: async (slug: string, page: Record<string, unknown>) => {
      puts.push({ slug, page });
      return { slug, ...page };
    },
  } as unknown as BrainEngine;
  return { engine, puts };
}

function baseInput(overrides: Partial<ExtractReceiptInput> = {}): ExtractReceiptInput {
  return {
    kind: 'atoms',
    source_id: 'default',
    run_id: 'atoms-testrun-defa',
    round: 'single',
    extracted_at: '2026-01-02T03:04:05.000Z',
    total_rows: 3,
    cost_usd: 0.01,
    ...overrides,
  };
}

describe('writeReceipt per-source outcomes', () => {
  it('renders sources in body table + frontmatter, rows:0 and errors included', async () => {
    const { engine, puts } = fakeEngine();
    await writeReceipt(engine, baseInput({
      sources: [
        { ref: 'session-a.part1.txt', hash: 'aaaa111122223333', rows: 3 },
        { ref: 'session-a.part2.txt', hash: 'bbbb111122223333', rows: 0 },
        { ref: 'pages/some-slug', rows: 0, error: 'boom | with pipe' },
      ],
    }));
    expect(puts.length).toBe(1);
    const body = puts[0].page.compiled_truth as string;
    expect(body).toContain('## Per-source outcomes');
    expect(body).toContain('| session-a.part1.txt | aaaa111122223333 | 3 |');
    expect(body).toContain('| session-a.part2.txt | bbbb111122223333 | 0 |');
    // pipe in the error is escaped so the table stays a table
    expect(body).toContain('error: boom \\| with pipe');

    const fm = puts[0].page.frontmatter as Record<string, unknown>;
    const sources = fm.sources as Array<Record<string, unknown>>;
    expect(sources.length).toBe(3);
    expect(fm.sources_total).toBe(3);
    expect(sources[1]).toEqual({ ref: 'session-a.part2.txt', hash: 'bbbb111122223333', rows: 0 });
  });

  it('caps recorded sources at MAX_RECEIPT_SOURCES and keeps the true total', async () => {
    const { engine, puts } = fakeEngine();
    const many = Array.from({ length: MAX_RECEIPT_SOURCES + 25 }, (_, i) => ({
      ref: `t-${i}.txt`,
      rows: 1,
    }));
    await writeReceipt(engine, baseInput({ sources: many }));
    const fm = puts[0].page.frontmatter as Record<string, unknown>;
    expect((fm.sources as unknown[]).length).toBe(MAX_RECEIPT_SOURCES);
    expect(fm.sources_total).toBe(MAX_RECEIPT_SOURCES + 25);
    const body = puts[0].page.compiled_truth as string;
    expect(body).toContain('more (frontmatter `sources` carries up to');
  });

  it('omitting sources leaves body + frontmatter unchanged (additive)', async () => {
    const { engine, puts } = fakeEngine();
    await writeReceipt(engine, baseInput());
    const body = puts[0].page.compiled_truth as string;
    const fm = puts[0].page.frontmatter as Record<string, unknown>;
    expect(body).not.toContain('Per-source outcomes');
    expect('sources' in fm).toBe(false);
    expect('sources_total' in fm).toBe(false);
  });
});

const ATOM_JSON = JSON.stringify([
  { title: 'A real nugget', atom_type: 'critique', body: 'Something learned.' },
]);

function chatReturning(textBySource: Record<string, string>) {
  return async (req: { messages: Array<{ content: string }> }) => {
    const content = req.messages[0].content;
    const match = Object.keys(textBySource).find((k) => content.includes(k));
    return {
      text: match ? textBySource[match] : '[]',
      usage: { input_tokens: 100, output_tokens: 50 },
    };
  };
}

function transcript(name: string, hash: string) {
  return {
    filePath: `/staged/${name}`,
    content: `Transcript content for ${name}. Long enough to matter.`,
    contentHash: hash.padEnd(64, '0'),
  };
}

describe('runPhaseExtractAtoms receipt coverage', () => {
  it('writes a receipt with rows:0 outcomes when EVERY source yields 0 atoms (the gap)', async () => {
    const { engine, puts } = fakeEngine();
    const result = await runPhaseExtractAtoms(engine, {
      _transcripts: [transcript('s1.part7.txt', 'deadbeefcafe0001')],
      _pages: [],
      _loadConfig: () => null,
      _chat: chatReturning({}) as never, // always returns [] → 0 atoms
    });
    expect(result.status).toBe('ok');
    const receipt = puts.find((p) => p.slug.startsWith('extracts/'));
    expect(receipt).toBeDefined();
    const fm = receipt!.page.frontmatter as Record<string, unknown>;
    expect(fm.total_rows).toBe(0);
    const sources = fm.sources as Array<Record<string, unknown>>;
    expect(sources.length).toBe(1);
    expect(sources[0].rows).toBe(0);
    expect(sources[0].hash).toBe('deadbeefcafe0001');
    expect((receipt!.page.compiled_truth as string)).toContain('1 source(s) yielded 0 atoms.');
  });

  it('records per-source rows and failure notes on a mixed round', async () => {
    const { engine, puts } = fakeEngine();
    const failing = transcript('s2.part1.txt', 'aaaa22223333bbbb');
    const yielding = transcript('s2.part2.txt', 'cccc22223333dddd');
    const empty = transcript('s2.part3.txt', 'eeee22223333ffff');
    const chat = async (req: { messages: Array<{ content: string }> }) => {
      const content = req.messages[0].content;
      if (content.includes('s2.part1.txt')) throw new Error('provider blew up');
      return {
        text: content.includes('s2.part2.txt') ? ATOM_JSON : '[]',
        usage: { input_tokens: 100, output_tokens: 50 },
      };
    };
    const result = await runPhaseExtractAtoms(engine, {
      _transcripts: [failing, yielding, empty],
      _pages: [],
      _loadConfig: () => null,
      _chat: chat as never,
    });
    expect(result.status).toBe('warn'); // failure present
    const receipt = puts.find((p) => p.slug.startsWith('extracts/'));
    expect(receipt).toBeDefined();
    const fm = receipt!.page.frontmatter as Record<string, unknown>;
    const sources = fm.sources as Array<Record<string, unknown>>;
    expect(sources.length).toBe(3);
    const byRef = Object.fromEntries(sources.map((s) => [s.ref as string, s]));
    expect(byRef['/staged/s2.part1.txt'].error).toContain('provider blew up');
    expect(byRef['/staged/s2.part2.txt'].rows).toBe(1);
    expect(byRef['/staged/s2.part3.txt'].rows).toBe(0);
  });

  it('dry-run still writes no receipt', async () => {
    const { engine, puts } = fakeEngine();
    await runPhaseExtractAtoms(engine, {
      dryRun: true,
      _transcripts: [transcript('s3.part1.txt', '1111222233334444')],
      _pages: [],
      _loadConfig: () => null,
      _chat: chatReturning({ 's3.part1.txt': ATOM_JSON }) as never,
    });
    expect(puts.find((p) => p.slug.startsWith('extracts/'))).toBeUndefined();
  });
});
