/**
 * Large pages A7 (eng F24): the facts backstop reads the appended tail of a
 * long page instead of its first 8,000 characters, and a head-only read is a
 * durable receipt plus a doctor signal instead of a silent cut.
 *
 * 1. Protects: text appended to a page past MAX_TURN_TEXT_CHARS reaches the
 *    extractor; a mid-page edit falls back to the head and records
 *    `input_truncated` in page_extraction_state, which doctor lists.
 * 2. Regression that fails it: the extractor slicing the page head again
 *    (the pre-A7 behavior), or the receipt not being written.
 * 3. Existing facts tests use bodies under the cap, so no test sees the cut.
 * 4. No new seam: the chat transport stub is the existing test seam.
 *
 * PGLite in-memory, chat stubbed ($0).
 */
import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runFactsBackstop } from '../src/core/facts/backstop.ts';
import { MAX_TURN_TEXT_CHARS } from '../src/core/facts/extract.ts';
import { __setChatTransportForTests, resetGateway, type ChatOpts, type ChatResult } from '../src/core/ai/gateway.ts';
import { __resetFactsQueueForTests } from '../src/core/facts/queue.ts';
import { extractionInputTruncatedEntry } from '../src/commands/doctor/checks/extraction-input.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import type { Check } from '../src/commands/doctor.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

afterEach(() => {
  __setChatTransportForTests(null);
  resetGateway();
  __resetFactsQueueForTests();
});

/** Records every extractor prompt; replies with no facts. */
function capturePrompts(): string[] {
  const prompts: string[] = [];
  __setChatTransportForTests(async (opts: ChatOpts): Promise<ChatResult> => {
    prompts.push(JSON.stringify(opts.messages));
    return { text: '{"facts":[]}', blocks: [], stopReason: 'end', model: 'test:stub', providerId: 'test',
      usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 } };
  });
  return prompts;
}

/** iMessage-shaped lines, `tag` planted in each, until the text reaches `chars`. */
function lines(tag: string, chars: number): string {
  const out: string[] = [];
  let n = 0;
  for (let len = 0; len < chars; n++) {
    const line = `**alice-example** (2024-03-15 1:04 PM): ${tag} message ${n} about the acme-example rollout plan\n`;
    out.push(line);
    len += line.length;
  }
  return out.join('');
}

async function put(slug: string, body: string): Promise<void> {
  await engine.putPage(slug, { type: 'meeting', title: 'Sync', compiled_truth: body });
}

async function backstop(slug: string, body: string) {
  return runFactsBackstop({ slug, type: 'meeting', compiled_truth: body, frontmatter: {} },
    { engine, sourceId: 'default', sessionId: null, source: 'mcp:put_page', mode: 'inline' });
}

async function receipt(slug: string): Promise<Record<string, unknown> | null> {
  const [row] = await engine.executeRaw<{ input_truncated: Record<string, unknown> | string | null }>(
    `SELECT s.input_truncated FROM page_extraction_state s JOIN pages p ON p.id = s.page_id
      WHERE p.slug = $1 AND s.pipeline = 'facts_backstop'`, [slug]);
  const value = row?.input_truncated ?? null;
  return typeof value === 'string' ? JSON.parse(value) : value;
}

async function doctor(): Promise<Check> {
  const checks = await extractionInputTruncatedEntry.run({ engine } as unknown as DoctorContext) as Check[];
  return checks.find(c => c.name === 'extraction_input_truncated')!;
}

describe('facts backstop: appended tail instead of the page head (A7)', () => {
  test('an append to a page over the cap is extracted from the appended text, not the head', async () => {
    const slug = 'meetings/a7-append';
    const head = lines('HEADNEEDLE', MAX_TURN_TEXT_CHARS + 2_000);
    await put(slug, head);
    const prompts = capturePrompts();

    const first = await backstop(slug, head);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('HEADNEEDLE message 0 ');
    expect(first).toMatchObject({ mode: 'inline', input_truncated: { kind: 'head', reason: 'no_watermark', processed_chars: MAX_TURN_TEXT_CHARS } });
    expect(await receipt(slug)).toMatchObject({ kind: 'head', pipeline: 'facts_backstop', reason: 'no_watermark', total_chars: head.length });

    const appended = head + lines('TAILNEEDLE', 1_500);
    await put(slug, appended);
    const second = await backstop(slug, appended);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('TAILNEEDLE message 0 ');
    expect(prompts[1]).not.toContain('HEADNEEDLE');
    expect(second).not.toHaveProperty('input_truncated');
    // The head the first run skipped is still unread: the receipt stays.
    expect(await receipt(slug)).toMatchObject({ kind: 'head' });

    // Nothing appended since: no model call at all.
    await backstop(slug, appended);
    expect(prompts).toHaveLength(2);

    // An append longer than the cap: the newest window, recorded as such.
    const long = appended + lines('OLDTAIL', 6_000) + lines('NEWTAIL', 6_000);
    await put(slug, long);
    const third = await backstop(slug, long);
    expect(prompts).toHaveLength(3);
    expect(prompts[2]).toContain('NEWTAIL');
    expect(prompts[2]).not.toContain('OLDTAIL message 0 ');
    expect(prompts[2]).not.toContain('TAILNEEDLE');
    expect(third).toMatchObject({ input_truncated: { kind: 'tail_window' } });
    expect(await receipt(slug)).toMatchObject({ kind: 'tail_window', total_chars: long.length - appended.length });
  });

  test('a mid-page edit falls back to the head, records the receipt and doctor lists the page', async () => {
    const slug = 'meetings/a7-mid-edit';
    const body = lines('EARLY', 3_000) + lines('LATER', MAX_TURN_TEXT_CHARS);
    await put(slug, body);
    const prompts = capturePrompts();
    await backstop(slug, body);
    // The first read leaves the watermark at the end of this body.
    const edited = body.replace('EARLY message 3 ', 'EDITED message 3 ') + lines('APPENDED', 500);
    await put(slug, edited);
    const result = await backstop(slug, edited);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('EDITED message 3 ');
    expect(prompts[1]).not.toContain('APPENDED');
    expect(result).toMatchObject({ input_truncated: { kind: 'head', reason: 'prefix_changed' } });
    expect(await receipt(slug)).toMatchObject({ kind: 'head', reason: 'prefix_changed', total_chars: edited.length });

    const check = await doctor();
    expect(check.message).toContain(`default:${slug}`);
    expect(check.message).toContain('facts_backstop/head');
    expect(check.details).toMatchObject({ groups: expect.arrayContaining([expect.objectContaining({ pipeline: 'facts_backstop', kind: 'head' })]) });
  });

  test('a page under the cap is read whole and leaves no receipt', async () => {
    const slug = 'meetings/a7-short';
    const body = lines('SHORT', 2_000);
    await put(slug, body);
    const prompts = capturePrompts();
    const result = await backstop(slug, body);
    expect(prompts[0]).toContain('SHORT message 0 ');
    expect(result).not.toHaveProperty('input_truncated');
    expect(await receipt(slug)).toBeNull();
  });
});
