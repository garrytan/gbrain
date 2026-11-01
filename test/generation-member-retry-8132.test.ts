/** #8132: a failed retry must not pin a pending generation member forever. */
import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatResult } from '../src/core/ai/gateway.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { runPhaseExtractAtoms } from '../src/core/cycle/extract-atoms.ts';
import { disposePersistenceConsumer, waitForWrites } from '../src/core/persistence/service.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';
import { sha256 } from '../src/core/persistence/digest.ts';
import { listPendingMembers } from '../src/core/generations/managed.ts';
import { memberRequestId } from '../src/core/generations/managed.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const chat = (titles: string[]) => async (): Promise<ChatResult> => {
  const text = JSON.stringify(titles.map(title => ({ title, body: title + '.', atom_type: 'insight' })));
  return { text, blocks: [{ type: 'text', text }], stopReason: 'end',
    usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic' };
};

async function drain(engine: BrainEngine) {
  const rows = await engine.executeRaw<WriteRequest>("SELECT * FROM persistence_requests WHERE state IN ('queued','running','recovering')");
  await waitForWrites(engine, rows, { engine: engine.kind }, 60_000);
  await disposePersistenceConsumer(engine);
}

for (const backend of testBackends()) describe(`generation member retries #8132 (${backend})`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  test('retries a member again after its first resubmission also fails', async () => {
    await managedBrain(async ({ engine, root }) => {
      let content = 'The team ships small changes, measures each launch and reviews outcomes weekly. '.repeat(12);
      const filePath = join(root, 'transcript.txt');
      const extract = async (titles: string[]) => {
        writeFileSync(filePath, content);
        await runPhaseExtractAtoms(engine, { sourceId: 'default', _pages: [],
          _transcripts: [{ filePath, content, contentHash: sha256(content) }], _chat: chat(titles) });
        await drain(engine);
      };
      await extract(['Ship small changes', 'Review outcomes weekly', 'Measure each launch', 'Pair on reviews']);
      await settleManagedGitEffects(engine);
      content += '\nA new plan adds error budgets.';
      let faults = 0;
      installFaultHook(async point => {
        if (point === 'generation:member') {
          faults++;
          throw new OperationError('revision_conflict', 'Synthetic member failure.', 'Retry the generation.');
        }
      });
      try {
        await extract(['Ship small changes', 'Review outcomes weekly', 'Track error budgets']).catch(() => undefined);
        await drain(engine);
        expect(faults).toBeGreaterThan(0);
        expect((await listPendingMembers(engine, ['default'], 'atom')).length).toBeGreaterThan(0);
        await runPhaseExtractAtoms(engine, { sourceId: 'default', _pages: [], _transcripts: [], _chat: chat([]) }).catch(() => undefined);
        await drain(engine);
      } finally { installFaultHook(undefined); }
      const attempts = await engine.executeRaw<WriteRequest>("SELECT * FROM persistence_requests WHERE error_message LIKE '%Synthetic member failure%' ORDER BY sequence");
      const retried = attempts.filter(row => row.slug === attempts.at(-1)!.slug);
      expect(retried).toHaveLength(2);
      const member = (await listPendingMembers(engine, ['default'], 'atom')).find(row => row.slug === retried[0]!.slug)!;
      expect(retried[1]!.request_id).toBe(memberRequestId(member.activation_id, member.slug, `${member.action}:after:${retried[0]!.id}`));
      await runPhaseExtractAtoms(engine, { sourceId: 'default', _pages: [], _transcripts: [], _chat: chat([]) });
      await drain(engine);
      expect(await listPendingMembers(engine, ['default'], 'atom')).toEqual([]);
      const committed = await engine.executeRaw<WriteRequest>("SELECT * FROM persistence_requests WHERE slug=$1 AND request_id=$2::uuid AND state='committed'",
        [member.slug, memberRequestId(member.activation_id, member.slug, `${member.action}:after:${retried[1]!.id}`)]);
      expect(committed).toHaveLength(1);
      await runPhaseExtractAtoms(engine, { sourceId: 'default', _pages: [], _transcripts: [], _chat: chat([]) });
      await drain(engine);
      expect(await engine.executeRaw("SELECT id FROM persistence_requests WHERE slug=$1 AND request_id=$2::uuid", [member.slug, committed[0]!.request_id])).toHaveLength(1);
    }, { databaseUrl });
  }, 240_000);
});
