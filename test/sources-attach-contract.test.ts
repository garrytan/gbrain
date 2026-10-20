import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSources } from '../src/commands/sources.ts';
import { caught, envelopeFor } from './helpers/agent-envelope.ts';

test('invalid attach source has typed actionable caller error before engine or filesystem work', async () => {
  const previous = process.cwd();
  const root = mkdtempSync(join(tmpdir(), 'source-attach-contract-'));
  const marker = join(root, '.gbrain-source');
  writeFileSync(marker, 'existing-source\n');
  let reads = 0;
  const engine = new Proxy({}, { get() { reads++; throw Error('engine touched'); } });
  try {
    process.chdir(root);
    const err = await caught(() => runSources(engine as never, ['attach', 'INVALID_SOURCE']));
    const envelope = envelopeFor(err, 'stdio');
    expect(envelope.code).toBe('invalid_params');
    expect(envelope.suggestion).toContain('gbrain sources attach');
    expect(envelope.fix?.argv).toEqual(['gbrain', 'sources', 'list', '--json']);
    expect(reads).toBe(0);
    expect(readFileSync(marker, 'utf8')).toBe('existing-source\n');
  } finally {
    process.chdir(previous);
    rmSync(root, { recursive: true, force: true });
  }
});
