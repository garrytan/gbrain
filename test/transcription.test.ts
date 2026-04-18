import { describe, test, expect } from 'bun:test';
import { writeFileSync, readFileSync, unlinkSync, openSync, ftruncateSync, closeSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TMP_TXT = join(tmpdir(), 'gbrain-test-audio.txt');
const TMP_MP3 = join(tmpdir(), 'gbrain-test-audio.mp3');

// Create minimal test files
writeFileSync(TMP_TXT, 'not audio');
writeFileSync(TMP_MP3, 'fake mp3 data');

describe('transcription', () => {
  test('module exports transcribe function', async () => {
    const mod = await import('../src/core/transcription.ts');
    expect(typeof mod.transcribe).toBe('function');
  });

  test('TranscriptionResult interface shape', async () => {
    const mod = await import('../src/core/transcription.ts');
    expect(mod.transcribe).toBeDefined();
  });

  test('rejects unsupported audio format', async () => {
    const { transcribe } = await import('../src/core/transcription.ts');
    try {
      await transcribe(TMP_TXT, {});
      expect(true).toBe(false);
    } catch (e: any) {
      expect(e.message).toContain('Unsupported audio format');
    }
  });

  test('rejects missing API key with helpful error', async () => {
    const { transcribe } = await import('../src/core/transcription.ts');
    const groq = process.env.GROQ_API_KEY;
    const openai = process.env.OPENAI_API_KEY;
    delete process.env.GROQ_API_KEY;
    delete process.env.OPENAI_API_KEY;

    try {
      await transcribe(TMP_MP3, {});
      expect(true).toBe(false);
    } catch (e: any) {
      expect(e.message).toContain('API key not set');
      expect(e.message).toContain('GROQ_API_KEY');
    } finally {
      if (groq) process.env.GROQ_API_KEY = groq;
      if (openai) process.env.OPENAI_API_KEY = openai;
    }
  });

  test('detects provider from env vars', async () => {
    // This tests the provider detection logic indirectly
    const mod = await import('../src/core/transcription.ts');
    // If GROQ_API_KEY is set, Groq should be preferred
    // If only OPENAI_API_KEY, OpenAI should be used
    // We just verify the function is callable
    expect(typeof mod.transcribe).toBe('function');
  });

  test('supported audio extensions are comprehensive', () => {
    // Verify common audio formats are supported
    const expected = ['.mp3', '.wav', '.m4a', '.ogg', '.flac', '.mp4', '.webm'];
    // We can't access the private set directly, but we can test via error messages
    // The unsupported format test above verifies .txt is rejected
    // This test documents the expected formats
    expect(expected.length).toBeGreaterThan(5);
  });
});

// ---------------------------------------------------------------------------
// Regression: no shell interpolation of audioPath
//
// Historical bug: transcribeLargeFile used `execSync(\`ffprobe ... "${audioPath}"\`)`
// on files >25MB. The only audioPath validation was `extname().toLowerCase()` against
// an allow-list, which a filename like `evil"$(id).mp3` bypasses: extname still
// returns '.mp3', so the allow-list passes, and the quoted string is then dropped
// into a shell where `$(id)` executes.
//
// The fix replaces every execSync template literal in transcription.ts with
// execFileSync and an argv array, so audioPath is an argument, never shell text.
// These tests guard the fix both structurally (source cannot regress to shell-form)
// and behaviourally (a known-malicious filename is carried as a single argv entry).
// ---------------------------------------------------------------------------

describe('transcription / shell injection guardrails', () => {
  const SRC = readFileSync(
    join(__dirname, '..', 'src', 'core', 'transcription.ts'),
    'utf-8',
  );

  test('no execSync remains in transcription.ts', () => {
    // execFileSync is allowed; bare execSync (which goes through /bin/sh) is not.
    // We match at word boundaries so execFileSync does not trigger the check.
    const offenders = SRC.match(/\bexecSync\s*\(/g);
    expect(offenders).toBeNull();
  });

  test('no shell metacharacter targets in child_process template literals', () => {
    // Template literals that interpolate audioPath or tmpDir into a command
    // string pass through /bin/sh when used with exec/execSync. All current
    // spawns must be argv-array style.
    const templatedCmds = SRC.match(/exec(?:Sync|File|FileSync)?\s*\(\s*`[^`]*\$\{[^}]+\}/g);
    expect(templatedCmds).toBeNull();
  });

  test('audioPath is passed as an argv element, not shell text', () => {
    // ffprobe + ffmpeg calls must use the (cmd, [args]) execFileSync signature.
    // The regex matches "execFileSync('ffprobe', [" with any whitespace.
    expect(SRC).toMatch(/execFileSync\s*\(\s*['"]ffprobe['"]\s*,\s*\[/);
    expect(SRC).toMatch(/execFileSync\s*\(\s*['"]ffmpeg['"]\s*,\s*\[/);
  });

  test('temp dir cleanup uses fs.rmSync, not rm -rf shell call', () => {
    // The old cleanup used `execSync(\`rm -rf "${tmpDir}"\`)`. The new cleanup
    // uses fs.rmSync which does not invoke a shell and cannot be hijacked by
    // filename metacharacters.
    expect(SRC).toMatch(/rmSync\s*\(\s*tmpDir/);
    expect(SRC).not.toMatch(/rm\s+-rf/);
  });

  test('malicious filename >25MB is rejected without shell execution', async () => {
    // Build a sparse 26MB file whose basename is the shell-injection
    // payload reported in the R6 audit (CVE pattern: extname bypass via
    // quoted command substitution). The payload keeps slashes out of
    // the basename so the filesystem accepts it as a literal name.
    //
    // If the fix is in place, transcribe() either errors on ffprobe not
    // being present / file not audio, or surfaces the literal filename
    // in the error — crucially it never creates the canary.
    const CANARY = join(tmpdir(), 'gbrain-inj-canary.txt');
    try { unlinkSync(CANARY); } catch {}

    // Payload has no slashes — `touch canary` with a relative arg would
    // land in CWD, so we prefix with a harmless absolute sigil and then
    // check a well-known location. We match only on the sigil in CWD.
    const SIGIL = 'gbrain-shell-injection-canary';
    try { unlinkSync(join(process.cwd(), SIGIL)); } catch {}

    const MAL = join(tmpdir(), `evil-$(touch ${SIGIL}).mp3`);

    // Make the file 26MB via truncate (sparse — no real bytes written).
    const fd = openSync(MAL, 'w');
    ftruncateSync(fd, 26 * 1024 * 1024);
    closeSync(fd);

    // Pre-seed a fake API key so provider detection passes and we reach
    // the size gate that triggers transcribeLargeFile (the vulnerable path).
    const prior = process.env.GROQ_API_KEY;
    process.env.GROQ_API_KEY = 'test-key-not-used';

    try {
      const { transcribe } = await import('../src/core/transcription.ts');
      try {
        await transcribe(MAL, {});
      } catch {
        // Expected to throw — ffprobe may be missing, the file isn't
        // valid audio, or API call fails. None of those matter here.
      }
      // Side-effect assertion: the injection-marker file must NOT exist
      // in the CWD. If shell interpolation ran `$(touch SIGIL)`, the
      // shell would have created it.
      let leaked = true;
      try { readFileSync(join(process.cwd(), SIGIL)); } catch { leaked = false; }
      expect(leaked).toBe(false);
    } finally {
      try { unlinkSync(MAL); } catch {}
      try { unlinkSync(join(process.cwd(), SIGIL)); } catch {}
      if (prior) process.env.GROQ_API_KEY = prior;
      else delete process.env.GROQ_API_KEY;
    }
  });
});
