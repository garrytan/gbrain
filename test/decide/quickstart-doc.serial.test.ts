/**
 * The System One quickstart in docs/guides/system-one.md, executed.
 *
 * Parses the copy-paste block and the expected-output block between the
 * `system-one-quickstart` markers, runs every documented command in process
 * against a seeded PGLite brain with a fixture TypeSafe transport (no live
 * key, no network), and asserts every documented output line appears, in
 * order. Volatile numbers (latency, token counts, dollar amounts) are
 * normalized on both sides; probabilities, ranks, slugs and wording are not.
 * If this fails, the guide and the CLI disagree: fix whichever is wrong.
 *
 * Serial: mock.module (the interaction module's consent prompt), GBRAIN_HOME, process.stdin.isTTY
 * and the process-global gateway.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installFixtureChunks } from '../helpers/page-projection.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { configureGateway, resetGateway, __setDecideTransportForTests } from '../../src/core/ai/gateway.ts';
import { __resetDecideStoreForTests, flushDecideWrites } from '../../src/core/ai/decide/store.ts';
import { resetDecideSearchCache } from '../../src/core/search/decide-stage.ts';

// A human at the terminal answers "y" to the consent prompt (requireConsent → interaction.readLine).
const realInteraction = await import('../../src/core/interaction.ts');
mock.module('../../src/core/interaction.ts', () => ({ ...realInteraction, isInteractive: () => true, readLine: async () => ({ kind: 'line', text: 'y' }) }));

const GUIDE = join(import.meta.dir, '..', '..', 'docs', 'guides', 'system-one.md');

/** The seeded brain the guide's example output describes. */
const QUICKSTART_PAGES: Array<{ slug: string; title: string; type: string; text: string; visibility?: string }> = [
  { slug: 'meetings/2026-09-22-weekly-sync', title: 'Acme Example weekly sync', type: 'meeting', text: 'When does Acme Example ship the beta? We asked when to ship the Acme Example beta again. No date yet.' },
  { slug: 'notes/launch-plan', title: 'Launch plan', type: 'note', text: 'Acme Example decided to ship the beta on Friday. Alice Example owns the launch plan.' },
  { slug: 'notes/board-prep', title: 'Board prep', type: 'note', text: 'Private board prep: Acme Example beta ship risks.', visibility: 'private' },
];

let engine: PGLiteEngine;
let home: string;
let prevHome: string | undefined;
let prevTty: PropertyDescriptor | undefined;
const sentBodies: string[] = [];

/** Deterministic TypeSafe answers: text naming the ship day is evidence; everything else is not. */
function fixtureTransport() {
  __setDecideTransportForTests(async (_url, init) => {
    sentBodies.push(init.body as string);
    const body = JSON.parse(init.body as string) as { questions: Record<string, { type: string; instructions: unknown; criteria?: unknown }> };
    const answers = Object.fromEntries(Object.entries(body.questions).map(([id, q]) => {
      const evidence = JSON.stringify(q.instructions).includes('Friday');
      if (q.type === 'score') return [id, { type: 'score', score: evidence ? 3 : 1, confidence: 0.9 }];
      if (q.type === 'choice') {
        const labels = Object.keys(q.criteria as Record<string, unknown>);
        const probabilities = Object.fromEntries(labels.map((l, i) => [l, i === 0 ? 0.9 : 0.1 / (labels.length - 1)]));
        return [id, { type: 'choice', choice: labels[0], probabilities, confidence: 0.9 }];
      }
      return [id, { type: 'noul', noul: evidence ? 0.93 : 0.08 }];
    }));
    return new Response(JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 383, output_tokens: 20 } }));
  });
}

interface Quickstart { exports: string[]; commands: string[]; expected: Array<{ command: string; lines: string[] }> }

