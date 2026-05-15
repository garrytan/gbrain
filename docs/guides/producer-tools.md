# Producer Integration: `gbrain frontmatter slug` and `gbrain frontmatter abi-version`

External producers (markdown-writing tools that feed gbrain) need their
frontmatter `slug` field to match what gbrain computes via `slugifyPath()`
at sync time. If a producer's `slug` doesn't byte-match gbrain's expected
slug, sync fails with `SLUG_MISMATCH` and the file is rejected.

Historically, each producer ported the slug rules into its own codebase
and the ports drifted from gbrain's. The two subcommands below let
producers source slug computation from gbrain itself, so the rule lives
in exactly one place.

## Get the canonical slug

    gbrain frontmatter slug <brain-root-relative-path-without-.md>

Example:

    $ gbrain frontmatter slug "Briefings/Webex Digest - 2026-05-13"
    briefings/webex-digest-2026-05-13

Exit codes: `0` on success, `2` on usage error (missing argument).

The path is treated as multi-segment (split on `/`, each segment
slugified, rejoined with `/`). To get a single-segment slug from a
string that may contain slashes, replace `/` with another character
(e.g. space) before invoking, or trust the segmentation behavior.

## Assert a minimum ABI

    gbrain frontmatter abi-version

Prints an integer to stdout. Producers should assert a minimum at
startup so a future gbrain upgrade that changes slug rules fails loudly
rather than silently re-slugging differently.

Bump the version when `slugifyPath()` or `slugifySegment()` changes
output for any input that previously produced a different result.

### Python (no shell)

    import subprocess
    try:
        out = subprocess.run(
            ['gbrain', 'frontmatter', 'abi-version'],
            capture_output=True, check=True, text=True,
        )
        if int(out.stdout.strip()) < 1:
            raise RuntimeError('gbrain too old')
    except (FileNotFoundError, subprocess.CalledProcessError) as e:
        raise RuntimeError(f'gbrain unavailable: {e}')

### Node (TypeScript, no shell)

    import { execFileSync } from 'node:child_process';
    const abi = parseInt(
      execFileSync('gbrain', ['frontmatter', 'abi-version'], { encoding: 'utf8' }).trim(),
      10,
    );
    if (abi < 1) throw new Error('gbrain too old');

Both forms use `execFile`-style invocation (no shell, array args) to
prevent command injection on user-controlled inputs such as path
components or document titles.

## When to bump the ABI

Bump from 1 → 2 when:

- The output of `slugifyPath()` or `slugifySegment()` changes for any input.
- The character allow-set (`[a-z0-9.\s_-]`), the NFD normalization, the
  combining-mark stripping, or the whitespace-to-hyphen conversion changes.
- Any other change that would cause a previously-stamped producer file to
  fail `SLUG_MISMATCH` validation against the new gbrain.

Do not bump for:

- Internal refactors that preserve all inputs/outputs.
- Adding new subcommands under `gbrain frontmatter`.
- Performance changes that don't alter outputs.

The ABI version protects producers from silently miscomputing slugs after
a gbrain upgrade. Treat the bump as a breaking change requiring producer
coordination.
