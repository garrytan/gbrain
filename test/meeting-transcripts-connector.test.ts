import { afterEach, describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import { pathToFileURL } from 'url';
import {
  loadMeetingTranscriptFilesystemItems,
  MEETING_TRANSCRIPT_MAX_BYTES,
} from '../src/core/connectors/meeting-transcripts-filesystem.ts';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe('meeting transcript filesystem loader', () => {
  test('loads supported transcript files in stable order and skips unsafe paths before reading', () => {
    const root = makeTempDir('mbrain-meeting-transcripts-');
    const nested = join(root, 'nested');
    const hiddenDir = join(root, '.hidden');
    const outside = makeTempDir('mbrain-meeting-transcripts-outside-');
    mkdirSync(nested);
    mkdirSync(hiddenDir);
    writeFileSync(join(root, 'zeta.txt'), 'Later transcript');
    writeFileSync(join(root, 'alpha.md'), [
      '---',
      'title: Alpha Review',
      '---',
      '',
      'Alpha transcript',
    ].join('\n'));
    writeFileSync(join(nested, 'beta.markdown'), 'Beta transcript');
    writeFileSync(join(root, '.private.md'), 'hidden file');
    writeFileSync(join(hiddenDir, 'secret.md'), 'hidden dir');
    writeFileSync(join(root, 'slides.pdf'), 'unsupported');
    writeFileSync(join(root, 'empty.txt'), '');
    writeFileSync(join(root, 'large.txt'), 'x'.repeat(MEETING_TRANSCRIPT_MAX_BYTES + 1));
    writeFileSync(join(outside, 'outside.txt'), 'outside transcript');
    symlinkSync(join(outside, 'outside.txt'), join(root, 'linked.txt'));

    const result = loadMeetingTranscriptFilesystemItems({ path: root });

    expect(result.source_scope).toBe('directory');
    expect(result.source_locator).toBe(pathToFileURL(realpathSync(root)).href);
    expect(result.path_display).toBe(`.../${basename(root)}`);
    expect(result.items.map((item) => item.external_id)).toEqual([
      'alpha.md',
      'nested/beta.markdown',
      'zeta.txt',
    ]);
    expect(result.items.map((item) => item.title)).toEqual([
      'Alpha Review',
      'beta',
      'zeta',
    ]);
    expect(result.items[0]?.locator).toBe('alpha.md');
    expect(result.items[0]?.metadata_json).toMatchObject({
      relative_path: 'alpha.md',
      extension: '.md',
      path_display: '.../alpha.md',
    });
    expect(JSON.stringify(result.items)).not.toContain(root);
    expect(result.skipped_files).toEqual(expect.arrayContaining([
      { relative_path: '.hidden', reason: 'hidden_path' },
      { relative_path: '.private.md', reason: 'hidden_path' },
      { relative_path: 'empty.txt', reason: 'empty_file' },
      { relative_path: 'large.txt', reason: 'file_too_large' },
      { relative_path: 'linked.txt', reason: 'symlink_not_followed' },
      { relative_path: 'slides.pdf', reason: 'unsupported_extension' },
    ]));
  });

  test('single-file input scopes consent to the file and does not scan siblings', () => {
    const root = makeTempDir('mbrain-meeting-transcript-file-');
    const transcriptPath = join(root, 'solo.md');
    writeFileSync(transcriptPath, '# Solo Meeting\n\nTranscript');
    writeFileSync(join(root, 'sibling.md'), 'Must not be loaded');

    const result = loadMeetingTranscriptFilesystemItems({ path: transcriptPath });

    expect(result.source_scope).toBe('file');
    expect(result.source_locator).toBe(pathToFileURL(realpathSync(transcriptPath)).href);
    expect(result.account_locator).toBe(result.source_locator);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      external_id: 'solo.md',
      locator: null,
      title: 'solo',
      body: '# Solo Meeting\n\nTranscript',
      metadata_json: {
        relative_path: 'solo.md',
        path_display: '.../solo.md',
      },
    });
    expect(JSON.stringify(result.items)).not.toContain('sibling.md');
  });
});
