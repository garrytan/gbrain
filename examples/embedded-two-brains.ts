/**
 * Two brains in one process, opened from settings (docs/ENGINES.md "Opening an engine from settings").
 *
 * Each brain gets its own database, host identity and AI provider. Here the providers are two fake
 * OpenAI-compatible embedding servers on 127.0.0.1, so nothing leaves the machine and no key is real. The example
 * puts a page in each brain, searches each, closes both, and exits 1 if either provider saw the other brain's key
 * or a brain found the other brain's page. Only package exports are used.
 *
 *   bun examples/embedded-two-brains.ts
 */
import { randomUUID } from 'node:crypto';
import { openEngine } from 'gbrain/engine-open';
import { importFromContent } from 'gbrain/import-file';
import { hybridSearch } from 'gbrain/search/hybrid';

const DIMENSIONS = 1536;

/** A fake embedding provider that records the bearer of every request it gets. */
function fakeProvider(): { url: string; bearers: Set<string>; stop: () => void } {
  const bearers = new Set<string>();
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      bearers.add(request.headers.get('authorization') ?? '');
      const { input } = await request.json() as { input: string[] };
      const data = input.map((text, index) => ({
        object: 'embedding', index, embedding: Array.from({ length: DIMENSIONS }, (_, i) => ((text.length + i) % 13) / 13 + 0.01),
      }));
      return Response.json({ object: 'list', data, model: 'text-embedding-3-small', usage: { prompt_tokens: input.length, total_tokens: input.length } });
    },
  });
  return { url: `http://127.0.0.1:${server.port}/v1`, bearers, stop: () => server.stop(true) };
}

async function openBrain(name: string, apiKey: string, baseUrl: string) {
  const engine = await openEngine({
    embedded_core: true,
    engine: 'pglite',
    database: {},
    host: { id: randomUUID() },
    embedding: { model: 'openai:text-embedding-3-small', dimensions: DIMENSIONS },
    ai: { providers: { openai: { apiKey, baseUrl } } },
  });
  await engine.initSchema();
  await importFromContent(engine, `notes/${name}`, `---\ntitle: ${name}\n---\nThe quarterly plan for ${name} lives here.\n`);
  return engine;
}

const providerA = fakeProvider();
const providerB = fakeProvider();
const keyA = `sk-brain-a-${randomUUID()}`;
const keyB = `sk-brain-b-${randomUUID()}`;
const problems: string[] = [];
try {
  const brainA = await openBrain('brain-a', keyA, providerA.url);
  const brainB = await openBrain('brain-b', keyB, providerB.url);
  try {
    const foundA = (await hybridSearch(brainA, 'quarterly plan')).map(result => result.slug);
    const foundB = (await hybridSearch(brainB, 'quarterly plan')).map(result => result.slug);
    if (!foundA.includes('notes/brain-a') || foundA.includes('notes/brain-b')) problems.push(`brain-a found ${JSON.stringify(foundA)}`);
    if (!foundB.includes('notes/brain-b') || foundB.includes('notes/brain-a')) problems.push(`brain-b found ${JSON.stringify(foundB)}`);
  } finally {
    await Promise.all([brainA.disconnect(), brainB.disconnect()]);
  }
  const only = (seen: Set<string>, want: string) => seen.size === 1 && seen.has(`Bearer ${want}`);
  if (!only(providerA.bearers, keyA)) problems.push(`provider A saw ${providerA.bearers.size} distinct keys, not only brain-a's`);
  if (!only(providerB.bearers, keyB)) problems.push(`provider B saw ${providerB.bearers.size} distinct keys, not only brain-b's`);
} finally {
  providerA.stop();
  providerB.stop();
}

if (problems.length) {
  console.error(`embedded-two-brains: FAILED\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('embedded-two-brains: ok (each brain found its own page; each provider saw only its own brain\'s key)');
