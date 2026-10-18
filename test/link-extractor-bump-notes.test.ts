/**
 * #6803 (D5): a link-extractor watermark bump re-stales every page brain-wide. The pinned value below changes only
 * together with an EXTRACTOR_BUMP_NOTES entry keyed by the new value (written with the code, copied into the CHANGELOG
 * at ship) that names the brain-wide re-extraction and the command that finishes it.
 */
import { expect, test } from 'bun:test';
import { LINK_EXTRACTOR_VERSION_TS } from '../src/core/link-extraction.ts';
import * as watermark from '../src/core/link-extraction-watermark.ts';

test('LINK_EXTRACTOR_VERSION_TS is pinned; a bump needs its EXTRACTOR_BUMP_NOTES entry naming the re-extraction and --catch-up', () => {
  expect(LINK_EXTRACTOR_VERSION_TS).toBe('2026-10-08T00:00:00Z');
  const notes = (watermark as { EXTRACTOR_BUMP_NOTES?: Record<string, string> }).EXTRACTOR_BUMP_NOTES;
  const note = notes?.[LINK_EXTRACTOR_VERSION_TS];
  expect(note).toBeDefined();
  expect(note).toContain('brain-wide');
  expect(note).toContain('gbrain extract --stale --catch-up');
});
