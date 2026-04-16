import { describe, expect, test } from 'bun:test';
import {
  extractCommitments,
  runCommitmentQualityGate,
  HAIKU_MODEL,
  SONNET_MODEL,
  type QualityGateCase,
  type StructuredCommitment,
  type WhatsAppMessage,
} from '../../src/action-brain/extractor.ts';

type FakeResponse = {
  content: Array<
    | {
        type: 'tool_use';
        name: string;
        input: unknown;
      }
    | {
        type: 'text';
        text: string;
      }
  >;
};

class FakeAnthropicClient {
  public readonly calls: Array<{ model: string; prompt: string }> = [];

  constructor(private readonly responder: (params: { model: string; prompt: string }) => FakeResponse | Promise<FakeResponse>) {}

  messages = {
    create: async (params: { model: string; messages: Array<{ content: string }> }): Promise<FakeResponse> => {
      const prompt = params.messages[0]?.content ?? '';
      this.calls.push({ model: params.model, prompt });
      return this.responder({ model: params.model, prompt });
    },
  };
}

function toolResponse(commitments: unknown[]): FakeResponse {
  return {
    content: [
      {
        type: 'tool_use',
        name: 'extract_commitments',
        input: { commitments },
      },
    ],
  };
}

function textJsonResponse(payload: unknown): FakeResponse {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload),
      },
    ],
  };
}

function message(msgId: string, text: string): WhatsAppMessage {
  return {
    ChatName: 'DM Tin Ops',
    SenderName: 'Joe',
    Timestamp: '2026-04-16T08:00:00.000Z',
    Text: text,
    MsgID: msgId,
  };
}

function commitment(fields: Partial<StructuredCommitment> & Pick<StructuredCommitment, 'owes_what'>): StructuredCommitment {
  return {
    who: fields.who ?? null,
    owes_what: fields.owes_what,
    to_whom: fields.to_whom ?? null,
    by_when: fields.by_when ?? null,
    confidence: fields.confidence ?? 0.8,
    type: fields.type ?? 'commitment',
  };
}

function extractMsgId(prompt: string): string {
  const match = prompt.match(/"MsgID":"([^"]+)"/);
  if (!match) {
    throw new Error(`Could not extract MsgID from prompt: ${prompt}`);
  }
  return match[1];
}

describe('extractCommitments', () => {
  test('#1 parses tool_use output and normalizes invalid fields', async () => {
    const fakeClient = new FakeAnthropicClient(() =>
      toolResponse([
        {
          who: 'Joe',
          owes_what: 'Send yard photos',
          to_whom: 'Abhi',
          by_when: '2026-04-17',
          confidence: 2,
          type: 'follow_up',
        },
        {
          who: 'Nichol',
          owes_what: 'Approve payout',
          to_whom: 'Sagar',
          by_when: 'not-a-date',
          confidence: -1,
          type: 'unknown_type',
        },
      ])
    );

    const output = await extractCommitments([message('msg-001', 'Joe will send yard photos tomorrow.')], {
      client: fakeClient,
    });

    expect(output).toEqual([
      {
        who: 'Joe',
        owes_what: 'Send yard photos',
        to_whom: 'Abhi',
        by_when: '2026-04-17T00:00:00.000Z',
        confidence: 1,
        type: 'follow_up',
      },
      {
        who: 'Nichol',
        owes_what: 'Approve payout',
        to_whom: 'Sagar',
        by_when: null,
        confidence: 0,
        type: 'commitment',
      },
    ]);
  });

  test('#2 normalizes missing assignee and due date to null defaults', async () => {
    const fakeClient = new FakeAnthropicClient(() =>
      toolResponse([
        {
          owes_what: 'Share invoice copy',
          confidence: '0.63',
          type: 'commitment',
        },
      ])
    );

    const output = await extractCommitments([message('msg-002', 'Will share invoice copy soon.')], { client: fakeClient });

    expect(output).toEqual([
      {
        who: null,
        owes_what: 'Share invoice copy',
        to_whom: null,
        by_when: null,
        confidence: 0.63,
        type: 'commitment',
      },
    ]);
  });

  test('#3 drops malformed commitment rows and wrong-shape tool input', async () => {
    const fakeClient = new FakeAnthropicClient(() =>
      toolResponse([
        {
          who: 'Joe',
          type: 'commitment',
        },
      ])
    );

    const output = await extractCommitments([message('msg-003', 'Bad shape output')], { client: fakeClient });
    expect(output).toEqual([]);
  });

  test('#4 returns empty list on API timeout/errors', async () => {
    const fakeClient = new FakeAnthropicClient(() => {
      const error = new Error('request timed out');
      error.name = 'AbortError';
      throw error;
    });

    const output = await extractCommitments([message('msg-004', 'please send docs')], {
      client: fakeClient,
      timeoutMs: 10,
    });

    expect(output).toEqual([]);
  });

  test('#5 recovers from text JSON output when tool_use block is absent', async () => {
    const fakeClient = new FakeAnthropicClient(() =>
      textJsonResponse({
        commitments: [
          {
            who: 'Mukesh',
            owes_what: 'Send mine production update',
            to_whom: 'Abhi',
            by_when: '2026-04-20T09:00:00.000Z',
            confidence: 0.92,
            type: 'follow_up',
          },
        ],
      })
    );

    const output = await extractCommitments([message('msg-005', 'Mukesh to send production update by Monday 5pm')], {
      client: fakeClient,
    });

    expect(output).toEqual([
      {
        who: 'Mukesh',
        owes_what: 'Send mine production update',
        to_whom: 'Abhi',
        by_when: '2026-04-20T09:00:00.000Z',
        confidence: 0.92,
        type: 'follow_up',
      },
    ]);
  });
});

