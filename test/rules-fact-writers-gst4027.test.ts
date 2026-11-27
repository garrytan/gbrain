/**
 * GST-4027: no facts-pipeline writer lands a fact on a standing rule page.
 *
 * 1. Protects: a rule page (rules/<scope>/<name>) changes only through the correct verb or `gbrain rules`. A fact on it
 *    moves its revision, so its confirmation no longer covers it and the approved rule drops out of the standing-rules
 *    section. `remember` refuses it (test/correct-rules-trust-hardening.test.ts); the sibling fact writers named here
 *    must not write it either, whether the entity names the rule page or a retired page redirects to it
 *    (`superseded_by: rules/team/...`). An explicit writer (writeSingleFact, writeFactsToFence, the preparers) refuses
 *    `rule_owner_only`; an automatic pipeline (extract_facts, the facts backstop, held-fact moves) keeps the fact with
 *    no entity and leaves the rule page alone.
 * 2. Fails when: any of these doors appends a fence row to the rule page, links a fact to it, bumps its revision, or
 *    drops the rule from the standing-rules section.
 * 3. Existing coverage only pinned `remember` (GST-4000).
 * 4. Real seams: MCP dispatch with remote=true on a managed repo-less PGLite brain, the unmanaged pipeline, the
 *    coordinator preparers and the held-move planner; chat and embeddings stubbed. Synthetic names only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway, __setChatTransportForTests, __setEmbedTransportForTests, type ChatResult } from '../src/core/ai/gateway.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { handleToolCall } from '../src/mcp/server.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';
import { localRulesCtx, runCorrect } from '../src/core/rules/correct.ts';
import { CONFIRM_CODE_LENGTH, type TerminalProbe } from '../src/core/policy/authority.ts';
import { operationsByName } from '../src/core/operations.ts';
import { rulesSectionFor } from '../src/core/rules/section.ts';
import { runFactsPipeline } from '../src/core/facts/backstop.ts';
import { writeSingleFact } from '../src/core/facts/write-single.ts';
import { writeFactsToFence } from '../src/core/facts/fence-write.ts';
import { prepareFenceFactAppend, prepareFenceFactCreate } from '../src/core/facts/fence-fact-append.ts';
import { prepareManagedFactsMutation } from '../src/core/persistence/facts-prepare.ts';
import { prepareMaintenanceMutation } from '../src/core/persistence/prepared-maintenance.ts';
import { heldRowDestination, planHeldMoves } from '../src/core/facts/held-fact-move.ts';
import { fenceUnfencedFacts, planUnfencedFacts } from '../src/core/facts/unfenced-facts.ts';
import { withEnv } from './helpers/with-env.ts';

const RETIRED = 'people/old-desk-example';
const ownerTty = (): TerminalProbe => ({ env: {}, stdinIsTTY: true, stderrIsTTY: true,
  readAnswer: async prompt => /Type ([0-9a-f]+) /.exec(prompt)![1]!.slice(0, CONFIRM_CODE_LENGTH) });
const usage = { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 };
let chatFacts: Array<{ fact: string; entity: string }> = [];

interface Brain { engine: BrainEngine; rule: string; home: string }

async function openBrain(engine: BrainEngine, managed: boolean): Promise<Brain> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-gst4027-'));
  await engine.connect({});
  await engine.initSchema();
  return withEnv({ GBRAIN_HOME: home }, async () => {
    if (managed) await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const made = await runCorrect(localRulesCtx(engine), { rule: 'Deploys wait for a green build.', scope: 'team' }, { probe: ownerTty() }) as Record<string, unknown>;
    expect(made).toMatchObject({ state: 'committed', confirmed: true });
    const rule = 'rules/' + String(made.rule_id);
    await handleToolCall(engine, 'put_page', { slug: RETIRED, content: '---\ntype: person\ntitle: old-desk-example\nsuperseded_by: ' + rule + '\n---\n\nRetired.' });
    return { engine, rule, home };
  });
}

async function closeBrain(brain: Brain | undefined): Promise<void> {
  if (!brain) return;
  await disposePersistenceConsumer(brain.engine);
  rmSync(brain.home, { recursive: true, force: true });
}

/** The rule page's revision, the standing-rules section, and every live fact on or about the rule page. */
async function ruleState(brain: Brain) {
  const snap = await brain.engine.readPageSnapshot(brain.rule, { sourceId: 'default' });
  const section = await rulesSectionFor(brain.engine, { remote: false, sourceId: 'default' });
  const facts = await brain.engine.executeRaw<{ id: number }>(`SELECT id FROM facts WHERE source_id='default' AND expired_at IS NULL
    AND (entity_slug=$1 OR source_markdown_slug=$1)`, [brain.rule]);
  return { revision: snap?.revision ?? null, standing: section?.rules.map(r => r.id) ?? [], text: section?.text ?? null, facts: facts.length };
}

