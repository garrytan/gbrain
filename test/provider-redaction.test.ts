/**
 * Provider egress redaction (src/core/ai/provider-redaction.ts wired into
 * gateway embed / expand / rerank / chat).
 *
 * Protects: with `redaction.egress_classes` empty every provider request is
 * byte-identical to today's; with `identifier` set, no embedding input,
 * expansion prompt, rerank query or document, chat system prompt, message,
 * tool input or tool result carries an identifier value — the token does —
 * while a guardrail provider registered on the observe-only seam still sees
 * the raw text; and the counters report pattern and surface, never a value.
 * Regression it catches: a gateway call site that sends `opts.messages` or
 * `texts` around the helper, or the order flipping so the guardrail sees
 * redacted text. Existing gateway tests never set a redaction policy.
 * Seams: the gateway's transport test seams, __setRedactionPolicyForTests.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  __setEmbedTransportForTests, __setGenerateObjectTransportForTests, __setGenerateTextTransportForTests, __setRerankTransportForTests, chat,
  configureGateway, embed, expand, rerank, resetGateway,
} from '../src/core/ai/gateway.ts';
import { __resetGuardrailProvidersForTests, registerGuardrailProvider } from '../src/core/guardrails.ts';
import { __setRedactionPolicyForTests } from '../src/core/redaction-policy.ts';
import { __resetProviderRedactionsForTests, observeProviderRedactions, providerRedactionCounts, redactProviderMessages, redactProviderText } from '../src/core/ai/provider-redaction.ts';

const SSN = '078-05-1120';
const NOTE = `Patient alice-example, SSN ${SSN}, MRN: AB123456.`;
const TOKEN = '<REDACTED:ssn>';

let embedCalls: string[][];
let generateCalls: unknown[];
let rerankBodies: unknown[];

beforeEach(() => {
  resetGateway();
  configureGateway({
    embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 8,
    chat_model: 'anthropic:claude-haiku-4-5-20251001', expansion_model: 'anthropic:claude-haiku-4-5-20251001',
    env: { OPENAI_API_KEY: 'sk-fake', ANTHROPIC_API_KEY: 'sk-ant-fake', VOYAGE_API_KEY: 'pa-fake' },
  });
  embedCalls = []; generateCalls = []; rerankBodies = [];
  __setEmbedTransportForTests((async ({ values }: { values: string[] }) => {
    embedCalls.push([...values]);
    return { embeddings: values.map(() => new Array(8).fill(0.1)), usage: { tokens: values.length } } as never;
  }) as never);
  __setGenerateTextTransportForTests((async (opts: unknown) => {
    generateCalls.push({ kind: 'text', opts });
    return { text: '{"queries":["one","two","three"]}', usage: { inputTokens: 5, outputTokens: 5 } } as never;
  }) as never);
  __setGenerateObjectTransportForTests((async (opts: unknown) => {
    generateCalls.push({ kind: 'object', opts });
    return { object: { queries: ['one', 'two', 'three'] }, usage: { inputTokens: 5, outputTokens: 5 } } as never;
  }) as never);
  __setRerankTransportForTests(async (_url, init) => {
    rerankBodies.push(JSON.parse(String(init?.body ?? '{}')));
    return new Response(JSON.stringify({ results: [{ index: 0, relevance_score: 0.9 }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
});
afterEach(() => {
  __setEmbedTransportForTests(null); __setGenerateTextTransportForTests(null); __setGenerateObjectTransportForTests(null); __setRerankTransportForTests(null);
  __setRedactionPolicyForTests(null); __resetGuardrailProvidersForTests(); __resetProviderRedactionsForTests();
  resetGateway();
});

const sent = () => JSON.stringify({ embedCalls, generateCalls, rerankBodies });

async function drive(): Promise<void> {
  await embed([NOTE, 'plain text']);
  await expand(NOTE);
  await rerank({ query: NOTE, documents: [NOTE, 'other doc'] });
  await chat({
    system: `You know that SSN ${SSN} belongs to the patient.`,
    messages: [
      { role: 'user', content: NOTE },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'lookup', input: { ssn: SSN } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'lookup', output: { found: `SSN ${SSN}` } }] },
      { role: 'user', content: [{ type: 'text', text: `Again: SSN ${SSN}` }] },
    ],
  });
}

describe('gateway egress', () => {
  test('policy off: every request carries the raw text and nothing is counted', async () => {
    await drive();
    expect(embedCalls[0]).toEqual([NOTE, 'plain text']);
    expect(generateCalls.length).toBe(2);
    expect(sent()).toContain(SSN);
    expect(sent()).not.toContain('<REDACTED:');
    expect(providerRedactionCounts()).toEqual([]);
  });

  test('identifier class: no request carries the value on any surface; counts name surface + pattern only', async () => {
    __setRedactionPolicyForTests({ egress: ['identifier'] });
    const events: string[] = [];
    observeProviderRedactions((e) => events.push(`${e.surface}:${e.pattern}:${e.count}`));
    await drive();
    expect(sent()).not.toContain(SSN);
    expect(embedCalls[0]).toEqual([`Patient alice-example, SSN ${TOKEN}, MRN: <REDACTED:mrn>.`, 'plain text']);
    expect(generateCalls.length).toBe(2);
    expect(JSON.stringify(generateCalls[0])).toContain(`Query: Patient alice-example, SSN ${TOKEN}`);
    expect(rerankBodies[0]).toMatchObject({ documents: [`Patient alice-example, SSN ${TOKEN}, MRN: <REDACTED:mrn>.`, 'other doc'] });
    const chatCall = JSON.stringify(generateCalls[1]);
    expect(chatCall).toContain(`You know that SSN ${TOKEN} belongs`);
    expect(chatCall).toContain(`"ssn":"${TOKEN}"`);
    expect(chatCall).toContain(`"found":"SSN ${TOKEN}"`);
    expect(chatCall).toContain(`Again: SSN ${TOKEN}`);
    const surfaces = new Set(providerRedactionCounts().map((c) => c.surface));
    expect([...surfaces].sort()).toEqual(['chat', 'chat_system', 'embed', 'expand', 'rerank', 'tool_input', 'tool_result']);
    expect(events.every((e) => !e.includes(SSN))).toBe(true);
    expect(events).toContain('embed:ssn:1');
  });

  test('the observe-only guardrail seam still sees the raw text (observe, then redact, then send)', async () => {
    __setRedactionPolicyForTests({ egress: ['identifier'] });
    const seen: string[] = [];
    registerGuardrailProvider({ id: 'raw-witness', classify: (input) => { seen.push(`${input.hook}:${input.content}`); } });
    await expand(NOTE);
    await chat({ messages: [{ role: 'user', content: NOTE }] });
    expect(seen.some((s) => s.startsWith('ai_gateway.expand:') && s.includes(SSN))).toBe(true);
    expect(seen.some((s) => s.startsWith('ai_gateway.chat:') && s.includes(SSN))).toBe(true);
    expect(sent()).not.toContain(SSN);
  });
});

describe('helpers', () => {
  test('redactProviderText passes non-strings and empty strings through, and returns the same array when off', () => {
    expect(redactProviderText(undefined, 'chat')).toBeUndefined();
    expect(redactProviderText('', 'chat')).toBe('');
    const msgs = [{ role: 'user', content: NOTE }];
    expect(redactProviderMessages(msgs)).toBe(msgs);
    __setRedactionPolicyForTests({ egress: ['identifier'] });
    const out = redactProviderMessages(msgs);
    expect(out).not.toBe(msgs);
    expect(msgs[0]!.content).toBe(NOTE);
    expect(out[0]!.content).toContain(TOKEN);
  });
});
