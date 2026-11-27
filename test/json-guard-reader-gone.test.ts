import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CORE = join(import.meta.dir, '..', 'src', 'core');

describe('--json guard when the reader closes the pipe', () => {
  test('an EPIPE exit is not recorded as json_document_missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-reader-gone-'));
    const script = join(dir, 'run.ts');
    writeFileSync(script, `import * as g from ${JSON.stringify(join(CORE, 'cli-force-exit.ts'))};
import { installSignalHandlers } from ${JSON.stringify(join(CORE, 'process-cleanup.ts'))};
import { writeSync } from 'node:fs';
g.installStdoutPipeDelivery({ json: 'document' });
g.setJsonDocumentMissingHook(() => writeSync(2, 'HOOK_FIRED\\n'));
installSignalHandlers();
process.stdout.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
setTimeout(() => process.exit(0), 2000);`);
    try {
      const proc = Bun.spawn([process.execPath, script], { stdout: 'pipe', stderr: 'pipe' });
      const [err] = await Promise.all([new Response(proc.stderr).text(), new Response(proc.stdout).text(), proc.exited]);
      expect(err).not.toContain('HOOK_FIRED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