describe('runCommitmentQualityGate', () => {
  const goldSet: QualityGateCase[] = [
    {
      id: 'case-001',
      messages: [message('gold-001', 'Joe will send assay report by Friday.')],
      expected: [commitment({ who: 'Joe', owes_what: 'Send assay report', to_whom: 'Abhi', by_when: '2026-04-17T00:00:00.000Z' })],
    },
    {
      id: 'case-002',
      messages: [message('gold-002', 'Nichol said he will approve payout today.')],
      expected: [
        commitment({
          who: 'Nichol',
          owes_what: 'Approve payout',
          to_whom: 'Sagar',
          by_when: '2026-04-16T00:00:00.000Z',
        }),
      ],
    },
    {
      id: 'case-003',
      messages: [message('gold-003', 'I need to check with customs and revert.')],
      expected: [commitment({ who: null, owes_what: 'Revert after checking with customs', to_whom: null, by_when: null })],
    },
    {
      id: 'case-004',
      messages: [message('gold-004', 'Please follow up with rail team for wagon availability.')],
      expected: [
        commitment({ who: 'Joe', owes_what: 'Follow up with rail team', to_whom: 'Abhi', by_when: null, type: 'follow_up' }),
      ],
    },
    {
      id: 'case-005',
      messages: [message('gold-005', 'Can we finalize the LC terms tomorrow morning?')],
      expected: [commitment({ who: null, owes_what: 'Finalize LC terms', to_whom: null, by_when: '2026-04-17T00:00:00.000Z', type: 'decision' })],
    },
    {
      id: 'case-006',
      messages: [message('gold-006', 'Sagar to call port agent before noon.')],
      expected: [
        commitment({ who: 'Sagar', owes_what: 'Call port agent', to_whom: 'Abhi', by_when: '2026-04-16T00:00:00.000Z', type: 'commitment' }),
      ],
    },
    {
      id: 'case-007',
      messages: [message('gold-007', 'Joe asked if we should release shipment 3 now.')],
      expected: [
        commitment({ who: null, owes_what: 'Decide whether to release shipment 3', to_whom: null, by_when: null, type: 'question' }),
      ],
    },
    {
      id: 'case-008',
      messages: [message('gold-008', 'Delegating Danyi to collect all signed docs by EOD.')],
      expected: [
        commitment({
          who: 'Danyi',
          owes_what: 'Collect all signed docs',
          to_whom: 'Abhi',
          by_when: '2026-04-16T00:00:00.000Z',
          type: 'delegation',
        }),
      ],
    },
    {
      id: 'case-009',
      messages: [message('gold-009', 'I will send the assay report after lunch.')],
      expected: [
        commitment({ who: null, owes_what: 'Send assay report', to_whom: 'Abhi', by_when: '2026-04-16T00:00:00.000Z', type: 'commitment' }),
      ],
    },
    {
      id: 'case-010',
      messages: [message('gold-010', 'Please remind me to send the vessel docs tomorrow.')],
      expected: [
        commitment({ who: 'Joe', owes_what: 'Send vessel docs', to_whom: 'Abhi', by_when: '2026-04-17T00:00:00.000Z', type: 'follow_up' }),
      ],
    },
  ];

  const canonicalByMsgId = new Map<string, StructuredCommitment[]>(
    goldSet.map((entry) => [extractMsgId(JSON.stringify({ messages: entry.messages })), entry.expected])
  );

  test('#6 quality gate does not escalate when pass rate is >= 90%', async () => {
    const fakeClient = new FakeAnthropicClient(({ model, prompt }) => {
      const msgId = extractMsgId(prompt);
      if (model !== HAIKU_MODEL) {
        throw new Error(`Unexpected model in this scenario: ${model}`);
      }

      const expected = canonicalByMsgId.get(msgId) ?? [];
      if (msgId === 'gold-010') {
        return toolResponse([]);
      }
      return toolResponse(expected);
    });

    const result = await runCommitmentQualityGate(goldSet, {
      client: fakeClient,
      threshold: 0.9,
    });

    expect(result.escalated).toBe(false);
    expect(result.primary.model).toBe(HAIKU_MODEL);
    expect(result.primary.passRate).toBe(0.9);
    expect(result.final.model).toBe(HAIKU_MODEL);
    expect(fakeClient.calls.every((call) => call.model === HAIKU_MODEL)).toBe(true);
  });

  test('#7 quality gate escalates to Sonnet when Haiku is below threshold', async () => {
    const fakeClient = new FakeAnthropicClient(({ model, prompt }) => {
      const msgId = extractMsgId(prompt);
      const expected = canonicalByMsgId.get(msgId) ?? [];

      if (model === HAIKU_MODEL) {
        if (msgId === 'gold-009' || msgId === 'gold-010') {
          return toolResponse([]);
        }
        return toolResponse(expected);
      }

      if (model === SONNET_MODEL) {
        return toolResponse(expected);
      }

      throw new Error(`Unexpected model ${model}`);
    });

    const result = await runCommitmentQualityGate(goldSet, {
      client: fakeClient,
      threshold: 0.9,
    });

    expect(result.escalated).toBe(true);
    expect(result.primary.model).toBe(HAIKU_MODEL);
    expect(result.primary.passRate).toBe(0.8);
    expect(result.final.model).toBe(SONNET_MODEL);
    expect(result.final.passRate).toBe(1);
    expect(result.final.passed).toBe(true);

    const haikuCalls = fakeClient.calls.filter((call) => call.model === HAIKU_MODEL).length;
    const sonnetCalls = fakeClient.calls.filter((call) => call.model === SONNET_MODEL).length;

    expect(haikuCalls).toBe(10);
    expect(sonnetCalls).toBe(10);
  });

  test('#25 quality gate reports per-case mismatch details for reviewability', async () => {
    const fakeClient = new FakeAnthropicClient(({ model, prompt }) => {
      const msgId = extractMsgId(prompt);
      const expected = canonicalByMsgId.get(msgId) ?? [];

      if (model === HAIKU_MODEL && msgId === 'gold-001') {
        return toolResponse([
          commitment({ who: 'Joe', owes_what: 'Send wrong item', to_whom: 'Abhi', by_when: '2026-04-17T00:00:00.000Z' }),
        ]);
      }

      return toolResponse(expected);
    });

    const result = await runCommitmentQualityGate(goldSet, {
      client: fakeClient,
      threshold: 0.95,
      fallbackModel: SONNET_MODEL,
    });

    expect(result.escalated).toBe(true);

    const failedPrimaryCase = result.primary.cases.find((entry) => entry.id === 'case-001');
    expect(failedPrimaryCase?.matched).toBe(false);
    expect(failedPrimaryCase?.missing.length).toBeGreaterThan(0);
    expect(failedPrimaryCase?.unexpected.length).toBeGreaterThan(0);
  });
});
