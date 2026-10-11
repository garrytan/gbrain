import { z } from 'zod';

export const RunStatusSchema = z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']);
export const TaskProductProgressSchema = z.object({
  relations: z.object({ total: z.number().int().nonnegative(), available: z.boolean() }).optional(),
  gitResults: z.array(z.object({ sourceId: z.string(), committed: z.boolean(), commit: z.string().nullable(), files: z.array(z.string()), pending: z.array(z.object({path:z.string(),reason:z.string()})), error:z.string().optional() })).optional(),
  activeFiles: z.array(z.object({
    id:z.number().int().positive(), sourceId:z.string(),path:z.string(),bytes:z.number().nonnegative(),stage:z.string(),updatedAt:z.string(),
    operation:z.string().optional(),operationStartedAt:z.string().optional(),chunksTotal:z.number().nonnegative().optional(),
    bodyWritten:z.number().nonnegative().optional(),bodyCommitted:z.boolean().optional(),bodyBatchesCompleted:z.number().nonnegative().optional(),bodyBatchesTotal:z.number().nonnegative().optional(),generated:z.number().nonnegative().optional(),
    embedded:z.number().nonnegative().optional(),reused:z.number().nonnegative().optional(),pending:z.number().nonnegative().optional(),
    batchesCompleted:z.number().nonnegative().optional(),noEmbed:z.boolean().optional(),
  })).optional(),
  syncScan: z.object({ scanned: z.number().int().nonnegative(), unchanged: z.number().int().nonnegative(),total:z.number().int().nonnegative().optional(),
    path:z.string().optional(),bytes:z.number().nonnegative().optional(),updatedAt:z.string().optional(),active:z.boolean().optional() }).optional(),
  syncFiles: z.object({ total: z.number().int().nonnegative(), completed: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), remaining: z.number().int().nonnegative() }).optional(),
  name: z.string(), stage: z.string(), percent: z.number().min(0).max(100).nullable(),
  phasePercent: z.number().min(0).max(100).nullable(), completedSteps: z.number().int().nonnegative(),
  steps: z.array(z.object({ id: z.string(), label: z.string(), status: z.enum(['pending', 'running', 'completed', 'skipped', 'failed']), phases: z.array(z.string()) })),
  processed: z.number().nullable(), total: z.number().nullable(), file: z.string().nullable(),
  metrics: z.array(z.object({ label: z.string(), value: z.number() })), errorReason: z.string().nullable(),
  detail: z.string().nullable().optional(),
  material: z.object({ name: z.string(), sourceId: z.string(), directory: z.boolean(), page: z.object({ slug: z.string(), title: z.string(), type: z.string() }).optional() }).optional(),
  scope: z.object({ name: z.string(), index: z.number().int().nonnegative(), total: z.number().int().positive() }).optional(),
});

export const RunAcceptedResponseSchema = z.object({
  runId: z.string().min(1),
  status: RunStatusSchema,
}).passthrough();

export const ConsoleRunSchema = z.object({
  id: z.string(),
  kind: z.string(),
  trigger: z.enum(['manual', 'scheduled']).optional(),
  status: RunStatusSchema,
  command: z.array(z.string()),
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().int().nullable(),
  error: z.string().nullable(),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  durationMs: z.number().nullable(),
  result: z.unknown().optional(),
  product: TaskProductProgressSchema.optional(),
}).passthrough();

export type RunAcceptedResponse = z.infer<typeof RunAcceptedResponseSchema>;
export type ConsoleRun = z.infer<typeof ConsoleRunSchema>;
