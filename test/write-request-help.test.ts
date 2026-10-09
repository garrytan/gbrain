/** #6255 (fix wave 12, W1.4): `gbrain write-request --help` names its routing flags and the receipt states. */
import { expect, test } from 'bun:test';
import { printOpHelp } from '../src/cli/main.ts';
import { operationsByName } from '../src/core/operations.ts';

test('write-request help shows --brain, --json and the pending versus final states', () => {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };
  try { printOpHelp(operationsByName.get_write_request!, 'write-request'); } finally { console.log = log; }
  const help = lines.join('\n');
  expect(help).toContain('gbrain write-request --brain host -- <request_id>');
  expect(help).toContain('--json');
  expect(help).toContain('retry_after_ms');
  for (const state of ['queued', 'running', 'committed', 'conflict', 'failed', 'cancelled']) expect(help).toContain(state);
});
