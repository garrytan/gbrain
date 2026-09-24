import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseReconcileArgs, readReconcileJson, writeReconcilePreview } from '../src/commands/source-reconcile.ts';

const directories: string[] = [];
function directory() {
  const path = mkdtempSync(join(tmpdir(), 'gbrain-reconcile-cli-'));
  directories.push(path);
  return path;
}
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe('exact reconciliation CLI', () => {
  test('defaults to preview with explicit identities and keeps artifact paths off the wire', () => {
    expect(parseReconcileArgs(['workspace', 'people/example', '--brain', 'host', '--out', 'preview.json', '--json'])).toEqual({
      operation: 'writer_reconcile_preview', params: { source_id: 'workspace', slug: 'people/example' }, brain: 'host',
      output: 'preview.json', input: undefined, decisions: undefined, json: true,
    });
    expect(parseReconcileArgs(['workspace', 'people/example', '--preview', '--from=old.json', '--decisions=choices.json', '--out=new.json']))
      .toMatchObject({ operation: 'writer_reconcile_preview', input: 'old.json', decisions: 'choices.json', output: 'new.json' });
  });

  test('apply requires an explicit replay ID and cannot add preview decisions', () => {
    const requestId = '20000000-0000-4000-8000-000000000001';
    expect(parseReconcileArgs(['workspace', 'people/example', '--apply', 'ready.json', '--request-id', requestId]))
      .toMatchObject({ operation: 'writer_reconcile_apply', params: { source_id: 'workspace', slug: 'people/example', request_id: requestId }, input: 'ready.json' });
    for (const extra of [[], ['--request-id', 'invalid'], ['--request-id', requestId, '--out', 'other.json'],
      ['--request-id', requestId, '--preview'], ['--request-id', requestId, '--decisions', 'choices.json']]) {
      expect(() => parseReconcileArgs(['workspace', 'people/example', '--apply', 'ready.json', ...extra])).toThrow();
    }
  });

  test('rejects ambiguous identities, duplicate or unsupported flags and invalid modes', () => {
    for (const args of [[], ['workspace'], ['workspace', 'people/*'], ['workspace', '../example'], ['workspace', 'a', 'b'],
      ['workspace', 'a', '--force'], ['workspace', 'a', '--preview=false'], ['workspace', 'a', '--out'],
      ['workspace', 'a', '--out', 'one', '--out', 'two'], ['workspace', 'a', '--decisions', 'choices.json'],
      ['workspace', 'a', '--request-id', '20000000-0000-4000-8000-000000000001'],
      ['workspace', 'a', '--limit', '10'], ['workspace', '--audit', '--out', 'private.json']]) {
      expect(() => parseReconcileArgs(args)).toThrow();
    }
  });

  test('read-only audit requires one source with a bounded cursor', () => {
    expect(parseReconcileArgs(['workspace', '--audit', '--limit', '10', '--after', 'people/example']))
      .toMatchObject({ operation: 'writer_reconcile_audit', params: { source_id: 'workspace', limit: 10, after: 'people/example' } });
    for (const limit of ['0', '101', '1.5', 'NaN']) expect(() => parseReconcileArgs(['workspace', '--audit', '--limit', limit])).toThrow();
    expect(() => parseReconcileArgs(['workspace', 'a', '--audit'])).toThrow();
  });

  test('backup cleanup is explicit, exact-page and separate from every repair mode', () => {
    expect(parseReconcileArgs(['workspace', 'people/example', '--backups', '--limit', '2']))
      .toMatchObject({ operation: 'writer_reconcile_backups', params: { source_id: 'workspace', slug: 'people/example', action: 'list', limit: 2 } });
    expect(parseReconcileArgs(['workspace', 'people/example', '--remove-backup', 'exact-reference']))
      .toMatchObject({ operation: 'writer_reconcile_backups', params: { source_id: 'workspace', slug: 'people/example', action: 'remove', backup_reference: 'exact-reference' } });
    for (const extra of [['--preview'], ['--out', 'file.json'], ['--remove-backup', 'reference'], ['--after', 'not-a-uuid'], ['--audit']]) {
      expect(() => parseReconcileArgs(['workspace', 'people/example', '--backups', ...extra])).toThrow();
    }
    expect(() => parseReconcileArgs(['workspace', 'people/example', '--remove-backup', 'reference', '--limit', '2'])).toThrow();
  });
});

describe('private reconciliation artifact files', () => {
  test('writes complete JSON privately and refuses to replace existing output', () => {
    const dir = directory();
    const path = join(dir, 'preview.json');
    const preview = { format_version: 1, preimages: { file: 'synthetic original' } };
    writeReconcilePreview(path, preview);
    expect(readReconcileJson(path)).toEqual(preview);
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(() => writeReconcilePreview(path, { changed: true })).toThrow();
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(preview);
    expect(readdirSync(dir)).toEqual(['preview.json']);
  });

  test('rejects symbolic links, directories and malformed JSON without leaking content', () => {
    const dir = directory();
    const input = join(dir, 'input.json');
    writeFileSync(input, '{ synthetic-private-marker invalid');
    expect(() => readReconcileJson(input)).toThrow('not valid JSON');
    try { readReconcileJson(input); } catch (error) { expect(String(error)).not.toContain('synthetic-private-marker'); }
    symlinkSync(input, join(dir, 'alias.json'));
    expect(() => readReconcileJson(join(dir, 'alias.json'))).toThrow('regular JSON file');
    expect(() => readReconcileJson(dir)).toThrow();
    expect(() => writeReconcilePreview(join(dir, 'alias.json'), {})).toThrow();
    expect(readFileSync(input, 'utf8')).toContain('synthetic-private-marker');
  });

  test('refuses artifacts inside a claimed canonical worktree without creating a file', () => {
    const dir = directory();
    writeFileSync(join(dir, '.gbrain-owner.json'), JSON.stringify({ version: 1, managed: true }));
    expect(() => writeReconcilePreview(join(dir, 'preview.json'), {})).toThrow();
    expect(readdirSync(dir)).toEqual(['.gbrain-owner.json']);
  });
});