function parseQuickstart(): Quickstart {
  const doc = readFileSync(GUIDE, 'utf8');
  const block = doc.split('<!-- system-one-quickstart:begin -->')[1]?.split('<!-- system-one-quickstart:end -->')[0];
  if (!block) throw new Error('system-one-quickstart markers missing from docs/guides/system-one.md');
  const fences = [...block.matchAll(/```(\w+)\n([\s\S]*?)```/g)].map((m) => ({ lang: m[1]!, body: m[2]! }));
  const script = fences.find((f) => f.lang === 'bash');
  const output = fences.find((f) => f.lang === 'console');
  if (!script || !output) throw new Error('quickstart needs one ```bash block and one ```console block');
  const lines = script.body.split('\n').map((l) => l.replace(/\s+#.*$/, '').trim()).filter(Boolean);
  const expected: Quickstart['expected'] = [];
  for (const line of output.body.split('\n')) {
    if (line.startsWith('$ ')) expected.push({ command: line.slice(2).trim(), lines: [] });
    else if (line.trim() && expected.length) expected.at(-1)!.lines.push(line.trimEnd());
  }
  return { exports: lines.filter((l) => l.startsWith('export ')), commands: lines.filter((l) => !l.startsWith('export ')), expected };
}

/** Minimal shell-word split: whitespace, with double-quoted words. */
function argv(command: string): string[] {
  return [...command.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]!);
}

/** Latency, token counts and dollar amounts vary run to run; nothing else does. */
function normalize(line: string): string {
  return line.replace(/\b\d+ ms\b/g, '<ms> ms').replace(/\b\d+ input tokens\b/g, '<n> input tokens').replace(/\$\d+\.\d+/g, '$<usd>').trimEnd();
}

async function run(command: string): Promise<{ code: number; lines: string[] }> {
  const words = argv(command);
  expect(words.slice(0, 2)).toEqual(['gbrain', 'decide']);
  const lines: string[] = [];
  const log = console.log;
  const err = console.error;
  const capture = (...a: unknown[]) => { for (const l of a.map(String).join(' ').split('\n')) lines.push(l); };
  console.log = capture;
  console.error = capture;
  try {
    const { runDecideCommand } = await import('../../src/commands/decide.ts');
    const code = await runDecideCommand(engine, words.slice(2));
    await flushDecideWrites();
    return { code, lines };
  } finally {
    console.log = log;
    console.error = err;
  }
}

beforeAll(async () => {
  prevHome = process.env.GBRAIN_HOME;
  home = mkdtempSync(join(tmpdir(), 'gbrain-decide-quickstart-'));
  process.env.GBRAIN_HOME = home;
  prevTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  // A keyless `gbrain init --pglite --no-embedding` brain resolves search.mode conservative.
  await engine.setConfig('search.mode', 'conservative');
  for (const p of QUICKSTART_PAGES) {
    await engine.putPage(p.slug, { type: p.type, title: p.title, compiled_truth: p.text, ...(p.visibility ? { frontmatter: { visibility: p.visibility } } : {}) });
    await installFixtureChunks(engine, p.slug, [{ chunk_index: 0, chunk_text: p.text, chunk_source: 'compiled_truth' }]);
  }
  configureGateway({ env: { TYPESAFE_API_KEY: 'fixture-key-not-a-secret' } } as Parameters<typeof configureGateway>[0]);
  resetDecideSearchCache();
  __resetDecideStoreForTests();
  fixtureTransport();
});

afterAll(async () => {
  __setDecideTransportForTests(null);
  resetGateway();
  await engine.disconnect();
  if (prevTty) Object.defineProperty(process.stdin, 'isTTY', prevTty);
  else delete (process.stdin as { isTTY?: boolean }).isTTY;
  if (prevHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

describe('System One quickstart (docs/guides/system-one.md)', () => {
  test('the copy-paste block and the expected output name the same commands', () => {
    const q = parseQuickstart();
    expect(q.exports).toEqual(['export TYPESAFE_API_KEY=<your-key>']);
    expect(q.commands.length).toBeGreaterThanOrEqual(4);
    expect(q.expected.map((e) => e.command)).toEqual(q.commands);
    for (const e of q.expected) expect(e.lines.length).toBeGreaterThan(0);
  });

  test('every documented output line appears, in order, against a fixture transport', async () => {
    const q = parseQuickstart();
    for (const step of q.expected) {
      const { lines } = await run(step.command);
      const actual = lines.map(normalize);
      let at = 0;
      for (const want of step.lines.map(normalize)) {
        if (want === '...') continue;
        const found = actual.indexOf(want, at);
        if (found < 0) throw new Error(`"${step.command}": documented line not found in order:\n  ${want}\nactual output:\n  ${actual.join('\n  ')}`);
        at = found + 1;
      }
    }
    expect(sentBodies.length).toBeGreaterThan(0);
    for (const body of sentBodies) expect(body).not.toContain('Private board prep');
    // The guide says the probes change and store nothing: no receipt, and no config write.
    expect(await engine.executeRaw('SELECT 1 FROM decision_receipts')).toHaveLength(0);
    expect(await engine.executeRaw(`SELECT 1 FROM config WHERE key LIKE 'decide.%'`)).toHaveLength(0);
  }, 120_000);
});
