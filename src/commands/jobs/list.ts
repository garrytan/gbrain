/** `gbrain jobs list` (dispatched by runJobs in src/commands/jobs.ts). */
import { formatJob, hasFlag, parseFlag, rehydrateJobDates, type JobsCommandContext } from './shared.ts';
import type { MinionJob, MinionJobStatus } from '../../core/minions/types.ts';
import { isThinClient, loadConfig } from '../../core/config.ts';
import { callRemoteTool, unpackToolResult } from '../../core/mcp-client.ts';
import { describeJobs, insightCell, withInsight, type JobInsight } from '../../core/minions/job-insight.ts';

export async function runJobsList({ args, queue, engine }: JobsCommandContext): Promise<void> {
  const groupId = parseFlag(args, '--group');
  if (groupId !== undefined) return listSpendGroup(engine, groupId, hasFlag(args, '--json'));
  const status = parseFlag(args, '--status') as MinionJobStatus | undefined;
  const queueName = parseFlag(args, '--queue');
  const limit = parseInt(parseFlag(args, '--limit') ?? '20', 10);
  const finishedSince = parseFlag(args, '--finished-since');
  if (finishedSince !== undefined) return listFinishedSince(engine, finishedSince, { queue: queueName, name: parseFlag(args, '--name'), limit }, hasFlag(args, '--json'));

  // v0.32: thin-client routing. The `list_jobs` MCP op is admin-scoped
  // but not localOnly, so a thin-client install with admin access can
  // see the remote brain's job queue. Without this branch we'd query
  // the empty local PGLite and report "No jobs found" for an actively-
  // running host brain.
  const cfg = loadConfig();
  let jobs: MinionJob[];
  if (isThinClient(cfg)) {
    jobs = await listRemoteJobs(cfg!, { status, queue: queueName, limit });
  } else {
    try { await queue.ensureSchema(); }
    catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); }
    jobs = await queue.getJobs({ status, queue: queueName, limit });
    const insight = await describeJobs(engine, jobs);
    jobs = jobs.map(j => withInsight(j, insight.get(j.id)));
  }

  // #3685: --json emits the machine-readable array the CHANGELOG's
  // scripting guidance promises (before this guard the flag was accepted
  // and silently discarded — scripts got the padded ASCII table). Guard
  // sits BEFORE the empty-check so an empty queue emits `[]`, not prose.
  if (hasFlag(args, '--json')) {
    console.log(JSON.stringify(jobs, null, 2));
    return;
  }

  if (jobs.length === 0) {
    console.log('No jobs found.');
    return;
  }

  console.log(`  ${'ID'.padEnd(6)} ${'Name'.padEnd(14)} ${'Status'.padEnd(20)} ${'Queue'.padEnd(10)} ${'Time'.padEnd(8)} ${'Created'.padEnd(19)} Wait/Live`);
  console.log('  ' + '─'.repeat(100));
  for (const job of jobs) console.log(`${formatJob(job)} ${insightCell(job, job as MinionJob & JobInsight)}`.trimEnd());
  console.log(`\n  ${jobs.length} jobs shown`);
}

/**
 * The host returns at most one page per call (500 jobs over MCP); follow next_cursor, carried on the last job of a
 * cut page, until the requested limit is met. A host without paging returns one page and no cursor.
 */
async function listRemoteJobs(cfg: NonNullable<ReturnType<typeof loadConfig>>, opts: { status?: string; queue?: string; limit: number }): Promise<MinionJob[]> {
  const jobs: MinionJob[] = [];
  let cursor: string | undefined;
  do {
    const raw = await callRemoteTool(cfg, 'list_jobs', { ...opts, limit: opts.limit - jobs.length, ...(cursor ? { cursor } : {}) }, { timeoutMs: 30_000 });
    const page = unpackToolResult<Array<MinionJob & { truncated?: boolean; next_cursor?: string }>>(raw);
    cursor = page[page.length - 1]?.next_cursor;
    for (const { truncated: _t, next_cursor: _c, ...job } of page) jobs.push(rehydrateJobDates(job as MinionJob));
  } while (cursor && jobs.length < opts.limit);
  return jobs;
}

