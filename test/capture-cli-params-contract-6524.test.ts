/**
 * #6524: `gbrain capture` was dead on every brain with a running `gbrain
 * serve` and on every thin client. The CLI sends its provenance trio
 * (`source_kind`, `source_uri`, `ingested_via`; #5622) and dispatch rejects
 * every undeclared key on a write (#5970), so the two transports that go
 * through dispatch (resident-owner IPC, thin-client HTTP) refused with
 * "3 unknown parameters" while the direct-handler path kept working. This
 * pins the CLI's real parameter shapes against the op contract the server
 * validates with, so a key the CLI adds without declaring it fails here, not
 * at the user's terminal.
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { __testing } from '../src/commands/capture.ts';
import { operationsByName } from '../src/core/operations.ts';
import { findUnknownParams } from '../src/mcp/validate-params.ts';
import { filterOpsForSurface } from '../src/mcp/surface.ts';

const capture = operationsByName.capture!;
const content = 'A captured observation.';
const precondition = { request_id: randomUUID() };
const args = (argv: string[]) => __testing.parseArgs(argv) as Record<string, unknown>;

const shapes = {
  positional: __testing.captureParams(args(['hello', '--slug', 'inbox/example']), content, precondition, false),
  stdin: __testing.captureParams(args(['--stdin', '--type', 'event', '--who', 'alice-example', '--what', 'met', '--where', 'office', '--kind', 'meeting', '--depth', 'depth/example']), content, precondition, false),
  fileLocal: __testing.captureParams(args(['--file', 'notes/local.md']), content, precondition, false),
  fileThin: __testing.captureParams(args(['--file', 'notes/local.md']), content, precondition, true),
  positionalThin: __testing.captureParams(args(['hello']), content, precondition, true),
};

describe('#6524 the CLI capture parameter shapes are declared on the capture op', () => {
  for (const [name, params] of Object.entries(shapes)) {
    test(`${name}: dispatch finds no unknown parameter`, () => {
      expect(findUnknownParams(capture, params)).toEqual([]);
    });
  }

  test('a local caller sends its provenance; a thin client sends none of it', () => {
    expect(shapes.positional).toMatchObject({ content, ...precondition, slug: 'inbox/example', source_kind: 'capture-cli', source_uri: 'cli-positional', ingested_via: 'capture-cli' });
    expect(shapes.stdin).toMatchObject({ source_kind: 'capture-cli', source_uri: 'stdin', ingested_via: 'capture-cli', type: 'event', who: 'alice-example' });
    expect(shapes.fileLocal).toMatchObject({ source_kind: 'capture-cli', ingested_via: 'capture-cli', local_file: resolve('notes/local.md') });
    expect('source_uri' in shapes.fileLocal).toBe(false);
    for (const thin of [shapes.fileThin, shapes.positionalThin]) {
      expect(Object.keys(thin).filter(key => ['source_kind', 'source_uri', 'ingested_via', 'local_file'].includes(key))).toEqual([]);
    }
  });

  test('the provenance trio is a full-surface declaration and stays off the starter list', () => {
    for (const key of ['source_kind', 'source_uri', 'ingested_via']) {
      expect(capture.params[key]).toMatchObject({ type: 'string', required: false, fullSurfaceOnly: true });
      expect(capture.params[key]!.description).toContain('mcp:capture');
    }
    const starter = filterOpsForSurface([capture], 'starter')[0];
    expect(starter).toBeDefined();
    expect(Object.keys(starter!.params)).not.toContain('source_kind');
    expect(Object.keys(starter!.params)).not.toContain('source_uri');
    expect(Object.keys(starter!.params)).not.toContain('ingested_via');
    expect(Object.keys(filterOpsForSurface([capture], 'full')[0]!.params)).toEqual(expect.arrayContaining(['source_kind', 'source_uri', 'ingested_via']));
  });
});
