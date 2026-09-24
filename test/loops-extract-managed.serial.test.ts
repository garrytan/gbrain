import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';

interface ChatReq {
  system?: string;
  messages?: Array<{ role: string; content: string }>;
}
let chatCalls = 0;
let chatImpl: (req: ChatReq) => Promise<{ text: string; stopReason: string }> = async () => ({
  text: '{"commitments":[],"decisions_pending":[]}',
  stopReason: 'end',
});

mock.module('../src/core/ai/gateway.ts', () => ({
  isAvailable: (touchpoint: string) => touchpoint === 'chat',
  chat: async (req: ChatReq) => {
    chatCalls++;
    return chatImpl(req);
  },
  embedOne: async () => { throw new Error('embedding must stay unavailable'); },
  embed: async () => { throw new Error('embedding must stay unavailable'); },
}));

const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');
const { runLoopsExtract, runManagedLoopsExtract } = await import('../src/core/google/loops-extract.ts');
const { APPLICATION_AUTHORITY, withSubmissionAuthority } =
  await import('../src/core/minions/submission-authority.ts');
const { normalizeAlias } = await import('../src/core/search/alias-normalize.ts');

const SRC = 'managed-google-a';
const OTHER = 'managed-google-b';
const EMAIL = 'emails/2026/09/managed-a-thread.md';
const STALE_EMAIL = 'emails/2026/09/managed-stale-thread.md';
const PERSON = 'people/alice-managed-example';

let engine: InstanceType<typeof PGLiteEngine>;
let incarnation = '';
let otherIncarnation = '';

function cleanJson(): string {
  return JSON.stringify({
    commitments: [{
      direction: 'owed_by_me',
      text: 'Send Alice the managed deck',
      counterparty_name: 'Alice Managed',
      counterparty_email: 'alice@example.invalid',
      due_iso: '2026-09-30',
      quote: 'I will send the managed deck by Wednesday.',
    }],
    decisions_pending: [{
      text: 'Choose the managed rollout date',
      quote: 'Which rollout date should we choose?',
    }],
  });
}

async function setManaged(enabled: boolean): Promise<void> {
  await engine.executeRaw('UPDATE persistence_brain SET enabled=$1 WHERE singleton=1', [enabled]);
}

async function runManaged(payload: Record<string, unknown> = {}) {
  return withSubmissionAuthority(APPLICATION_AUTHORITY, () =>
    runManagedLoopsExtract(engine, {
      slug: EMAIL,
      sourceId: SRC,
      sourceIncarnation: incarnation,
      ...payload,
    }),
  );
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
  await setManaged(false);
  for (const sourceId of [SRC, OTHER]) {
    await engine.executeRaw(
      `INSERT INTO sources (id,name,config)
       VALUES ($1,$1,$2::text::jsonb) ON CONFLICT (id) DO NOTHING`,
      [sourceId, JSON.stringify({ kind: 'google', g_account: 'synthetic@example.invalid' })],
    );
  }
  [incarnation] = (await engine.executeRaw<{ incarnation: string }>(
    'SELECT incarnation FROM sources WHERE id=$1', [SRC],
  )).map((r) => r.incarnation);
  [otherIncarnation] = (await engine.executeRaw<{ incarnation: string }>(
    'SELECT incarnation FROM sources WHERE id=$1', [OTHER],
  )).map((r) => r.incarnation);

  for (const slug of [EMAIL, STALE_EMAIL]) {
    await engine.putPage(slug, {
      type: 'email',
      title: 'Managed synthetic thread',
      compiled_truth:
        'Me: I will send the managed deck by Wednesday.\n' +
        'Alice: Which rollout date should we choose?\n',
      frontmatter: { thread_id: `thread-${slug}`, date: '2026-09-24T10:00:00Z' },
    }, { sourceId: SRC });
  }
  await engine.putPage(PERSON, {
    type: 'person',
    title: 'Alice Managed',
    compiled_truth: 'Synthetic person.',
  }, { sourceId: SRC });
  await engine.executeRaw(
    `INSERT INTO page_aliases (source_id,alias_norm,slug) VALUES ($1,$2,$3)
     ON CONFLICT DO NOTHING`,
    [SRC, normalizeAlias('Alice Managed'), PERSON],
  );
  await setManaged(true);
}, 120_000);

afterAll(async () => {
  await setManaged(false);
  await engine.disconnect();
});

