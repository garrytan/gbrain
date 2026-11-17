/**
 * The upgrade matrix's release list counts pre-releases.
 *
 * Protects: every batch release is published as a pre-release, so a list that skipped them would see only the
 * promoted stable releases, shift what N-1/N-10/N-50 mean and fail the 50-older-releases history check for months.
 * Drafts and unpublished rows still stay out.
 */
import { describe, expect, test } from 'bun:test';
import { fetchReleases } from '../../scripts/upgrade-matrix/versions.ts';

describe('fetchReleases', () => {
  test('keeps published pre-releases and normal releases, drops drafts, unpublished rows and other tags', async () => {
    const rows = [
      { tag_name: 'v0.60.722.0', published_at: '2026-11-14T20:00:00Z', draft: false, prerelease: true },
      { tag_name: 'v0.60.717.0', published_at: '2026-11-14T08:00:00Z', draft: false, prerelease: false },
      { tag_name: 'v0.60.716.0', published_at: '2026-11-14T07:00:00Z', draft: true, prerelease: true },
      { tag_name: 'v0.60.715.0', published_at: null, draft: false, prerelease: true },
      { tag_name: 'stable', published_at: '2026-11-14T08:00:00Z', draft: false, prerelease: false },
    ];
    const impl = (async () => new Response(JSON.stringify(rows), { status: 200 })) as unknown as typeof fetch;
    const out = await fetchReleases('garrytan/gbrain', () => true, impl);
    expect(out.map(r => r.version)).toEqual(['0.60.722.0', '0.60.717.0']);
  });
});