/**
 * `jobs list --finished-since <iso|cursor>` (#7242): every job that reached a terminal status after the cursor, oldest
 * first, as one `{jobs, next_cursor}` document; pass next_cursor back to read the next events.
 */
async function listFinishedSince(engine: JobsCommandContext['engine'], since: string, opts: { queue?: string; name?: string; limit: number }, json: boolean): Promise<void> {
  const cfg = loadConfig();
  let page: { jobs: MinionJob[]; next_cursor: string };
  if (isThinClient(cfg)) {
    const raw = await callRemoteTool(cfg!, 'list_jobs', { finished_since: since, queue: opts.queue, name: opts.name, limit: opts.limit }, { timeoutMs: 30_000 });
    const doc = unpackToolResult<{ jobs: MinionJob[]; next_cursor: string }>(raw);
    page = { jobs: doc.jobs.map(j => rehydrateJobDates(j)), next_cursor: doc.next_cursor };
  } else {
    const { listFinishedSince: read, TerminalCursorError } = await import('../../core/minions/terminal-events.ts');
    try { page = await read(engine, since, opts); }
    catch (e) {
      if (!(e instanceof TerminalCursorError)) throw e;
      console.error(`Error: --finished-since: ${e.message}`);
      process.exit(2);
    }
    const insight = await describeJobs(engine, page.jobs);
    page = { ...page, jobs: page.jobs.map(j => withInsight(j, insight.get(j.id))) };
  }
  if (json) { console.log(JSON.stringify(page, null, 2)); return; }
  for (const job of page.jobs) console.log(`${formatJob(job)} ${job.finished_at instanceof Date ? job.finished_at.toISOString() : ''}`);
  console.log(`\n  ${page.jobs.length} finished jobs. Next: gbrain jobs list --finished-since ${page.next_cursor}`);
}

/** `jobs list --group <id>`: one spend group's record, amounts and member jobs. */
async function listSpendGroup(engine: JobsCommandContext['engine'], groupId: string, json: boolean): Promise<void> {
  const { groupJobs, jobGroupAmounts } = await import('../../core/minions/spend-authorization.ts');
  const jobs = await groupJobs(engine, groupId);
  const record = jobs[0]?.spend_authorization ?? null;
  const amounts = record ? await jobGroupAmounts(engine, record) : null;
  const doc = {
    group_id: groupId,
    ...(record ? { command: record.command, kind: record.kind, cap_usd: record.cap_usd, cap_source: record.cap_source, uncapped: record.uncapped === true } : {}),
    ...(amounts ? { spent_usd: amounts.spent_usd, reserved_usd: amounts.reserved_usd, overdue_usd: amounts.overdue_usd, remaining_usd: amounts.remaining_usd } : {}),
    jobs: jobs.map(j => ({ id: j.id, name: j.name, status: j.status, error_text: j.error_text })),
    cancel_argv: ['gbrain', 'jobs', 'cancel', '--group', groupId],
  };
  if (json) { console.log(JSON.stringify(doc, null, 2)); return; }
  if (!jobs.length) { console.log(`No jobs in spend group ${groupId}.`); return; }
  console.log(`Spend group ${groupId}: ${record!.command}, ${record!.uncapped ? 'uncapped' : `$${record!.cap_usd!.toFixed(2)} ${record!.cap_source} cap`}`
    + (amounts ? `; spent $${amounts.spent_usd.toFixed(2)}, reserved $${amounts.reserved_usd.toFixed(2)}${amounts.remaining_usd === null ? '' : `, remaining $${amounts.remaining_usd.toFixed(2)}`}` : ''));
  for (const job of jobs) console.log(formatJob(job));
  console.log(`\n  ${jobs.length} jobs. Cancel the unfinished ones with: gbrain jobs cancel --group ${groupId}`);
}
