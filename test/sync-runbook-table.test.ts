/**
 * #6340: the runbook's decision table and the classifier are one table. The
 * Markdown between the `sync-fault-table` markers in
 * docs/guides/sync-unblock-runbook.md must list exactly the codes
 * `SYNC_FAULT_TABLE` knows, with the same class, safe actions, needs-human and
 * escalation text, so an operator model reading the doc and a program calling
 * `classifySyncFault` reach the same decision.
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SYNC_FAULT_TABLE } from '../src/core/persistence/sync-fault-class.ts';

test('docs/guides/sync-unblock-runbook.md renders SYNC_FAULT_TABLE verbatim', () => {
  const doc = readFileSync(join(import.meta.dir, '..', 'docs', 'guides', 'sync-unblock-runbook.md'), 'utf8');
  const block = doc.split('<!-- sync-fault-table:begin')[1]?.split('<!-- sync-fault-table:end -->')[0];
  expect(block).toBeDefined();
  const rows = block!.split('\n').filter(line => line.startsWith('| `')).map(line => {
    const cells = line.split('|').slice(1, -1).map(cell => cell.trim());
    return { code: cells[0]!.replace(/`/g, ''), class: cells[1], safe_actions: cells[2]!.split(',').map(s => s.trim()), needs_human: cells[3] === 'yes', escalate: cells[4] };
  });
  const expected = SYNC_FAULT_TABLE.map(rule => ({ code: rule.code, class: rule.class, safe_actions: [...rule.safe_actions], needs_human: rule.needs_human, escalate: rule.escalate }));
  expect(rows).toEqual(expected);
});
