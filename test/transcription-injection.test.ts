/**
 * Security test for #245 — the large-file transcription path must not pass
 * caller-controlled audio paths through a shell. transcribeLargeFile now uses
 * execFileSync with argument arrays (+ fs.rmSync for cleanup), so a path
 * containing shell metacharacters is a literal argv element, never parsed.
 *
 * transcription.ts is a dead-internally-but-PUBLISHED export (gbrain/transcription),
 * so an external programmatic consumer can still call transcribe() with an
 * attacker-influenced path — hence the harden over delete.
 */

import { describe, test, expect } from 'bun:test';
import {
  mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { transcribe } from '../src/core/transcription.ts';

function ffmpegAvailable(): boolean {
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'pipe' });
        execFileSync('ffprobe', ['-version'], { stdio: 'pipe' });
        return true; } catch { return false; }
}

describe('transcription — command injection (#245)', () => {
  // Source-level guard (deterministic, no ffmpeg dependency): the shell-string
  // exec forms must be gone. Mirrors the repo's check-*.sh guard philosophy.
  test('source uses execFileSync arg-arrays, never shell execSync', () => {
    const src = readFileSync(new URL('../src/core/transcription.ts', import.meta.url), 'utf8');
    // `\bexecSync(` matches the dangerous shell-string call but NOT execFileSync.
    expect(src).not.toMatch(/\bexecSync\s*\(/);     // no shell command strings
    expect(src).toMatch(/execFileSync\(/);          // arg-array exec
    expect(src).toMatch(/rmSync\(/);                // fs cleanup, not shell remove
  });

  // Behavioral: a >25MB file whose NAME contains a $(...) payload. Under the old
  // shell-string code the double-quoted interpolation command-substitutes the
  // payload (creating the sentinel) before ffprobe runs; under execFileSync the
  // payload is a literal filename, so no sentinel is ever created.
  test('a $(...) payload in the audio path does not spawn a shell', async () => {
    if (!ffmpegAvailable()) return; // path requires ffmpeg/ffprobe; skip otherwise
    // Sentinel must be a slash-free name so it's a legal single filename segment;
    // a shell `touch <name>` would create it in process.cwd(), so we check there.
    const sentinelName = `gbrain-inj-sentinel-${process.pid}-${Date.now()}`;
    const sentinelPath = join(process.cwd(), sentinelName);
    if (existsSync(sentinelPath)) rmSync(sentinelPath, { force: true });
    const dir = mkdtempSync(join(tmpdir(), 'transcribe-inj-'));
    // Payload touches the sentinel IF a shell ever parses the path.
    const evil = join(dir, `clip$(touch ${sentinelName}).mp3`);
    writeFileSync(evil, Buffer.alloc(26 * 1024 * 1024)); // >25MB → large-file path
    try {
      await transcribe(evil, { apiKey: 'dummy', provider: 'groq' });
    } catch {
      // Expected: ffprobe/ffmpeg reject the garbage file, or transcribeFile has
      // no real key. We only care that no shell ran.
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const pwned = existsSync(sentinelPath);
    if (pwned) rmSync(sentinelPath, { force: true });
    expect(pwned).toBe(false);
  }, 30_000);
});
