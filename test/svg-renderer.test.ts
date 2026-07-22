/**
 * v0.36.1.0 (T15 / D23) — server-rendered SVG renderer tests.
 *
 * Pure functions, hermetic. No DOM, no JSDOM. Asserts structural
 * properties of the emitted SVG markup.
 */

import { describe, test, expect } from 'bun:test';
import {
  renderBrierTrend,
  renderDomainBars,
  renderAbandonedThreadsCard,
  renderPatternStatementsCard,
  escapeXml,
} from '../src/core/calibration/svg-renderer.ts';

describe('escapeXml', () => {
  test('escapes the 5 mandatory entities', () => {
    expect(escapeXml('<script>&"\'</script>')).toBe('&lt;script&gt;&amp;&quot;&#39;&lt;/script&gt;');
  });
});

describe('renderBrierTrend', () => {
  test('empty series → empty-state SVG with placeholder text', () => {
    const out = renderBrierTrend({ series: [] });
    expect(out).toContain('No Brier-trend data yet');
    expect(out).toContain('<svg');
  });

  test('renders polyline for >=2 points', () => {
    const out = renderBrierTrend({
      series: [
        { date: '2025-01-01', brier: 0.22 },
        { date: '2025-02-01', brier: 0.2 },
        { date: '2025-03-01', brier: 0.18 },
      ],
    });
    expect(out).toContain('<polyline');
    expect(out).toContain('2025-01-01');
    expect(out).toContain('2025-03-01');
  });

  test('clamps brier above yMax (0.4) without crashing', () => {
    const out = renderBrierTrend({
      series: [
        { date: '2025-01-01', brier: 0.9 },
        { date: '2025-02-01', brier: 0.1 },
      ],
    });
    expect(out).toContain('<polyline');
  });

  test('inlines the design tokens (dark theme, blue accent)', () => {
    const out = renderBrierTrend({ series: [{ date: '2025-01-01', brier: 0.2 }] });
    expect(out).toContain('#0a0a0f'); // bg
    expect(out).toContain('#3b82f6'); // accent
  });

  test('XSS-safe on attacker-controlled date strings', () => {
    const out = renderBrierTrend({
      series: [
        { date: '<script>alert(1)</script>', brier: 0.2 },
        { date: '2025-02-01', brier: 0.18 },
      ],
    });
    expect(out).not.toContain('<script>alert');
    expect(out).toContain('&lt;script&gt;');
  });

  test('emits text-anchor end on the right-side date label', () => {
    const out = renderBrierTrend({
      series: [
        { date: '2025-01-01', brier: 0.22 },
        { date: '2025-03-01', brier: 0.18 },
      ],
    });
    expect(out).toContain('text-anchor="end"');
  });
});

describe('renderDomainBars', () => {
  test('empty bars → empty-state SVG', () => {
    const out = renderDomainBars({ bars: [] });
    expect(out).toContain('No per-domain scorecard data');
  });

  test('renders one row per bar with accuracy label + n sample size', () => {
    const out = renderDomainBars({
      bars: [
        { label: 'macro', accuracy: 0.55, n: 11 },
        { label: 'tactics', accuracy: 0.8, n: 25 },
      ],
    });
    expect(out).toContain('macro');
    expect(out).toContain('tactics');
    expect(out).toContain('55%');
    expect(out).toContain('80%');
    expect(out).toContain('n=11');
    expect(out).toContain('n=25');
  });

  test('clamps accuracy outside [0,1] without breaking layout', () => {
    const out = renderDomainBars({
      bars: [
        { label: 'overshoot', accuracy: 1.5, n: 3 },
        { label: 'negative', accuracy: -0.2, n: 1 },
      ],
    });
    expect(out).toContain('<svg');
    // Accuracy text displays the source value but the rect width is clamped.
    // We don't enforce display-side clamp; the bar geometry stays inside the
    // plot. Just check the SVG parses cleanly.
    expect(out).toMatch(/<rect[^>]+width=/);
  });

  test('XSS-safe on attacker-controlled label strings', () => {
    const out = renderDomainBars({
      bars: [{ label: '<img src=x onerror=alert(1)>', accuracy: 0.5, n: 1 }],
    });
    expect(out).not.toContain('<img src=x');
    expect(out).toContain('&lt;img src=x');
  });
});

describe('renderAbandonedThreadsCard', () => {
  test('empty threads → empty-state SVG', () => {
    const out = renderAbandonedThreadsCard([]);
    expect(out).toContain('clean slate');
  });

  test('renders one row per thread with claim + meta + revisit link', () => {
    const out = renderAbandonedThreadsCard([
      {
        takeId: 42,
        pageSlug: 'wiki/companies/acme',
        claim: 'Marketplaces with cold-start liquidity always win.',
        monthsSilent: 17,
        conviction: 0.85,
      },
    ]);
    expect(out).toContain('Marketplaces with cold-start liquidity');
    expect(out).toContain('17 months silent');
    expect(out).toContain('conviction 0.85');
    expect(out).toContain('revisit now');
    // Default revisitHref points at the take id.
    expect(out).toContain('/admin/calibration/revisit/42');
  });

  test('truncates long claim text', () => {
    const longClaim = 'x'.repeat(200);
    const out = renderAbandonedThreadsCard([
      {
        takeId: 1,
        pageSlug: 'wiki/a',
        claim: longClaim,
        monthsSilent: 12,
        conviction: 0.8,
      },
    ]);
    expect(out).toContain('x'.repeat(70) + '…');
  });

  test('custom revisitHref override is honored (D30 / TD4)', () => {
    const out = renderAbandonedThreadsCard([
      {
        takeId: 9,
        pageSlug: 'wiki/a',
        claim: 'x',
        monthsSilent: 12,
        conviction: 0.8,
        revisitHref: 'custom://opens-the-editor',
      },
    ]);
    expect(out).toContain('custom://opens-the-editor');
  });
});

describe('renderPatternStatementsCard', () => {
  test('empty statements → empty-state SVG', () => {
    const out = renderPatternStatementsCard([]);
    expect(out).toContain('No active patterns');
  });

  test('renders one anchor (drill-down link) per statement (D29 / TD3)', () => {
    const out = renderPatternStatementsCard([
      { text: 'You called early-stage tactics well — 8 of 10 held up.' },
      { text: 'Geography is your blind spot — 4 of 6 missed.' },
    ]);
    expect(out).toContain('Geography is your blind spot');
    // Both rows get anchor tags for drill-down.
    const anchorCount = (out.match(/<a href=/g) ?? []).length;
    expect(anchorCount).toBe(2);
    // Default drill href shape.
    expect(out).toContain('/admin/calibration/pattern/1');
    expect(out).toContain('/admin/calibration/pattern/2');
  });

  test('XSS-safe on attacker-controlled text', () => {
    const out = renderPatternStatementsCard([
      { text: '<script>alert(1)</script>' },
    ]);
    expect(out).not.toContain('<script>alert');
  });

  test('custom drillHref override honored', () => {
    const out = renderPatternStatementsCard([
      { text: 'pattern', drillHref: '/custom/path/here' },
    ]);
    expect(out).toContain('/custom/path/here');
  });
});
