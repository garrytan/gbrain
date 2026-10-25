/** Host-owned review gate. Runs after canonical parsing/redaction, before any record write. */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { chatgptExportAdapter } from '../transcripts/chatgpt-export.ts';
import { claudeExportAdapter } from '../transcripts/claude-export.ts';
import { redactSession } from '../transcripts/render.ts';
import type { ConnectorProviderName } from './types.ts';

export type ReviewVerdict = 'keep' | 'noise' | 'unsure';
export function reviewCommand(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  let argv: unknown;
  try { argv = JSON.parse(raw); } catch { throw new Error('connector_review_command_invalid'); }
  if (!Array.isArray(argv) || !argv.length || !argv.every(x => typeof x === 'string' && x.length > 0)
      || !isAbsolute(argv[0])) throw new Error('connector_review_command_invalid');
  return argv;
}

export async function reviewConnectorBatch(path: string, provider: ConnectorProviderName, sourceId: string,
  argv: string[], execute = spawnSync): Promise<Map<string, ReviewVerdict>> {
  const adapter = provider === 'chatgpt' ? chatgptExportAdapter : claudeExportAdapter;
  const answers = new Map<string, ReviewVerdict>();
  const iterator = adapter.parse(path);
  while (true) {
    const next = await iterator.next();
    if (next.done) {
      if (next.value.truncated || next.value.skippedLines) throw new Error('connector_review_parse_incomplete');
      break;
    }
    const session = redactSession(next.value).session;
    const request = JSON.stringify({ schema: 'gbrain-connector-review-input/v1', provider, source_id: sourceId,
      session_id: session.meta.sessionId, title: session.meta.title ?? '', messages: session.messages });
    const hash = createHash('sha256').update(request).digest('hex');
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
      !/COOKIE|TOKEN|PASSWORD|SECRET|API_KEY|AUTHORIZATION|DATABASE_URL/i.test(k)));
    const child = execute(argv[0], argv.slice(1), { input: request, encoding: 'utf8', env, timeout: 120_000, maxBuffer: 65536 });
    let verdict: ReviewVerdict = 'unsure';
    if (child.status === 0 && !child.error) {
      try {
        const value = JSON.parse(String(child.stdout));
        if (value.schema === 'gbrain-connector-review-output/v1' && value.input_sha256 === hash
            && ['keep', 'noise', 'unsure'].includes(value.verdict)) verdict = value.verdict;
      } catch { /* No child output is echoed: it can contain untrusted text. */ }
    }
    if (answers.has(session.meta.sessionId)) throw new Error('connector_review_duplicate_session');
    answers.set(session.meta.sessionId, verdict);
  }
  return answers;
}
