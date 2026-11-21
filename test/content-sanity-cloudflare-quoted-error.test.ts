import { describe, test, expect } from 'bun:test';
import { assessContentSanity } from '../src/core/content-sanity.ts';

describe('cloudflare_attention_required', () => {
  test('does not match prose quoting a Cloudflare 403 error line', () => {
    const r = assessContentSanity({
      compiled_truth: 'The CLI failed with: API Error: 403 Attention Required! | Cloudflare\n',
      timeline: '',
      title: 'Login outage notes',
    });
    expect(r.junk_pattern_matches).not.toContain('cloudflare_attention_required');
    expect(r.shouldQuarantine).toBe(false);
  });

  test('still matches the interstitial title and HTML title', () => {
    for (const body of ['<title>Attention Required! | Cloudflare</title>', '# Attention Required! | Cloudflare']) {
      const r = assessContentSanity({ compiled_truth: body, timeline: '', title: 'x' });
      expect(r.junk_pattern_matches).toContain('cloudflare_attention_required');
    }
  });
});
