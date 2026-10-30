/** Shared archive/hook admission for Codex's overlapping assistant encodings. */
import type { CodexLineResult } from './codex.ts';

export class CodexMessageFilter {
  private turnId: string | undefined;
  private previous: { role: string; text: string } | undefined;
  private readonly items = new Set<string>();
  private readonly occurrences = new Map<string, Map<string, number>>();

  /** Observe every mapped row, including turn starts; true admits a text turn. */
  accept(row: CodexLineResult): boolean {
    if ('turnId' in row && row.turnId && row.turnId !== this.turnId) {
      // Some old rollouts lack task_started. The first explicit turn id merely
      // labels the current turn; a changed id starts a fresh occurrence scope.
      if (this.turnId !== undefined || row.kind === 'turn_start') this.reset();
      this.turnId = row.turnId;
    }
    if (row.kind === 'turn_start') return false;
    if (row.kind === 'user') {
      if (this.previous?.role === 'user' && this.previous.text === row.message.text) return false;
      this.reset();
      this.turnId = row.turnId;
      this.previous = row.message;
      return true;
    }
    if (row.kind !== 'assistant') return false;
    const encoding = row.encoding;
    if (row.messageId) {
      const key = `${encoding}:${row.messageId}`;
      if (this.items.has(key)) return false;
      this.items.add(key);
    }
    const counts = this.occurrences.get(row.message.text) ?? new Map<string, number>();
    const maximum = Math.max(0, ...counts.values());
    // last_agent_message is a terminal echo, not another occurrence. Repeated
    // task_complete records must never manufacture additional assistant turns.
    const count = encoding === 'terminal' ? 1 : (counts.get(encoding) ?? 0) + 1;
    counts.set(encoding, count);
    this.occurrences.set(row.message.text, counts);
    if (count <= maximum) return false;
    this.previous = row.message;
    return true;
  }

  private reset(): void {
    this.previous = undefined;
    this.items.clear();
    this.occurrences.clear();
  }
}