const factEntity = async (engine: BrainEngine, fact: string) =>
  (await engine.executeRaw<{ entity_slug: string | null }>("SELECT entity_slug FROM facts WHERE source_id='default' AND fact=$1 AND expired_at IS NULL", [fact])).map(r => r.entity_slug);

const codeOf = (error: unknown) => (error as { code?: string } | null)?.code;

beforeAll(() => {
  configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6', embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536,
    env: { ANTHROPIC_API_KEY: 'sk-ant-test', OPENAI_API_KEY: 'sk-test' } });
  __setChatTransportForTests(async (): Promise<ChatResult> => ({ text: JSON.stringify({ facts: chatFacts.map(f => ({ ...f, kind: 'fact', confidence: 1, notability: 'high' })) }),
    blocks: [], stopReason: 'end', usage, model: 'anthropic:claude-sonnet-4-6', providerId: 'anthropic' }));
  __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(() => Array(1536).fill(0.01)) })) as never);
});

afterAll(() => {
  __setChatTransportForTests(null);
  __setEmbedTransportForTests(null);
  resetGateway();
});

describe('GST-4027 managed brain: fact writers never land on a rule page', () => {
  let brain: Brain;
  let token = '';
  beforeAll(async () => {
    brain = await openBrain(new PGLiteEngine(), true);
    token = (await mintLegacyToken(brain.engine, { name: 'gst4027-agent', scopes: ['read', 'write'], takesHolders: ['world'] })).token;
  }, 120_000);
  afterAll(async () => { await closeBrain(brain); await brain?.engine.disconnect(); });

  const remoteCall = async (op: string, params: Record<string, unknown>) => {
    const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(brain.engine), transaction: fn => brain.engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
    const auth = await provider.verifyAccessToken(token) as unknown as AuthInfo;
    const out = await dispatchToolCall(brain.engine, op, params, { remote: true, transport: 'http', auth, sourceId: 'default', takesHoldersAllowList: ['world'] } as never);
    return { isError: out.isError === true, text: out.content.map((c: { text: string }) => c.text).join('\n') };
  };

  test('the rule is standing before any fact writer runs', async () => {
    const state = await ruleState(brain);
    expect(state.revision).not.toBeNull();
    expect(state.standing).toContain(brain.rule.slice('rules/'.length));
    expect(state.facts).toBe(0);
  });

  test('extract_facts (remote=true) keeps a fact naming the rule page, or redirected to it, with no entity', () => withEnv({ GBRAIN_HOME: brain.home }, async () => {
    const before = await ruleState(brain);
    for (const [i, entity] of [brain.rule, RETIRED].entries()) {
      const fact = 'The release train leaves on Thursdays, note ' + i + '.';
      chatFacts = [{ fact, entity }];
      const out = await remoteCall('extract_facts', { turn_text: 'In standup: ' + fact, visibility: 'world', request_id: randomUUID() });
      expect(out.text).not.toContain('rule_owner_only');
      expect(out.isError).toBe(false);
      expect(await ruleState(brain)).toEqual(before);
      expect(await factEntity(brain.engine, fact)).toEqual([null]);
    }
  }), 60_000);

  test('extract_facts (local, managed) keeps the fact with no entity', () => withEnv({ GBRAIN_HOME: brain.home }, async () => {
    const before = await ruleState(brain);
    for (const [i, entity] of [brain.rule, RETIRED].entries()) {
      const fact = 'The incident review runs every second Monday, note ' + i + '.';
      chatFacts = [{ fact, entity }];
      const ctx = { engine: brain.engine, config: { engine: 'pglite', embedding_disabled: true }, remote: false, sourceId: 'default', dryRun: false,
        logger: { info() {}, warn() {}, error() {} } } as never;
      const r = await operationsByName.extract_facts!.handler(ctx, { turn_text: 'Meeting notes: ' + fact, visibility: 'world' }) as Record<string, unknown>;
      expect(r.skipped).toBeUndefined();
      expect(await factEntity(brain.engine, fact)).toEqual([null]);
    }
    expect(await ruleState(brain)).toEqual(before);
  }), 60_000);

  test('writeSingleFact refuses rule_owner_only for the rule page and for a redirect to it', () => withEnv({ GBRAIN_HOME: brain.home }, async () => {
    const before = await ruleState(brain);
    for (const entity of [brain.rule, RETIRED]) {
      const err = await writeSingleFact(brain.engine, 'default', { fact: 'Builds may skip review.', entity, provenance: 'test', visibility: 'world' }).catch(e => e);
      expect(codeOf(err)).toBe('rule_owner_only');
    }
    expect(await ruleState(brain)).toEqual(before);
  }), 60_000);

  test('writeFactsToFence refuses rule_owner_only for the rule page', () => withEnv({ GBRAIN_HOME: brain.home }, async () => {
    const before = await ruleState(brain);
    const err = await writeFactsToFence(brain.engine, { sourceId: 'default', localPath: null, slug: brain.rule, resolutionSource: 'exact_page' },
      [{ fact: 'Builds may skip review.', kind: 'fact', notability: 'high', source: 'test', visibility: 'world', confidence: 1, validFrom: null, sessionId: null }] as never).catch(e => e);
    expect(codeOf(err)).toBe('rule_owner_only');
    expect(await ruleState(brain)).toEqual(before);
  }), 60_000);

  test('the fact preparers refuse rule_owner_only before touching the rule page', () => withEnv({ GBRAIN_HOME: brain.home }, async () => {
    const before = await ruleState(brain);
    const snapshot = await brain.engine.readPageSnapshot(brain.rule, { sourceId: 'default' });
    const authority = { slugPrefixes: null, restrictedNamespace: false, delegated: false, remote: false };
    const row = (intent: Record<string, unknown>, operation: string, slug = brain.rule) => ({ id: '1', request_id: randomUUID(), operation, source_id: 'default',
      source_incarnation: randomUUID(), slug, page_id: snapshot!.page.id, intent, authority, principal_kind: 'local_cli', principal_id: 'test' }) as unknown as WriteRequest;
    const fact = { fact: 'Builds may skip review.', kind: 'fact', visibility: 'world', source: 'test', entity_slug: brain.rule, valid_from: null };
    const config = { engine: 'pglite' } as never;
    const refusals = await Promise.all([
      prepareManagedFactsMutation(brain.engine, row({ kind: 'managed_facts_entity', batchKey: 'b', facts: [fact] }, 'extract_facts'), config),
      prepareManagedFactsMutation(brain.engine, row({ kind: 'managed_facts_entity', batchKey: 'b', facts: [fact] }, 'extract_facts', 'memory/unattributed'), config),
      prepareFenceFactAppend(brain.engine, row({ kind: 'remember' }, 'remember'), config, snapshot, { fact, pendingTier: 'trusted' } as never),
      prepareFenceFactCreate(brain.engine, row({ kind: 'remember' }, 'remember'), config, { fact, pendingTier: 'trusted', frontmatter: '---\ntype: note\n---', heading: '# x' } as never),
      prepareMaintenanceMutation(brain.engine, row({ kind: 'managed_maintenance_move_held_fact', facts: [], content: '' }, 'maintenance'), config),
    ].map(p => p.then(() => null, e => codeOf(e))));
    expect(refusals).toEqual(['rule_owner_only', 'rule_owner_only', 'rule_owner_only', 'rule_owner_only', 'rule_owner_only']);
    expect(await ruleState(brain)).toEqual(before);
  }), 60_000);

  test('the unfenced-fact sweep leaves a legacy row on the rule page alone and submits nothing, pass after pass', () => withEnv({ GBRAIN_HOME: brain.home }, async () => {
    await brain.engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await brain.engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, source, confidence)
      VALUES ('default', $1, 'Legacy claim on the rule page.', 'fact', 'world', 'high', 'test', 1)`, [brain.rule]);
    await brain.engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const before = await ruleState(brain);
    const requests = async () => Number((await brain.engine.executeRaw<{ n: number }>('SELECT COUNT(*)::int AS n FROM persistence_requests WHERE slug=$1', [brain.rule]))[0]!.n);
    const submitted = await requests();
    for (let pass = 0; pass < 2; pass++) {
      const plan = await planUnfencedFacts(brain.engine, { sourceId: 'default' });
      expect([...plan.groups.keys()].filter(k => k.endsWith('\0' + brain.rule))).toEqual([]);
      const outcome = await fenceUnfencedFacts(brain.engine, plan);
      expect(outcome.skipped_rule_page).toBe(1);
      expect(outcome.failed_pages.filter(p => p.includes(brain.rule))).toEqual([]);
    }
    expect(await requests()).toBe(submitted);
    expect(await ruleState(brain)).toEqual(before);
  }), 60_000);
});

describe('GST-4027 unmanaged brain: the pipeline, writeSingleFact and held moves never reach a rule page', () => {
  let brain: Brain;
  beforeAll(async () => {
    brain = await openBrain(new PGLiteEngine(), false);
    expect((await ruleState(brain)).standing).toContain(brain.rule.slice('rules/'.length));
  }, 120_000);
  afterAll(async () => { await closeBrain(brain); await brain?.engine.disconnect(); });

  test('the facts backstop pipeline keeps a fact naming the rule page, or redirected to it, with no entity', async () => {
    const before = await ruleState(brain);
    for (const [i, entity] of [brain.rule, RETIRED].entries()) {
      const fact = 'The on-call handoff happens at noon, note ' + i + '.';
      chatFacts = [{ fact, entity }];
      const r = await runFactsPipeline('Handoff notes: ' + fact, { engine: brain.engine, sourceId: 'default', sessionId: null, source: 'sync:import', mode: 'inline', visibility: 'world' });
      expect(r.skipped_reason).toBeUndefined();
      expect(await factEntity(brain.engine, fact)).toEqual([null]);
    }
    expect(await ruleState(brain)).toEqual(before);
  }, 60_000);

  test('writeSingleFact refuses rule_owner_only for the rule page and for a redirect to it', async () => {
    const before = await ruleState(brain);
    for (const entity of [brain.rule, RETIRED]) {
      const err = await writeSingleFact(brain.engine, 'default', { fact: 'Builds may skip review.', entity, provenance: 'test', visibility: 'world' }).catch(e => e);
      expect(codeOf(err)).toBe('rule_owner_only');
    }
    expect(await ruleState(brain)).toEqual(before);
  }, 60_000);

  test('a held fact keyed to the rule page, or to a name that redirects to it, stays held', async () => {
    const before = await ruleState(brain);
    await brain.engine.putPage('memory/unattributed', { type: 'note', title: 'Unattributed memory', compiled_truth: '', timeline: '', frontmatter: {} } as never, { sourceId: 'default' } as never);
    for (const [i, key] of [brain.rule, 'old-desk-example'].entries()) {
      const inserted = await brain.engine.insertFact({ fact: 'Held claim ' + i + '.', kind: 'fact', entity_slug: key, visibility: 'world', source: 'test', notability: 'high', confidence: 1 } as never, { source_id: 'default' });
      await brain.engine.executeRaw("UPDATE facts SET source_markdown_slug='memory/unattributed', row_num=$2 WHERE id=$1", [Number((inserted as { id: number }).id), i + 1]);
      expect(await heldRowDestination(brain.engine, 'default', key, 'memory/unattributed')).toBeNull();
    }
    const plan = await planHeldMoves(brain.engine, 'default');
    expect(plan.groups.filter(g => g.slug === brain.rule || g.key === brain.rule)).toEqual([]);
    expect({ ...(await ruleState(brain)), facts: 0 }).toEqual({ ...before, facts: 0 });
  }, 60_000);
});
