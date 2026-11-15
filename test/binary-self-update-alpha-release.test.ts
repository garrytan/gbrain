/**
 * Alpha binary self-update resolves its release from the latest-stable tag, not GitHub's "Latest".
 *
 * Protects: every batch release is published as a pre-release and only the stable release is GitHub's Latest, so an
 * alpha binary that read releases/latest would silently ride stable. The updater reads VERSION at latest-stable and
 * fetches that exact release by tag.
 */
import { describe, expect, test } from 'bun:test';
import { fetchAlphaRelease } from '../src/core/binary-self-update.ts';

function fakeFetch(answers: Record<string, { status: number; body: string }>) {
  const urls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    const a = answers[url] ?? { status: 404, body: '' };
    return new Response(a.body, { status: a.status });
  }) as unknown as typeof fetch;
  return { impl, urls };
}

const VERSION_URL = 'https://raw.githubusercontent.com/garrytan/gbrain/latest-stable/VERSION';
const TAG_URL = 'https://api.github.com/repos/garrytan/gbrain/releases/tags/v0.60.722.0';

describe('fetchAlphaRelease', () => {
  test('reads VERSION at latest-stable, then fetches that exact release, never releases/latest', async () => {
    const f = fakeFetch({
      [VERSION_URL]: { status: 200, body: '0.60.722.0\n' },
      [TAG_URL]: { status: 200, body: JSON.stringify({ tag_name: 'v0.60.722.0', assets: [{ name: 'gbrain-linux-x64', browser_download_url: 'https://example.com/gbrain-linux-x64' }] }) },
    });
    expect(await fetchAlphaRelease(f.impl)).toEqual({ tag: 'v0.60.722.0', assets: [{ name: 'gbrain-linux-x64', url: 'https://example.com/gbrain-linux-x64' }] });
    expect(f.urls).toEqual([VERSION_URL, TAG_URL]);
    expect(f.urls.some(u => u.includes('releases/latest'))).toBe(false);
  });

  test('an unreadable or malformed VERSION, or a missing release, gives null', async () => {
    expect(await fetchAlphaRelease(fakeFetch({ [VERSION_URL]: { status: 500, body: '' } }).impl)).toBeNull();
    expect(await fetchAlphaRelease(fakeFetch({ [VERSION_URL]: { status: 200, body: '<html>not a version</html>' } }).impl)).toBeNull();
    const noRelease = fakeFetch({ [VERSION_URL]: { status: 200, body: '0.60.722.0' } });
    expect(await fetchAlphaRelease(noRelease.impl)).toBeNull();
    expect(noRelease.urls).toEqual([VERSION_URL, TAG_URL]);
  });
});
