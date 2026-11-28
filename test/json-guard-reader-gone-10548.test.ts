/**
 * #10548: when the reader of a `--json` run closes the pipe, the EPIPE handler exits 0 before the command writes its
 * document. The guard read that as a command that printed no document and logged json_document_missing, so doctor's
 * agent_contract warned for 7 days. A closed pipe is the reader's choice, not a command bug: nothing is logged. A
 * command that exits 0 with no document and no closed pipe is still logged (the control case).
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CORE = join(import.meta.dir, '..', 'src', 'core');

async function run(body: string): Promise<{ stderr: string; exitCode: number }> {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-10548-'));
  const script = join(dir, 'run.ts');
  writeFileSync(script, [
    `import { installStdoutPipeDelivery, setJsonDocumentMissingHook } from ${JSON.stringify(join(CORE, 'cli-force-exit.ts'))};`,
    `import { installSignalHandlers } from ${JSON.stringify(join(CORE, 'process-cleanup.ts'))};`,
    `import { writeSync } from 'node:fs';`,
    `installStdoutPipeDelivery({ json: 'document' });`,
    `setJsonDocumentMissingHook(() => writeSync(2, 'JSON_DOCUMENT_MISSING\\n'));`,
    `installSignalHandlers();`,
    body,
  ].join('\n'));
  try {
    const proc = Bun.spawn([process.execPath, script], { stdout: 'pipe', stderr: 'pipe' });
    const [stderr, , exitCode] = await Promise.all([new Response(proc.stderr).text(), new Response(proc.stdout).text(), proc.exited]);
    return { stderr, exitCode };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('--json guard and a closed pipe (#10548)', () => {
  test('an EPIPE on stdout exits 0 without logging json_document_missing', async () => {
    const r = await run(`process.stdout.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));\nsetTimeout(() => process.exit(0), 5000);`);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).not.toContain('JSON_DOCUMENT_MISSING');
  }, 30_000);

  test('an EPIPE on stderr exits 0 without logging json_document_missing', async () => {
    const r = await run(`process.stderr.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));\nsetTimeout(() => process.exit(0), 5000);`);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).not.toContain('JSON_DOCUMENT_MISSING');
  }, 30_000);

  test('control: exit 0 with no document and an open pipe is still logged', async () => {
    const r = await run('process.exit(0);');
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain('JSON_DOCUMENT_MISSING');
  }, 30_000);
});
