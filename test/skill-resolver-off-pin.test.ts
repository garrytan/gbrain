/**
 * GBRA-377: with the skill resolver off, plain `gbrain setup claude-code`
 * and `setup codex` write byte-identical files, and every UserPromptSubmit
 * hook they wire prints byte-identical output, compared with master before
 * the resolver existed. The golden holds a sha256 per file and the full
 * hook output. Machine and clock parts are normalized in
 * test/helpers/skill-resolver-off-capture.ts, which also says how to
 * regenerate the golden.
 */
import { expect, setDefaultTimeout, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { captureResolverOff } from './helpers/skill-resolver-off-capture.ts';

setDefaultTimeout(120_000);

test('resolver off: setup files and user-prompt hook output match the pre-resolver golden byte for byte', async () => {
  const golden = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'goldens', 'skill-resolver', 'off-pin.json'), 'utf8'));
  const now = await captureResolverOff(join(import.meta.dir, '..', 'src', 'cli.ts'));
  expect(now).toEqual(golden);
});
