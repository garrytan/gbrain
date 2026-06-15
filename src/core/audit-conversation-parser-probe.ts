/**
 * Nightly conversation-parser probe audit trail.
 *
 * Writes one event per probe run to
 * `~/.gbrain/audit/conversation-parser-probe-YYYY-Www.jsonl`.
 * Mirrors the nightly quality probe audit style: ISO-week rotation,
 * best-effort writes, and silent skip of corrupt rows on read.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveAuditDir } from './minions/handlers/shell-audit.ts';
import type { NightlyProbeResult, ProbeOutcome } from './conversation-parser/nightly-probe.ts';

export type ConversationParserProbeOutcome = ProbeOutcome;

export interface ConversationParserProbeAuditEvent {
  ts: string;
  schema_version: 1;
  outcome: ConversationParserProbeOutcome;
  fixtures_total: number;
  fixtures_passed: number;
  recall_mean: number;
  participants_recall_mean: number;
  adversarial_false_positives: number;
  failed_fixture_ids: string[];
  reason?: string;
}

export function computeConversationParserProbeAuditFilename(now: Date = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayNum = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dayNum + 3);
  const isoYear = d.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstThursdayDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstThursdayDayNum + 3);
  const weekNum = Math.round((d.getTime() - firstThursday.getTime()) / (7 * 86400000)) + 1;
  return `conversation-parser-probe-${isoYear}-W${String(weekNum).padStart(2, '0')}.jsonl`;
}

export function logConversationParserProbeEvent(result: NightlyProbeResult): void {
  const event: ConversationParserProbeAuditEvent = {
    ts: result.ts,
    schema_version: 1,
    outcome: result.outcome,
    fixtures_total: result.fixtures_total,
    fixtures_passed: result.fixtures_passed,
    recall_mean: result.recall_mean,
    participants_recall_mean: result.participants_recall_mean,
    adversarial_false_positives: result.adversarial_false_positives,
    failed_fixture_ids: result.failed_fixture_ids,
    ...(result.reason !== undefined ? { reason: result.reason } : {}),
  };
  const dir = resolveAuditDir();
  const file = path.join(dir, computeConversationParserProbeAuditFilename(new Date(result.ts)));
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(file, JSON.stringify(event) + '\n', { encoding: 'utf8' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[gbrain] conversation-parser-probe audit write failed (${msg}); probe continues\n`);
  }
}

export function readRecentConversationParserProbeEvents(
  days = 7,
  now: Date = new Date(),
): ConversationParserProbeAuditEvent[] {
  const dir = resolveAuditDir();
  const cutoff = now.getTime() - days * 86400000;
  const out: ConversationParserProbeAuditEvent[] = [];
  const filenames = [
    computeConversationParserProbeAuditFilename(now),
    computeConversationParserProbeAuditFilename(new Date(now.getTime() - 7 * 86400000)),
  ];
  for (const filename of filenames) {
    const file = path.join(dir, filename);
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of content.split('\n')) {
      if (line.length === 0) continue;
      try {
        const ev = JSON.parse(line) as ConversationParserProbeAuditEvent;
        const ts = Date.parse(ev.ts);
        if (Number.isFinite(ts) && ts >= cutoff) out.push(ev);
      } catch {
        // corrupt row: skip
      }
    }
  }
  return out;
}

export function conversationParserProbeRanWithin24h(now: Date = new Date()): boolean {
  const events = readRecentConversationParserProbeEvents(2, now);
  const cutoff = now.getTime() - 24 * 60 * 60 * 1000;
  return events.some((ev) => {
    const ts = Date.parse(ev.ts);
    return Number.isFinite(ts) && ts >= cutoff;
  });
}
