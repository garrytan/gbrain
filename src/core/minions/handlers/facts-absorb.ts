/**
 * `facts-absorb` Minion job handler (built-in; registered by registerBuiltinHandlers in src/commands/jobs.ts).
 */
import type { BrainEngine } from '../../engine.ts';
import type { MinionHandler } from '../types.ts';
import { loadConfig, loadConfigWithEngine } from '../../config.ts';
import type { FactsBackstopResult } from '../../facts/backstop.ts';

/** Shared predicate: an inline result reporting execution-time unavailability. */
export function factsAbsorbUnavailable(result: FactsBackstopResult): boolean {
  return (
    result.mode === 'inline' &&
    (result.skipped === 'extraction_unavailable' || result.skipped_reason === 'chat_unavailable')
  );
}

/**
 * The facts-absorb retry decision (@internal exported for tests). A job that
 * finds chat unavailable at EXECUTION in a KEYED worker is config drift — it
 * must throw (retry/backoff → visible, re-runnable failure), never return
 * success and silently consume the job. A KEYLESS worker executing a job
 * enqueued by some other process is the steady expected state — completing
 * as a calm skip (the execution-time gate already printed the keyless note)
 * beats a retry loop that parks every page write as a failed job.
 */
export function factsAbsorbShouldRetry(
  result: FactsBackstopResult,
  classification: 'keyed' | 'keyless',
): boolean {
  return classification === 'keyed' && factsAbsorbUnavailable(result);
}

/**
 * Local patch 2026-06-11: durable facts:absorb. One-shot CLI processes
 * (capture/put/sync) can't finish the extraction chat before their exit
 * drain aborts it, so backstop.ts submits this job instead and the
 * long-lived worker does the LLM work here. Inline mode: errors throw, so
 * minion retry/backoff handles transient failures and real ones stay visible
 * in `gbrain jobs list --status failed`. In the gateway-refresh set (model
 * config re-stamped per job). #4310: wrapped in the provider-halt cooldown
 * (llm-halt-cooldown.ts) — a globally-broken provider defers the queue.
 */
export function makeFactsAbsorbHandler(engine: BrainEngine): MinionHandler {
  return async (job) => {
    const slug = typeof job.data.slug === 'string' ? job.data.slug : '';
    if (!slug) throw new Error('facts-absorb job requires data.slug');
    const sourceId = typeof job.data.sourceId === 'string' ? job.data.sourceId : 'default';
    const { readFactsBackstopJobPage } = await import('../../persistence/effect-facts.ts');
    const input = await readFactsBackstopJobPage(engine, job.data);
    if ('skipped' in input) return { skipped: input.skipped, slug, sourceId };
    const page = input.page;
    const { runFactsBackstop, coerceNotabilityFilter } = await import('../../facts/backstop.ts');
    const KNOWN_SOURCES = ['sync:import', 'mcp:put_page', 'mcp:extract_facts', 'file_upload', 'code_import', 'hook:writeback'] as const;
    const source = (KNOWN_SOURCES as readonly string[]).includes(job.data.source as string)
      ? (job.data.source as typeof KNOWN_SOURCES[number])
      : 'mcp:put_page';
    const result = await runFactsBackstop(
      {
        slug: page.slug,
        type: page.type,
        compiled_truth: page.compiled_truth,
        frontmatter: (page.frontmatter ?? {}) as Record<string, unknown>,
      },
      {
        engine, config: await loadConfigWithEngine(engine, loadConfig() ?? { engine: engine.kind }) ?? { engine: engine.kind },
        sourceId,
        sessionId: typeof job.data.sessionId === 'string' ? job.data.sessionId : null,
        persistenceRequestId: typeof job.data.persistence_request_id === 'string' ? job.data.persistence_request_id : undefined,
        source,
        mode: 'inline',
        notabilityFilter: coerceNotabilityFilter(job.data.notabilityFilter),
        visibility: job.data.visibility === 'world' ? 'world' : 'private',
        ...(typeof job.data.model === 'string' && job.data.model ? { model: job.data.model } : {}),
      },
    ).catch(async (err: unknown) => {
      const { writeFactsAbsorbFailure } = await import('../../facts/absorb-log.ts');
      await writeFactsAbsorbFailure(engine, slug, err, sourceId);
      throw err;
    });
    // Execution-time chat_unavailable in a KEYED worker is config drift —
    // throw (typed) so minion retry/backoff parks it as a VISIBLE, re-runnable
    // failure instead of consuming the job and silently losing the facts. A
    // KEYLESS worker completes the job as a calm skip (its execution-time gate
    // already printed the keyless note; a retry loop would turn every page
    // write into failed-job noise). The retry conversion lives HERE, not in
    // the shared pipeline — the same pipeline serves the extract_facts op,
    // which must return its keyless envelope instead of throwing. The
    // classification runs in the WORKER process (the submitting hook
    // subprocess may have a deliberately neutered env).
    if (factsAbsorbUnavailable(result)) {
      const { classifyUnavailable } = await import('../../facts/backstop.ts');
      const jobModel = typeof job.data.model === 'string' && job.data.model ? job.data.model : undefined;
      if (factsAbsorbShouldRetry(result, await classifyUnavailable(jobModel))) {
        const { FactsExtractionError } = await import('../../facts/extract.ts');
        throw new FactsExtractionError('chat_unavailable', jobModel);
      }
    }
    return result;
  };
}
