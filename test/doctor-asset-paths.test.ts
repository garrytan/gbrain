/**
 * #1835 — pure unit coverage for src/commands/doctor-asset-paths.ts.
 *
 * Everything here is path/string-based with injected platform + WSL mount
 * root, so it runs identically on macOS / Linux / CI. The WSL translation
 * itself is UNVERIFIED-ON-PLATFORM (no real WSL host in this environment);
 * these tests pin the intended mapping.
 */
import { describe, expect, test } from 'bun:test';
import { resolveAssetPath, parseWslAutomountRoot } from '../src/commands/doctor-asset-paths.ts';

const REPO = '/mnt/d/brain-repo';

describe('resolveAssetPath — Windows drive paths', () => {
  test('WSL: D:/ forward-slash path maps to <root>/d/…', () => {
    const r = resolveAssetPath('D:/cicada3301/lost9999/img.jpg', REPO, {
      platform: 'linux',
      wslMountRoot: '/mnt',
    });
    expect(r).toEqual({ abs: '/mnt/d/cicada3301/lost9999/img.jpg', foreign: false });
  });

  test('WSL: D:\\ backslash path maps with separators normalized', () => {
    const r = resolveAssetPath('D:\\cicada3301\\lost9999\\img.jpg', REPO, {
      platform: 'linux',
      wslMountRoot: '/mnt',
    });
    expect(r).toEqual({ abs: '/mnt/d/cicada3301/lost9999/img.jpg', foreign: false });
  });

  test('WSL: drive letter is lowercased, custom automount root honored', () => {
    const r = resolveAssetPath('C:/Users/a/img.png', REPO, {
      platform: 'linux',
      wslMountRoot: '/windir/',
    });
    expect(r.abs).toBe('/windir/c/Users/a/img.png');
  });

  test('macOS: drive path is foreign (skip, never joined onto repoRoot)', () => {
    const r = resolveAssetPath('D:/cicada3301/img.jpg', REPO, {
      platform: 'darwin',
      wslMountRoot: null,
    });
    expect(r).toEqual({ abs: null, foreign: true });
  });

  test('plain Linux (non-WSL): drive path is foreign', () => {
    const r = resolveAssetPath('D:/x/img.jpg', REPO, {
      platform: 'linux',
      wslMountRoot: null,
    });
    expect(r).toEqual({ abs: null, foreign: true });
  });

  test('win32: drive path stats natively, untouched', () => {
    const r = resolveAssetPath('D:/x/img.jpg', REPO, { platform: 'win32' });
    expect(r).toEqual({ abs: 'D:/x/img.jpg', foreign: false });
  });
});

describe('resolveAssetPath — non-drive paths keep pre-#1835 behavior', () => {
  test('POSIX absolute path passes through', () => {
    const r = resolveAssetPath('/var/data/img.jpg', REPO, {
      platform: 'linux',
      wslMountRoot: null,
    });
    expect(r).toEqual({ abs: '/var/data/img.jpg', foreign: false });
  });

  test('relative path joins onto repoRoot', () => {
    const r = resolveAssetPath('assets/img.jpg', REPO, {
      platform: 'darwin',
      wslMountRoot: null,
    });
    expect(r).toEqual({ abs: `${REPO}/assets/img.jpg`, foreign: false });
  });

  test('lookalike without separator after colon is NOT treated as a drive', () => {
    const r = resolveAssetPath('notes:draft.md', REPO, {
      platform: 'linux',
      wslMountRoot: '/mnt',
    });
    expect(r).toEqual({ abs: `${REPO}/notes:draft.md`, foreign: false });
  });
});

describe('parseWslAutomountRoot', () => {
  test('defaults to /mnt on empty or unrelated config', () => {
    expect(parseWslAutomountRoot('')).toBe('/mnt');
    expect(parseWslAutomountRoot('[boot]\nsystemd=true\n')).toBe('/mnt');
  });

  test('reads [automount] root', () => {
    expect(parseWslAutomountRoot('[automount]\nroot = /custom\n')).toBe('/custom');
  });

  test('ignores root under a different section', () => {
    expect(parseWslAutomountRoot('[network]\nroot = /nope\n')).toBe('/mnt');
  });

  test('handles quotes, comments, and CRLF', () => {
    const conf = '[automount]\r\nroot = "/win" # drives here\r\noptions = "metadata"\r\n';
    expect(parseWslAutomountRoot(conf)).toBe('/win');
  });
});
