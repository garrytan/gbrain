import { describe, test, expect } from 'bun:test';
import {
  validateRecipe,
  extractFields,
  verifyExtraction,
  isDuplicate,
  parseTrackerPage,
  appendToTracker,
  computeTotals,
  buildDateWindows,
  stripEmailHtml,
} from '../src/core/data-research.ts';

describe('data-research', () => {
  describe('validateRecipe', () => {
    test('valid recipe passes', () => {
      const result = validateRecipe({
        name: 'test',
        source_queries: { gmail: ['subject:test'] },
        extraction_schema: { amount: 'currency' },
        tracker_page: 'trackers/test',
        tracker_format: { group_by: 'year', columns: ['date', 'amount'] },
      });
      expect(result.valid).toBe(true);
      expect(result.errors.length).toBe(0);
    });

    test('missing name fails', () => {
      const result = validateRecipe({
        source_queries: { gmail: ['test'] },
        extraction_schema: { a: 'string' },
        tracker_page: 't',
        tracker_format: { group_by: 'y', columns: ['a'] },
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Missing required field: name');
    });

    test('empty source_queries fails', () => {
      const result = validateRecipe({
        name: 'test',
        source_queries: {},
        extraction_schema: { a: 'string' },
        tracker_page: 't',
        tracker_format: { group_by: 'y', columns: ['a'] },
      });
      expect(result.valid).toBe(false);
    });

    test('missing tracker_format columns fails', () => {
      const result = validateRecipe({
        name: 'test',
        source_queries: { gmail: ['test'] },
        extraction_schema: { a: 'string' },
        tracker_page: 't',
        tracker_format: { group_by: 'y', columns: [] },
      });
      expect(result.valid).toBe(false);
    });
  });

  describe('extractFields', () => {
    test('extracts MRR from text', () => {
      const result = extractFields('Our MRR hit $188K this month', { mrr: 'currency' });
      expect(result.mrr).toBe('188K');
    });

    test('extracts ARR from text', () => {
      const result = extractFields('ARR: $2.3M', { arr: 'currency' });
      expect(result.arr).toBe('2.3M');
    });

    test('extracts growth rate', () => {
      const result = extractFields('We grew +14.7% MoM', { growth_mom: 'percentage' });
      expect(result.growth_mom).toBe('+14.7%');
    });

    test('extracts runway months', () => {
      const result = extractFields('We have 16 months of runway', { runway_months: 'number' });
      expect(result.runway_months).toBe('16');
    });

    test('extracts headcount', () => {
      const result = extractFields('Team of 23 employees', { headcount: 'number' });
      expect(result.headcount).toBe('23');
    });

    test('extracts dollar amounts', () => {
      const result = extractFields('Total Charged\n$5,900.00', { amount: 'currency' });
      expect(result.amount).toBe('5,900.00');
    });

    test('returns null for unmatched fields', () => {
      const result = extractFields('no metrics here', { mrr: 'currency', arr: 'currency' });
      expect(result.mrr).toBeNull();
      expect(result.arr).toBeNull();
    });

    test('extracts dates', () => {
      const result = extractFields('Updated on 2026-04-15', { date: 'date' });
      expect(result.date).toBe('2026-04-15');
    });
  });

  describe('verifyExtraction', () => {
    test('matching fields verify OK', () => {
      const result = verifyExtraction(
        { mrr: '188K', arr: '2.3M' },
        { mrr: '188K', arr: '2.3M' },
      );
      expect(result.verified).toBe(true);
      expect(result.mismatches.length).toBe(0);
    });

    test('mismatched fields are flagged', () => {
      const result = verifyExtraction(
        { mrr: '188K', arr: '2.3M' },
        { mrr: '200K', arr: '2.3M' },
      );
      expect(result.verified).toBe(false);
      expect(result.mismatches.length).toBe(1);
      expect(result.mismatches[0]).toContain('mrr');
    });
  });

  describe('isDuplicate', () => {
    const existing = [
      { date: '2026-04-01', recipient: 'Alice', amount: '$100.00' },
      { date: '2026-04-01', recipient: 'Bob', amount: '$200.00' },
    ];

    test('exact match is duplicate', () => {
      const result = isDuplicate(existing, { date: '2026-04-01', recipient: 'Alice', amount: '$100.00' }, ['date', 'recipient', 'amount']);
      expect(result.isDuplicate).toBe(true);
      expect(result.type).toBe('exact');
    });

    test('new entry is not duplicate', () => {
      const result = isDuplicate(existing, { date: '2026-04-02', recipient: 'Charlie', amount: '$300.00' }, ['date', 'recipient', 'amount']);
      expect(result.isDuplicate).toBe(false);
      expect(result.type).toBe('new');
    });

    test('different amount same entity+date flagged', () => {
      const result = isDuplicate(
        existing,
        { date: '2026-04-01', recipient: 'Alice', amount: '$150.00' },
        ['date', 'recipient', 'amount'],
      );
      expect(result.type).toBe('different_amount');
    });

    test('fuzzy entity matching', () => {
      const result = isDuplicate(
        existing,
        { date: '2026-04-01', recipient: 'Alice Smith', amount: '$100.00' },
        ['date', 'recipient', 'amount'],
        { entityFuzzy: true },
      );
      // "Alice" and "Alice Smith" share first 5 chars but fuzzy is first 15
      // They won't fuzzy-match since "Alice" is only 5 chars
      expect(result.type).toBe('new');
    });
  });

  describe('parseTrackerPage', () => {
    test('parses markdown table into entries', () => {
      const md = `| Date | Amount | Status |
|------|--------|--------|
| 2026-04-01 | $100 | Done |
| 2026-04-02 | $200 | Pending |`;
      const entries = parseTrackerPage(md, ['Date', 'Amount', 'Status']);
      expect(entries.length).toBe(2);
      expect(entries[0]['Date']).toBe('2026-04-01');
      expect(entries[1]['Amount']).toBe('$200');
    });

    test('handles empty table', () => {
      const entries = parseTrackerPage('No table here', ['a', 'b']);
      expect(entries.length).toBe(0);
    });
  });

  describe('appendToTracker', () => {
    test('appends rows to markdown', () => {
      const md = '### 2026\n\n| Date | Amount |\n|------|--------|\n| 2026-01-01 | $50 |\n';
      const result = appendToTracker(md, [{ Date: '2026-04-01', Amount: '$100' }], ['Date', 'Amount']);
      expect(result).toContain('2026-04-01');
      expect(result).toContain('$100');
    });
  });

  describe('computeTotals', () => {
    test('sums numeric columns', () => {
      const entries = [
        { amount: '$100.00', count: '5' },
        { amount: '$200.50', count: '3' },
      ];
      const totals = computeTotals(entries, ['amount', 'count']);
      expect(totals.amount).toBeCloseTo(300.50, 2);
      expect(totals.count).toBe(8);
    });

    test('handles non-numeric values', () => {
      const entries = [{ amount: 'N/A' }];
      const totals = computeTotals(entries, ['amount']);
      expect(totals.amount).toBe(0);
    });
  });

  describe('buildDateWindows', () => {
    test('quarterly windows for one year', () => {
      const windows = buildDateWindows(2026, 2026, 'quarterly');
      expect(windows.length).toBe(4);
      expect(windows[0].label).toBe('Q1 2026');
      expect(windows[3].label).toBe('Q4 2026');
    });

    test('monthly windows for one year', () => {
      const windows = buildDateWindows(2026, 2026, 'monthly');
      expect(windows.length).toBe(12);
      expect(windows[0].label).toBe('2026-01');
      expect(windows[11].label).toBe('2026-12');
    });

    test('multi-year quarterly windows', () => {
      const windows = buildDateWindows(2024, 2026, 'quarterly');
      expect(windows.length).toBe(12); // 3 years * 4 quarters
    });

    test('endYear < startYear throws', () => {
      expect(() => buildDateWindows(2026, 2024)).toThrow('endYear');
    });
  });

  describe('stripEmailHtml', () => {
    test('strips HTML tags', () => {
      const result = stripEmailHtml('<p>Hello <b>World</b></p>');
      expect(result).toContain('Hello');
      expect(result).toContain('World');
      expect(result).not.toContain('<p>');
      expect(result).not.toContain('<b>');
    });

    test('removes style blocks', () => {
      const result = stripEmailHtml('<style>.foo { color: red; }</style><p>Content</p>');
      expect(result).toContain('Content');
      expect(result).not.toContain('color');
    });

    test('removes script blocks', () => {
      const result = stripEmailHtml('<script>alert("xss")</script><p>Safe</p>');
      expect(result).toContain('Safe');
      expect(result).not.toContain('alert');
    });

    test('decodes HTML entities', () => {
      const result = stripEmailHtml('&amp; &lt; &gt; &nbsp;');
      expect(result).toContain('&');
      expect(result).toContain('<');
      expect(result).toContain('>');
    });

    test('truncates >500KB input (ReDoS prevention)', () => {
      // Use a string just over 500KB to trigger truncation
      const huge = '<p>' + 'x'.repeat(510 * 1024) + '</p>';
      const result = stripEmailHtml(huge);
      // After truncation, length should be around 500KB + "[truncated]"
      expect(result).toContain('[truncated]');
    });

    test('completes quickly on large nested HTML', () => {
      // Generate HTML that could cause ReDoS without the size cap
      const nested = '<div>'.repeat(100) + 'content' + '</div>'.repeat(100);
      const start = performance.now();
      stripEmailHtml(nested);
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(100); // should be well under 100ms
    });
  });
});