describe('managed loops_extract authority boundary', () => {
  test('legacy direct path remains denied in managed mode before provider', async () => {
    const before = chatCalls;
    await expect(runLoopsExtract(engine, { slug: EMAIL, sourceId: SRC }))
      .rejects.toThrow(/legacy writer/i);
    expect(chatCalls).toBe(before);
  });

  test('managed path requires trusted job authority before provider', async () => {
    const before = chatCalls;
    await expect(runManagedLoopsExtract(engine, {
      slug: EMAIL,
      sourceId: SRC,
      sourceIncarnation: incarnation,
    })).rejects.toThrow(/trusted application job authority/i);
    expect(chatCalls).toBe(before);
  });

  test('wrong source incarnation is denied before provider', async () => {
    const before = chatCalls;
    await expect(runManaged({ sourceId: OTHER, sourceIncarnation: incarnation }))
      .rejects.toThrow(/missing, archived, or was replaced/i);
    expect(chatCalls).toBe(before);
    expect(otherIncarnation).not.toBe(incarnation);
  });

  test('archived source is denied before provider', async () => {
    await setManaged(false);
    await engine.executeRaw('UPDATE sources SET archived=true WHERE id=$1', [OTHER]);
    await setManaged(true);
    const before = chatCalls;
    try {
      await expect(runManaged({ sourceId: OTHER, sourceIncarnation: otherIncarnation }))
        .rejects.toThrow(/missing, archived, or was replaced/i);
      expect(chatCalls).toBe(before);
    } finally {
      await setManaged(false);
      await engine.executeRaw('UPDATE sources SET archived=false WHERE id=$1', [OTHER]);
      await setManaged(true);
    }
  });
});

describe('managed loops_extract publication', () => {
  test('authorized job publishes fact, native loops, and source-bound edge', async () => {
    chatImpl = async () => ({ text: cleanJson(), stopReason: 'end' });
    const result = await runManaged();
    expect(result.status).toBe('extracted');
    expect(result.commitments).toBe(1);
    expect(result.decisions).toBe(1);

    const loops = await engine.executeRaw<Record<string, unknown>>(
      'SELECT loop_type,fact_id,page_slug FROM open_loops WHERE source_id=$1 AND page_slug=$2 ORDER BY loop_type',
      [SRC, EMAIL],
    );
    expect(loops).toHaveLength(2);
    const commitment = loops.find((row) => row.loop_type === 'commitment_owed_by_me')!;
    expect(commitment.fact_id).not.toBeNull();

    const fact = await engine.executeRaw<Record<string, unknown>>(
      'SELECT source_id,fact,kind FROM facts WHERE id=$1', [commitment.fact_id],
    );
    expect(fact).toEqual([{
      source_id: SRC,
      fact: 'Send Alice the managed deck',
      kind: 'commitment',
    }]);

    const edges = await engine.executeRaw<Record<string, unknown>>(
      `SELECT fp.source_id AS from_source,tp.source_id AS to_source,l.link_type
         FROM links l JOIN pages fp ON fp.id=l.from_page_id JOIN pages tp ON tp.id=l.to_page_id
        WHERE fp.slug=$1 AND l.link_source='google-loops'`,
      [EMAIL],
    );
    expect(edges).toEqual([{
      from_source: SRC,
      to_source: SRC,
      link_type: 'owes_to',
    }]);
  });

  test('coordinated capability does not leak after callback', async () => {
    await expect(engine.insertFact({
      fact: 'must be denied outside coordinator',
      kind: 'fact',
      visibility: 'private',
      source: 'managed-test',
    }, { source_id: SRC })).rejects.toThrow(/writer_coordinator_required/i);
  });

  test('source authority lost during provider prevents every publication', async () => {
    const loopsBefore = await engine.executeRaw(
      'SELECT id FROM open_loops WHERE source_id=$1 AND page_slug=$2', [SRC, STALE_EMAIL],
    );
    expect(loopsBefore).toHaveLength(0);

    chatImpl = async () => {
      await setManaged(false);
      await engine.executeRaw('UPDATE sources SET archived=true WHERE id=$1', [SRC]);
      await setManaged(true);
      return { text: cleanJson(), stopReason: 'end' };
    };
    try {
      await expect(runManaged({ slug: STALE_EMAIL })).rejects.toThrow(/missing, archived, or was replaced/i);
    } finally {
      await setManaged(false);
      await engine.executeRaw('UPDATE sources SET archived=false WHERE id=$1', [SRC]);
      await setManaged(true);
      chatImpl = async () => ({ text: cleanJson(), stopReason: 'end' });
    }

    expect(await engine.executeRaw(
      'SELECT id FROM open_loops WHERE source_id=$1 AND page_slug=$2', [SRC, STALE_EMAIL],
    )).toHaveLength(0);
    expect(await engine.executeRaw(
      'SELECT id FROM facts WHERE source_id=$1 AND source LIKE $2', [SRC, `%${STALE_EMAIL}%`],
    )).toHaveLength(0);
  });
});
