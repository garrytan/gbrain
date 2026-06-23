import { describe, expect, test } from 'bun:test';
import { runDrive } from '../src/commands/drive.ts';
import {
  classifyDriveFiles,
  extractDriveId,
  type DriveCollectedFile,
} from '../src/core/google-drive-collector.ts';

function file(name: string, mimeType: string, path = name): DriveCollectedFile {
  return {
    id: `id-${name}`,
    name,
    mimeType,
    path,
    depth: path.split('/').length - 1,
  };
}

describe('google drive collector strict scan', () => {
  test('parses shared folder urls and raw ids', () => {
    expect(extractDriveId('https://drive.google.com/drive/folders/1YuBK3TiUcGmzcuzZV_qJF9TAm7hHXAF_')).toBe('1YuBK3TiUcGmzcuzZV_qJF9TAm7hHXAF_');
    expect(extractDriveId('1YuBK3TiUcGmzcuzZV_qJF9TAm7hHXAF_')).toBe('1YuBK3TiUcGmzcuzZV_qJF9TAm7hHXAF_');
  });

  test('keeps Seascape-style docs and meeting context while skipping photos and zips', () => {
    const summary = classifyDriveFiles([
      file('Owner Documents', 'application/vnd.google-apps.folder'),
      file('2026-06-22 Jose and Dunia Redesign Kickoff Prep.md', 'text/markdown', 'Owner Documents/Lead/2026-06-22 Jose and Dunia Redesign Kickoff Prep.md'),
      file('2026-06-22 Emerald House Airbnb Listing Readback.txt', 'text/plain', 'Owner Documents/Lead/2026-06-22 Emerald House Airbnb Listing Readback.txt'),
      file('2026-06-22 Blue House Signed Property Redesign Package.pdf', 'application/pdf', 'Owner Documents/Lead/2026-06-22 Blue House Signed Property Redesign Package.pdf'),
      file('2026-06-22 Blue House Airbnb Before Photos.zip', 'application/zip', 'Owner Documents/Lead/2026-06-22 Blue House Airbnb Before Photos.zip'),
      file('2026-06-22 Card Pending SMS.png', 'image/png', 'Owner Documents/Lead/2026-06-22 Card Pending SMS.png'),
      file('Random Upload.txt', 'text/plain', 'Random Upload.txt'),
    ]);

    expect(summary.kept.map(k => k.file.name)).toEqual([
      '2026-06-22 Jose and Dunia Redesign Kickoff Prep.md',
      '2026-06-22 Emerald House Airbnb Listing Readback.txt',
      '2026-06-22 Blue House Signed Property Redesign Package.pdf',
    ]);
    expect(summary.kept[0]?.mode).toBe('text');
    expect(summary.kept[2]?.mode).toBe('metadata_only');
    expect(summary.skipped_by_reason['low-signal media/archive']).toBe(2);
    expect(summary.skipped_by_reason['no high-signal keyword']).toBe(1);
  });

  test('dry-run prints summary and never calls writer', async () => {
    let printed = false;
    let wrote = false;
    await runDrive({} as never, ['ingest', '--folder', '1YuBK3TiUcGmzcuzZV_qJF9TAm7hHXAF_', '--dry-run'], {
      client: {
        listFolder: async () => [],
        fetchText: async () => '',
      },
      scan: async () => ({
        scanned: 0,
        folders_scanned: 1,
        kept: [],
        skipped: [],
        skipped_by_reason: {},
      }),
      writeScan: async () => {
        wrote = true;
        return { written: 1, slugs: ['should-not-write'] };
      },
      printSummary: () => {
        printed = true;
      },
    });

    expect(printed).toBe(true);
    expect(wrote).toBe(false);
  });
});
