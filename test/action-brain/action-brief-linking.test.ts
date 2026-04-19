import { afterEach, describe, expect, test } from 'bun:test';
import type { Operation, OperationContext } from '../../src/core/operations.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import {
  ACTION_BRIEF_SOURCE_CONTACT_LOOKUP_CAP,
  ACTION_BRIEF_SOURCE_CONTACT_LOOKUP_CONCURRENCY,
  actionBrainOperations,
} from '../../src/action-brain/operations.ts';

let engine: PGLiteEngine | null = null;

afterEach(async () => {
  if (engine) {
    await engine.disconnect();
    engine = null;
  }
});

function getActionOperation(name: string): Operation {
  const operation = actionBrainOperations.find((op) => op.name === name);
  if (!operation) {
    throw new Error(`Missing action operation: ${name}`);
  }
  return operation;
}

async function createActionContext(): Promise<OperationContext> {
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' } as any);
  await engine.initSchema();

  const ctx: OperationContext = {
    engine,
    config: { engine: 'pglite' } as any,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
  };

  // Ensures Action Brain tables exist.
  await getActionOperation('action_list').handler(ctx, {});
  return ctx;
}

function toSlugBase(sourceContact: string): string {
  return sourceContact
    .toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

describe('action_brief entity linking', () => {
  test('embeds resolved source_contact entity slug in brief output', async () => {
    const ctx = await createActionContext();
    const actionIngest = getActionOperation('action_ingest');
    const actionBrief = getActionOperation('action_brief');

    await engine!.putPage('people/joe', {
      type: 'person',
      title: 'Joe',
      compiled_truth: 'Joe handles operations follow-ups.',
      timeline: '',
    });
    await engine!.upsertChunks('people/joe', [
      {
        chunk_index: 0,
        chunk_source: 'compiled_truth',
        chunk_text: 'Joe handles operations follow-ups.',
      },
    ]);

    await actionIngest.handler(ctx, {
      messages: [
        {
          ChatName: 'Operations',
          SenderName: 'Joe',
          Timestamp: '2026-04-16T08:00:00.000Z',
          Text: 'Please send the final shipment docs.',
          MsgID: 'm1',
        },
      ],
      commitments: [
        {
          who: 'Joe',
          owes_what: 'Send the final shipment docs',
          to_whom: 'Abhi',
          by_when: null,
          confidence: 0.95,
          type: 'commitment',
          source_message_id: 'm1',
        },
      ],
    });

    const result = await actionBrief.handler(ctx, {
      now: '2026-04-16T12:00:00.000Z',
      last_sync_at: '2026-04-16T11:30:00.000Z',
    });

    expect(result.brief).toContain('source_contact=[Joe](people/joe)');
  });

  test('keeps plain source_contact when no entity page can be resolved', async () => {
    const ctx = await createActionContext();
    const actionIngest = getActionOperation('action_ingest');
    const actionBrief = getActionOperation('action_brief');

    await actionIngest.handler(ctx, {
      messages: [
        {
          ChatName: 'Operations',
          SenderName: 'Ghost Person',
          Timestamp: '2026-04-16T08:00:00.000Z',
          Text: 'I will send the report.',
          MsgID: 'm1',
        },
      ],
      commitments: [
        {
          who: 'Ghost Person',
          owes_what: 'Send the report',
          to_whom: 'Abhi',
          by_when: null,
          confidence: 0.95,
          type: 'commitment',
          source_message_id: 'm1',
        },
      ],
    });

    const result = await actionBrief.handler(ctx, {
      now: '2026-04-16T12:00:00.000Z',
      last_sync_at: '2026-04-16T11:30:00.000Z',
    });

    expect(result.brief).toContain('source_contact=Ghost Person');
    expect(result.brief).not.toContain('source_contact=[Ghost Person](');
  });

  test('keeps plain source_contact when entity match is ambiguous', async () => {
    const ctx = await createActionContext();
    const actionIngest = getActionOperation('action_ingest');
    const actionBrief = getActionOperation('action_brief');

    await engine!.putPage('people/joe', {
      type: 'person',
      title: 'Joe',
      compiled_truth: 'Joe handles operations follow-ups.',
      timeline: '',
    });
    await engine!.upsertChunks('people/joe', [
      {
        chunk_index: 0,
        chunk_source: 'compiled_truth',
        chunk_text: 'Joe handles operations follow-ups.',
      },
    ]);

    await engine!.putPage('companies/joe', {
      type: 'company',
      title: 'Joe',
      compiled_truth: 'Joe is a company that appears in operations notes.',
      timeline: '',
    });
    await engine!.upsertChunks('companies/joe', [
      {
        chunk_index: 0,
        chunk_source: 'compiled_truth',
        chunk_text: 'Joe is a company that appears in operations notes.',
      },
    ]);

    await actionIngest.handler(ctx, {
      messages: [
        {
          ChatName: 'Operations',
          SenderName: 'Joe',
          Timestamp: '2026-04-16T08:00:00.000Z',
          Text: 'Please send the final shipment docs.',
          MsgID: 'm1',
        },
      ],
      commitments: [
        {
          who: 'Joe',
          owes_what: 'Send the final shipment docs',
          to_whom: 'Abhi',
          by_when: null,
          confidence: 0.95,
          type: 'commitment',
          source_message_id: 'm1',
        },
      ],
    });

    const result = await actionBrief.handler(ctx, {
      now: '2026-04-16T12:00:00.000Z',
      last_sync_at: '2026-04-16T11:30:00.000Z',
    });

    expect(result.brief).toContain('source_contact=Joe');
    expect(result.brief).not.toContain('source_contact=[Joe](');
  });

  test('bounds source_contact lookups and fails open beyond per-brief cap', async () => {
    const ctx = await createActionContext();
    const actionIngest = getActionOperation('action_ingest');
    const actionBrief = getActionOperation('action_brief');
    const uniqueContacts = ACTION_BRIEF_SOURCE_CONTACT_LOOKUP_CAP + 6;

    const messages = Array.from({ length: uniqueContacts }, (_, index) => ({
      ChatName: 'Operations',
      SenderName: `Contact ${index}`,
      Timestamp: '2026-04-16T08:00:00.000Z',
      Text: `Message ${index}`,
      MsgID: `m${index}`,
    }));
    const commitments = messages.map((message, index) => ({
      who: message.SenderName,
      owes_what: `Task ${index}`,
      to_whom: 'Abhi',
      by_when: null,
      confidence: 0.95,
      type: 'commitment',
      source_message_id: message.MsgID,
    }));

    const originalResolveSlugs = engine!.resolveSlugs.bind(engine!);
    const originalSearchKeyword = engine!.searchKeyword.bind(engine!);
    let resolveSlugCalls = 0;
    let searchKeywordCalls = 0;
    let inFlightSearchCalls = 0;
    let maxConcurrentSearchCalls = 0;

    engine!.resolveSlugs = async (partial: string) => {
      resolveSlugCalls += 1;
      return [partial];
    };
    engine!.searchKeyword = async (query: string) => {
      searchKeywordCalls += 1;
      inFlightSearchCalls += 1;
      maxConcurrentSearchCalls = Math.max(maxConcurrentSearchCalls, inFlightSearchCalls);
      try {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return [{ slug: `people/${toSlugBase(query)}` }] as any;
      } finally {
        inFlightSearchCalls -= 1;
      }
    };

    try {
      await actionIngest.handler(ctx, {
        messages,
        commitments,
      });

      const result = await actionBrief.handler(ctx, {
        now: '2026-04-16T12:00:00.000Z',
        last_sync_at: '2026-04-16T11:30:00.000Z',
      });

      const beyondCapContact = `Contact ${ACTION_BRIEF_SOURCE_CONTACT_LOOKUP_CAP + 1}`;
      expect(resolveSlugCalls).toBe(ACTION_BRIEF_SOURCE_CONTACT_LOOKUP_CAP * 2);
      expect(searchKeywordCalls).toBe(ACTION_BRIEF_SOURCE_CONTACT_LOOKUP_CAP);
      expect(maxConcurrentSearchCalls).toBeLessThanOrEqual(ACTION_BRIEF_SOURCE_CONTACT_LOOKUP_CONCURRENCY);
      expect(result.brief).toContain('source_contact=[Contact 0](people/contact-0)');
      expect(result.brief).toContain(`source_contact=${beyondCapContact}`);
      expect(result.brief).not.toContain(`source_contact=[${beyondCapContact}](`);
    } finally {
      engine!.resolveSlugs = originalResolveSlugs;
      engine!.searchKeyword = originalSearchKeyword;
    }
  });
});
