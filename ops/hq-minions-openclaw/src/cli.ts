#!/usr/bin/env bun
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { loadAppConfig } from './config.ts';
import { runDoctor } from './doctor.ts';
import { arr, bool, num, parseArgs, str } from './args.ts';
import { createQueue, requireJobId } from './gbrain.ts';
import { idempotencyKey, toJobData, WorkItemSchema } from './domain.ts';
import { board, listWorkItems } from './reporting.ts';
import { boardMarkdown, jobMarkdown } from './format.ts';
import { isOperatorError, OperatorError } from './errors.ts';
import { log } from './log.ts';

function help(): void {
  console.log(`hq-minions-openclaw

Usage:
  bun src/cli.ts doctor [--json]
  bun src/cli.ts health [--json]
  bun src/cli.ts create-work-item --project <id> --title <title> [--run-now] [--json]
  bun src/cli.ts list-work-items [--project <id>] [--workstream <id>] [--status <status>] [--limit <n>] [--json]
  bun src/cli.ts get-work-item <id> [--json]
  bun src/cli.ts hold-work-item <id> [--json]
  bun src/cli.ts resume-work-item <id> [--json]
  bun src/cli.ts cancel-work-item <id> [--json]
  bun src/cli.ts retry-work-item <id> [--json]
  bun src/cli.ts add-note <id> --message <text> [--json]
  bun src/cli.ts attach-file <id> --path <file> [--content-type <type>] [--json]
  bun src/cli.ts board [--project <id>] [--json]
`);
}

function out(value: unknown, json: boolean): void {
  if (json) console.log(JSON.stringify(value, null, 2));
  else if (typeof value === 'string') console.log(value);
  else console.log(JSON.stringify(value, null, 2));
}

async function withQueue<T>(fn: (queue: Awaited<ReturnType<typeof createQueue>>['queue']) => Promise<T>): Promise<T> {
  const config = loadAppConfig();
  const { engine, queue } = await createQueue(config);
  try {
    return await fn(queue);
  } finally {
    await engine.disconnect().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const parsed = parseArgs(Bun.argv.slice(2));
  const json = bool(parsed.flags, 'json', false);

  if (parsed.command === 'help' || parsed.command === '--help' || parsed.command === '-h') {
    help();
    return;
  }

  if (parsed.command === 'doctor') {
    const result = await runDoctor(loadAppConfig());
    out(result, json);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (parsed.command === 'health') {
    await withQueue(async queue => {
      const stats = await queue.getStats();
      out({ ok: true, stats }, json);
    });
    return;
  }

  await withQueue(async queue => {
    switch (parsed.command) {
      case 'create-work-item': {
        const projectId = str(parsed.flags, 'project');
        const title = str(parsed.flags, 'title');
        if (!projectId) throw new OperatorError('missing_project', 'Missing --project.');
        if (!title) throw new OperatorError('missing_title', 'Missing --title.');

        const config = loadAppConfig();
        const input = WorkItemSchema.parse({
          projectId,
          title,
          workstreamId: str(parsed.flags, 'workstream', 'default'),
          owner: str(parsed.flags, 'owner'),
          requester: str(parsed.flags, 'requester'),
          labels: arr(parsed.flags, 'label'),
          acceptanceCriteria: arr(parsed.flags, 'acceptance'),
          priority: num(parsed.flags, 'priority', 100),
          queue: config.queue,
          runNow: bool(parsed.flags, 'run-now', false),
          idempotencyKey: str(parsed.flags, 'idempotency-key'),
          timeoutMs: str(parsed.flags, 'timeout-ms') ? num(parsed.flags, 'timeout-ms', 0) : undefined
        });

        const job = await queue.add('hq.pm.work_item.v1', toJobData(input), {
          queue: input.queue,
          priority: input.priority,
          max_attempts: 3,
          idempotency_key: idempotencyKey(input),
          timeout_ms: input.timeoutMs
        });

        const finalJob = input.runNow ? job : await queue.pauseJob(Number(job.id));
        out(finalJob ?? job, json);
        return;
      }

      case 'list-work-items': {
        const rows = await listWorkItems(queue, {
          project: str(parsed.flags, 'project'),
          workstream: str(parsed.flags, 'workstream'),
          owner: str(parsed.flags, 'owner'),
          status: str(parsed.flags, 'status'),
          limit: num(parsed.flags, 'limit', 100)
        });
        out(rows, json);
        return;
      }

      case 'get-work-item': {
        const id = requireJobId(parsed.positionals[0]);
        const job = await queue.getJob(id);
        if (!job) throw new OperatorError('not_found', `Job ${id} not found.`, 2);
        const attachments = await queue.listAttachments(id);
        out(json ? { job, attachments } : jobMarkdown({ job, attachments }), json);
        return;
      }

      case 'hold-work-item': {
        const id = requireJobId(parsed.positionals[0]);
        const job = await queue.pauseJob(id);
        if (!job) throw new OperatorError('pause_failed', `Job ${id} could not be paused.`, 2);
        out(job, json);
        return;
      }

      case 'resume-work-item': {
        const id = requireJobId(parsed.positionals[0]);
        const job = await queue.resumeJob(id);
        if (!job) throw new OperatorError('resume_failed', `Job ${id} could not be resumed.`, 2);
        out(job, json);
        return;
      }

      case 'cancel-work-item': {
        const id = requireJobId(parsed.positionals[0]);
        const job = await queue.cancelJob(id);
        if (!job) throw new OperatorError('cancel_failed', `Job ${id} could not be cancelled.`, 2);
        out(job, json);
        return;
      }

      case 'retry-work-item': {
        const id = requireJobId(parsed.positionals[0]);
        const job = await queue.retryJob(id);
        if (!job) throw new OperatorError('retry_failed', `Job ${id} could not be retried.`, 2);
        out(job, json);
        return;
      }

      case 'add-note': {
        const id = requireJobId(parsed.positionals[0]);
        const message = str(parsed.flags, 'message');
        if (!message) throw new OperatorError('missing_message', 'Missing --message.');
        const note = await queue.sendMessage(id, {
          type: 'operator_note',
          body: message,
          created_at: new Date().toISOString()
        }, 'admin');
        if (!note) throw new OperatorError('note_failed', `Could not add note to job ${id}.`, 2);
        out(note, json);
        return;
      }

      case 'attach-file': {
        const id = requireJobId(parsed.positionals[0]);
        const path = str(parsed.flags, 'path');
        if (!path) throw new OperatorError('missing_path', 'Missing --path.');
        const bytes = await readFile(path);
        const attachment = await queue.addAttachment(id, {
          filename: basename(path),
          content_type: str(parsed.flags, 'content-type', 'application/octet-stream'),
          content_base64: bytes.toString('base64')
        });
        out(attachment, json);
        return;
      }

      case 'board': {
        const b = await board(queue, {
          project: str(parsed.flags, 'project'),
          workstream: str(parsed.flags, 'workstream'),
          owner: str(parsed.flags, 'owner'),
          limit: num(parsed.flags, 'limit', 500)
        });
        out(json ? b : boardMarkdown(b), json);
        return;
      }

      default:
        throw new OperatorError('unknown_command', `Unknown command: ${parsed.command}`, 2);
    }
  });
}

main().catch((error) => {
  if (isOperatorError(error)) {
    log('error', error.message, { code: error.code, details: error.details });
    console.error(`${error.code}: ${error.message}`);
    process.exit(error.status);
  }

  log('error', 'Unhandled CLI failure.', {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined
  });
  console.error(error);
  process.exit(1);
});
