import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { z } from 'zod';
import { OperatorError } from './errors.ts';

const ConfigSchema = z.object({
  databaseUrl: z.string().min(1),
  queue: z.string().min(1).default('hq'),
  concurrency: z.number().int().min(1).max(32).default(2),
  pollIntervalMs: z.number().int().min(100).max(60000).default(1000),
  maxAttachmentBytes: z.number().int().min(1).default(5 * 1024 * 1024),
  gbrainBin: z.string().min(1).default('gbrain')
});

export type AppConfig = z.infer<typeof ConfigSchema>;

function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function loadGbrainConfigUrl(): string | undefined {
  const path = resolve(homedir(), '.gbrain', 'config.json');
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    return typeof parsed.database_url === 'string' ? parsed.database_url : undefined;
  } catch {
    return undefined;
  }
}

export function loadAppConfig(): AppConfig {
  const databaseUrl =
    process.env.GBRAIN_DATABASE_URL ||
    process.env.DATABASE_URL ||
    loadGbrainConfigUrl();

  if (!databaseUrl) {
    throw new OperatorError(
      'missing_database_url',
      'Missing database URL. Set GBRAIN_DATABASE_URL or DATABASE_URL, or run gbrain init --url first.'
    );
  }

  const parsed = ConfigSchema.safeParse({
    databaseUrl,
    queue: process.env.HQ_MINIONS_QUEUE || 'hq',
    concurrency: numberEnv('HQ_MINIONS_CONCURRENCY', 2),
    pollIntervalMs: numberEnv('HQ_MINIONS_POLL_INTERVAL_MS', 1000),
    maxAttachmentBytes: numberEnv('HQ_MAX_ATTACHMENT_BYTES', 5 * 1024 * 1024),
    gbrainBin: process.env.GBRAIN_BIN || 'gbrain'
  });

  if (!parsed.success) {
    throw new OperatorError('invalid_config', 'Invalid hq-minions-openclaw config.', 1, parsed.error.flatten());
  }

  return parsed.data;
}
