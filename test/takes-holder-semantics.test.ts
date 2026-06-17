/**
 * Validate takes holder semantics: holder = who HOLDS the belief, not who it's ABOUT.
 *
 * Cross-modal eval (2026-05-10) found holder/subject confusion was the #1
 * attribution error across 100K takes. These tests codify the correct contract.
 */
import { describe, it, expect } from 'bun:test';
import { parseTakesFence } from '../src/core/takes-fence.ts';

describe('takes holder semantics', () => {
  it('person stating their own belief → holder is that person', () => {
    const fence = `<!--- gbrain:takes:begin -->
| # | claim | kind | who | weight | since | source |
|---|-------|------|-----|--------|-------|--------|
| 1 | AI will replace 50% of coding by 2030 | bet | people/garry-tan | 0.75 | 2026-01 | Lightcone |
<!--- gbrain:takes:end -->`;
    const result = parseTakesFence(fence);
    expect(result.takes[0].holder).toBe('people/garry-tan');
  });

  it('analysis ABOUT a person by brain → holder is brain, not the subject', () => {
    const fence = `<!--- gbrain:takes:begin -->
| # | claim | kind | who | weight | since | source |
|---|-------|------|-----|--------|-------|--------|
| 1 | Garry has a hero/rescuer pattern from childhood parentification | hunch | brain | 0.75 | 2026-04 | therapy analysis |
<!--- gbrain:takes:end -->`;
    const result = parseTakesFence(fence);
    expect(result.takes[0].holder).toBe('brain');
    expect(result.takes[0].kind).toBe('hunch');
  });

  it('consensus fact → holder is world', () => {
    const fence = `<!--- gbrain:takes:begin -->
| # | claim | kind | who | weight | since | source |
|---|-------|------|-----|--------|-------|--------|
| 1 | Clipboard Health raised a $100M Series C | fact | world | 1.00 | 2026-03 | TechCrunch |
<!--- gbrain:takes:end -->`;
    const result = parseTakesFence(fence);
    expect(result.takes[0].holder).toBe('world');
    expect(result.takes[0].weight).toBe(1.0);
  });

  it('founder describing own company → holder is founder, not company', () => {
    const fence = `<!--- gbrain:takes:begin -->
| # | claim | kind | who | weight | since | source |
|---|-------|------|-----|--------|-------|--------|
| 1 | We can hit $10M ARR by Q3 | bet | people/bo-lu | 0.70 | 2026-04 | OH meeting |
<!--- gbrain:takes:end -->`;
    const result = parseTakesFence(fence);
    expect(result.takes[0].holder).toBe('people/bo-lu');
    expect(result.takes[0].kind).toBe('bet');
  });

  it('institutional fact with no individual claimant → holder is companies/', () => {
    const fence = `<!--- gbrain:takes:begin -->
| # | claim | kind | who | weight | since | source |
|---|-------|------|-----|--------|-------|--------|
| 1 | Founded in 2019, incorporated in Delaware | fact | companies/clipboard-health | 1.00 | 2019-01 | SEC filing |
<!--- gbrain:takes:end -->`;
    const result = parseTakesFence(fence);
    expect(result.takes[0].holder).toBe('companies/clipboard-health');
  });

  it('parser preserves weight values as-is (rounding is at engine layer)', () => {
    const fence = `<!--- gbrain:takes:begin -->
| # | claim | kind | who | weight | since | source |
|---|-------|------|-----|--------|-------|--------|
| 1 | Strong technical founder | take | people/garry-tan | 0.85 | 2026-04 | OH |
| 2 | Market timing is risky | hunch | people/garry-tan | 0.74 | 2026-04 | OH |
<!--- gbrain:takes:end -->`;
    const result = parseTakesFence(fence);
    expect(result.takes[0].weight).toBeCloseTo(0.85, 2);
    expect(result.takes[1].weight).toBeCloseTo(0.74, 2);
  });
});
