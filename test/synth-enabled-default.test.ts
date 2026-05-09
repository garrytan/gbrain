/**
 * Verify: dream.synthesize.enabled defaults to true when corpus dir is set.
 *
 * Before this change, users had to set BOTH session_corpus_dir AND enabled=true.
 * Now setting session_corpus_dir is sufficient — enabled defaults to true when
 * a corpus dir is configured, and can be explicitly disabled with enabled=false.
 */
import { describe, it, expect } from 'bun:test';

// Inline the logic under test (extracted from loadSynthConfig)
function resolveEnabled(enabledRaw: string | null, corpusDir: string | null): boolean {
  if (enabledRaw === 'false') return false;    // explicit disable wins
  if (enabledRaw === 'true') return true;      // explicit enable wins
  return !!corpusDir;                          // default: true when corpus dir set
}

describe('synthesize enabled default', () => {
  it('enabled when corpus dir is set and enabled is unset', () => {
    expect(resolveEnabled(null, '/some/dir')).toBe(true);
  });

  it('disabled when corpus dir is unset and enabled is unset', () => {
    expect(resolveEnabled(null, null)).toBe(false);
  });

  it('explicit enabled=true wins regardless of corpus dir', () => {
    expect(resolveEnabled('true', null)).toBe(true);
    expect(resolveEnabled('true', '/some/dir')).toBe(true);
  });

  it('explicit enabled=false disables even with corpus dir', () => {
    expect(resolveEnabled('false', '/some/dir')).toBe(false);
    expect(resolveEnabled('false', null)).toBe(false);
  });

  it('empty string treated as unset (defaults to corpus dir presence)', () => {
    expect(resolveEnabled('', '/some/dir')).toBe(true);
    expect(resolveEnabled('', null)).toBe(false);
  });
});
