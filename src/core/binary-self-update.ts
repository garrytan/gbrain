/**
 * Real atomic self-update for the compiled-`binary` install method
 * (v0.42 self-upgrading-gbrain wave, eng-review Finding 2 — "make the atomic
 * swap claim true for the one method we own").
 *
 * `bun` / `bun-link` / `clawhub` delegate their swap to those package managers.
 * The compiled standalone binary is the only method gbrain itself writes, so
 * it's the only place we can (and now do) guarantee atomicity:
 *
 *   resolve published asset → download to a temp sibling of the live binary →
 *   fsync + chmod +x → `--version` smoke test → renameSync over the live path.
 *
 * rename(2) over a running binary is safe on darwin/linux (the running process
 * keeps the old inode; the next exec picks up the new file). Every failure
 * (no asset / fetch / download / smoke / rename) leaves the OLD binary
 * untouched — there is no half-written-binary brick path. Windows can't rename
 * over a running .exe, and no Windows/`darwin-x64`/`linux-arm64` asset is
 * published, so those degrade to notify-only via `resolvePlatformAsset`
 * returning null. Trust model: TLS + GitHub, same as `gbrain upgrade` (no
 * signature verification this wave — D7a TODO).
 *
 * Published asset matrix mirrors `.github/workflows/release.yml`:
 *   darwin-arm64 → gbrain-darwin-arm64
 *   linux-x64    → gbrain-linux-x64
 */

import { chmodSync, closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

export interface ReleaseAsset {
  name: string;
  url: string;
}

export type BinarySelfUpdateReason =
  | 'unsupported_platform'
  | 'fetch_failed'
  | 'no_asset'
  | 'download_failed'
  | 'smoke_failed'
  | 'replace_failed';

export interface BinarySelfUpdateResult {
  ok: boolean;
  reason?: BinarySelfUpdateReason;
  error?: string;
  /** Asset name resolved (when applicable). */
  asset?: string;
}

/** The release asset basename gbrain publishes for this platform/arch, or null
 * when no asset is published (degrade to notify-only). */
export function expectedAssetName(platform: NodeJS.Platform, arch: NodeJS.Architecture): string | null {
  if (platform === 'darwin' && arch === 'arm64') return 'gbrain-darwin-arm64';
  if (platform === 'linux' && arch === 'x64') return 'gbrain-linux-x64';
  return null;
}

/** Pick the download URL for this platform/arch from a release's asset list. */
export function resolvePlatformAsset(
  assets: ReleaseAsset[],
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): string | null {
  const name = expectedAssetName(platform, arch);
  if (!name) return null;
  const match = assets.find((a) => a.name === name);
  return match?.url ?? null;
}

export interface BinarySelfUpdateDeps {
  /** Fetch the latest release's tag + asset list. Default hits the GitHub API. */
  fetchRelease?: () => Promise<{ tag: string; assets: ReleaseAsset[] } | null>;
  /** Download `url` to `destPath`. Default streams the HTTP body to disk. */
  download?: (url: string, destPath: string) => Promise<void>;
  /** Smoke-test the staged binary; returns true if `<path> --version` looks like gbrain. */
  smoke?: (stagedPath: string) => boolean;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
}

async function defaultFetchRelease(): Promise<{ tag: string; assets: ReleaseAsset[] } | null> {
  try {
    const res = await fetch('https://api.github.com/repos/garrytan/gbrain/releases/latest', {
      headers: { 'User-Agent': 'gbrain-self-upgrade' },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    const assets: ReleaseAsset[] = Array.isArray(data.assets)
      ? data.assets.map((a: any) => ({ name: String(a.name ?? ''), url: String(a.browser_download_url ?? '') }))
      : [];
    return { tag: String(data.tag_name ?? ''), assets };
  } catch {
    return null;
  }
}

async function defaultDownload(url: string, destPath: string): Promise<void> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'gbrain-self-upgrade' },
    redirect: 'follow',
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`download HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error('downloaded asset is empty');
  writeFileSync(destPath, buf);
  // fsync so a crash between write and rename can't leave a torn file.
  const fd = openSync(destPath, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function defaultSmoke(stagedPath: string): boolean {
  try {
    const out = execFileSync(stagedPath, ['--version'], { encoding: 'utf-8', timeout: 10_000 });
    return /gbrain\s/i.test(out);
  } catch {
    return false;
  }
}

let _tmpCounter = 0;

/**
 * Perform a real atomic self-update of the binary at `targetPath` (defaults to
 * the running binary, `process.execPath`). Returns a tagged result; never
 * throws. On any failure the original binary is left untouched.
 */
export async function runBinarySelfUpdate(
  targetPath: string = process.execPath,
  deps: BinarySelfUpdateDeps = {},
): Promise<BinarySelfUpdateResult> {
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  const fetchRelease = deps.fetchRelease ?? defaultFetchRelease;
  const download = deps.download ?? defaultDownload;
  const smoke = deps.smoke ?? defaultSmoke;

  const assetName = expectedAssetName(platform, arch);
  if (!assetName) {
    return { ok: false, reason: 'unsupported_platform' };
  }

  const release = await fetchRelease();
  if (!release) {
    return { ok: false, reason: 'fetch_failed', asset: assetName };
  }

  const url = resolvePlatformAsset(release.assets, platform, arch);
  if (!url) {
    return { ok: false, reason: 'no_asset', asset: assetName };
  }

  // Stage in a temp sibling so the rename is same-filesystem (atomic).
  const staged = join(dirname(targetPath), `.${assetName}.tmp.${process.pid}.${_tmpCounter++}`);
  try {
    await download(url, staged);
  } catch (e) {
    safeUnlink(staged);
    return { ok: false, reason: 'download_failed', error: errMsg(e), asset: assetName };
  }

  try {
    chmodSync(staged, 0o755);
  } catch (e) {
    safeUnlink(staged);
    return { ok: false, reason: 'download_failed', error: errMsg(e), asset: assetName };
  }

  if (!smoke(staged)) {
    safeUnlink(staged);
    return { ok: false, reason: 'smoke_failed', asset: assetName };
  }

  try {
    renameSync(staged, targetPath); // atomic on same fs; old binary intact if this throws
  } catch (e) {
    safeUnlink(staged);
    return { ok: false, reason: 'replace_failed', error: errMsg(e), asset: assetName };
  }

  return { ok: true, asset: assetName };
}

function safeUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* already gone */
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
