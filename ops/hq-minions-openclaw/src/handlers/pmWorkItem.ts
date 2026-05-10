import { z } from 'zod';

const PayloadSchema = z.object({
  tracker_role: z.literal('work_item'),
  schema_version: z.literal(1),
  project_id: z.string(),
  workstream_id: z.string(),
  title: z.string(),
  owner: z.string().nullable().optional(),
  requester: z.string().nullable().optional(),
  labels: z.array(z.string()).default([]),
  acceptance_criteria: z.array(z.string()).default([]),
  source: z.string(),
  created_by: z.string(),
  created_at: z.string()
}).passthrough();

type HandlerContext = {
  id: number;
  name: string;
  data: Record<string, unknown>;
  signal: AbortSignal;
  shutdownSignal: AbortSignal;
  updateProgress(progress: unknown): Promise<void>;
  log(message: string | Record<string, unknown>): Promise<void>;
  readInbox(): Promise<Array<Record<string, unknown>>>;
};

export async function pmWorkItemHandler(ctx: HandlerContext): Promise<Record<string, unknown>> {
  const parsed = PayloadSchema.safeParse(ctx.data);
  if (!parsed.success) {
    throw new Error(`Invalid PM work-item payload: ${parsed.error.message}`);
  }

  if (ctx.signal.aborted) {
    throw new Error('Job aborted before handler start.');
  }

  await ctx.updateProgress({
    summary: 'PM work item payload validated.',
    percent: 25,
    blockers: [],
    next_step: 'read operator inbox',
    updated_by: 'hq.pm.work_item.v1',
    updated_at: new Date().toISOString()
  });

  const messages = await ctx.readInbox();

  await ctx.log({
    type: 'log',
    message: `Validated PM work item ${ctx.id}; inbox messages read=${messages.length}`,
    ts: new Date().toISOString()
  });

  await ctx.updateProgress({
    summary: 'PM work item processed by local handler.',
    percent: 100,
    blockers: [],
    next_step: 'operator review',
    updated_by: 'hq.pm.work_item.v1',
    updated_at: new Date().toISOString()
  });

  return {
    ok: true,
    handler: 'hq.pm.work_item.v1',
    job_id: ctx.id,
    project_id: parsed.data.project_id,
    workstream_id: parsed.data.workstream_id,
    title: parsed.data.title,
    inbox_messages_read: messages.length,
    completed_at: new Date().toISOString()
  };
}
