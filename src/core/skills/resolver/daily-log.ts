/**
 * The resolver's logs under skill-index/logs/: one file per UTC day
 * (`lane-2026-11-10.jsonl`, `resolver-2026-11-10.log`), kept 14 days. The
 * first write of a day deletes that log's files older than that, and the
 * undated file earlier releases wrote. A day stops growing at 2 MB. Lines
 * carry what the callers write (outcomes, codes, durations, scrubbed stack
 * frames), never turn text. Leaf module.
 */
import { appendFileSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { appendFile, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export const DAILY_LOG_KEEP_DAYS = 14;
export const DAILY_LOG_DAY_CAP_BYTES = 2 * 1024 * 1024;

export interface DailyLog { prefix: string; ext: string }
export const LANE_LOG: DailyLog = { prefix: 'lane', ext: '.jsonl' };
export const RESOLVER_LOG: DailyLog = { prefix: 'resolver', ext: '.log' };

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const dailyLogFile = (log: DailyLog, ms: number) => `${log.prefix}-${day(ms)}${log.ext}`;

/** The log's files in `names` that fall out of the window on day `ms`, plus the undated legacy file. */
function expired(log: DailyLog, names: string[], ms: number): string[] {
  const oldest = day(ms - (DAILY_LOG_KEEP_DAYS - 1) * 86_400_000);
  const dayOf = (n: string) => {
    const mid = n.startsWith(`${log.prefix}-`) && n.endsWith(log.ext) ? n.slice(log.prefix.length + 1, -log.ext.length) : null;
    return mid !== null && /^\d{4}-\d{2}-\d{2}$/.test(mid) ? mid : '9999';
  };
  return names.filter(n => n === `${log.prefix}${log.ext}` || dayOf(n) < oldest);
}

export async function appendDailyLog(dir: string, log: DailyLog, line: string, now = Date.now()): Promise<void> {
  const p = join(dir, dailyLogFile(log, now));
  let size = -1;
  try { size = (await stat(p)).size; } catch { /* first write today */ }
  if (size >= DAILY_LOG_DAY_CAP_BYTES) return;
  if (size < 0) for (const n of expired(log, await readdir(dir).catch(() => []), now)) await unlink(join(dir, n)).catch(() => {});
  await appendFile(p, line, { mode: 0o600 });
}

export function appendDailyLogSync(dir: string, log: DailyLog, line: string, now = Date.now()): void {
  const p = join(dir, dailyLogFile(log, now));
  let size = -1;
  try { size = statSync(p).size; } catch { /* first write today */ }
  if (size >= DAILY_LOG_DAY_CAP_BYTES) return;
  if (size < 0) {
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { /* none */ }
    for (const n of expired(log, names, now)) { try { unlinkSync(join(dir, n)); } catch { /* gone */ } }
  }
  appendFileSync(p, line, { mode: 0o600 });
}

/** The last `maxBytes` of today's and yesterday's files, oldest first ('' when there are none). */
export function readRecentDailyLog(dir: string, log: DailyLog, maxBytes: number, now = Date.now()): string | null {
  const parts: string[] = [];
  for (const ms of [now - 86_400_000, now]) {
    try { parts.push(readFileSync(join(dir, dailyLogFile(log, ms)), 'utf8')); } catch { /* none that day */ }
  }
  if (!parts.length) return null;
  const text = parts.join('');
  return text.length > maxBytes ? text.slice(-maxBytes) : text;
}
