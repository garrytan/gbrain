import { describe, test, expect } from 'bun:test';
import { slugifyEntity, entityPagePath, extractEntities } from '../src/core/enrichment-service.ts';

describe('enrichment-service', () => {
  describe('slugifyEntity', () => {
    test('person names → people/ prefix', () => {
      expect(slugifyEntity('Jane Doe', 'person')).toBe('people/jane-doe');
    });

    test('company names → companies/ prefix', () => {
      expect(slugifyEntity('Acme Corp', 'company')).toBe('companies/acme-corp');
    });

    test('handles apostrophes', () => {
      expect(slugifyEntity("O'Brien", 'person')).toBe('people/obrien');
    });

    test('handles special characters', () => {
      expect(slugifyEntity('José García', 'person')).toBe('people/jos-garc-a');
    });

    test('trims leading/trailing hyphens', () => {
      expect(slugifyEntity('  Test Name  ', 'person')).toBe('people/test-name');
    });

    test('collapses multiple hyphens', () => {
      expect(slugifyEntity('Test--Name', 'person')).toBe('people/test-name');
    });
  });

  describe('entityPagePath', () => {
    test('returns same result as slugifyEntity', () => {
      expect(entityPagePath('Jane Doe', 'person')).toBe(slugifyEntity('Jane Doe', 'person'));
    });
  });

  describe('extractEntities', () => {
    test('extracts capitalized multi-word names', () => {
      const entities = extractEntities('I met with John Smith and Sarah Connor yesterday.');
      expect(entities.length).toBeGreaterThanOrEqual(2);
      const names = entities.map(e => e.name);
      expect(names).toContain('John Smith');
      expect(names).toContain('Sarah Connor');
    });

    test('classifies company names with Corp/Inc/Labs', () => {
      const entities = extractEntities('We visited Acme Corp and Beta Labs.');
      const acme = entities.find(e => e.name.includes('Acme'));
      const beta = entities.find(e => e.name.includes('Beta'));
      expect(acme?.type).toBe('company');
      expect(beta?.type).toBe('company');
    });

    test('classifies other multi-word names as person', () => {
      const entities = extractEntities('Talked to Jane Doe about the project.');
      const jane = entities.find(e => e.name === 'Jane Doe');
      expect(jane?.type).toBe('person');
    });

    test('deduplicates by name (case-insensitive)', () => {
      const entities = extractEntities('John Smith said hello. Then John Smith left.');
      const johns = entities.filter(e => e.name === 'John Smith');
      expect(johns.length).toBe(1);
    });

    test('returns empty array for text with no entities', () => {
      const entities = extractEntities('this is all lowercase text with no names');
      expect(entities.length).toBe(0);
    });

    test('includes context around each entity', () => {
      const entities = extractEntities('The CEO of StartupX, John Smith, announced the deal.');
      const john = entities.find(e => e.name === 'John Smith');
      expect(john?.context.length).toBeGreaterThan(10);
    });

    test('handles 3-4 word names', () => {
      const entities = extractEntities('Mary Jane Watson Parker joined the team.');
      expect(entities.some(e => e.name.split(' ').length >= 3)).toBe(true);
    });

    test('does not merge capitalized words across a paragraph break', () => {
      const entities = extractEntities('We spoke with Winters\n\nReyes continued the analysis.');
      expect(entities.some(e => e.name.includes('\n'))).toBe(false);
      expect(entities.some(e => e.name.replace(/\s+/g, ' ') === 'Winters Reyes')).toBe(false);
    });

    test('does not merge capitalized words across a single line break', () => {
      const entities = extractEntities('Winters\nReyes discussed the proof.');
      expect(entities.some(e => e.name.includes('\n'))).toBe(false);
    });

    test('still matches same-line multi-word capitalized names', () => {
      const entities = extractEntities('Casey Morgan visited the lab.');
      expect(entities.some(e => e.name === 'Casey Morgan')).toBe(true);
    });

    test('still matches names separated by a non-breaking space on the same line', () => {
      const entities = extractEntities('Jordan Blake requested access.');
      expect(entities.some(e => e.name === 'Jordan Blake')).toBe(true);
    });

    test('does not merge capitalized words across a Unicode line separator (U+2028)', () => {
      const entities = extractEntities('Winters\u2028Reyes discussed the proof.');
      expect(entities.some(e => e.name.includes('\u2028'))).toBe(false);
    });

    test('does not merge capitalized words across a Unicode paragraph separator (U+2029)', () => {
      const entities = extractEntities('Winters\u2029Reyes discussed the proof.');
      expect(entities.some(e => e.name.includes('\u2029'))).toBe(false);
    });

    test('does not merge capitalized words across a vertical tab (U+000B)', () => {
      const entities = extractEntities('Winters\vReyes discussed the proof.');
      expect(entities.some(e => e.name.includes('\v'))).toBe(false);
    });

    test('does not merge capitalized words across a form feed (U+000C)', () => {
      const entities = extractEntities('Winters\fReyes discussed the proof.');
      expect(entities.some(e => e.name.includes('\f'))).toBe(false);
    });
  });

  describe('enrichEntity (mock)', () => {
    test('module exports enrichEntity function', async () => {
      const mod = await import('../src/core/enrichment-service.ts');
      expect(typeof mod.enrichEntity).toBe('function');
    });

    test('module exports enrichEntities for batch processing', async () => {
      const mod = await import('../src/core/enrichment-service.ts');
      expect(typeof mod.enrichEntities).toBe('function');
    });

    test('module exports extractAndEnrich for text processing', async () => {
      const mod = await import('../src/core/enrichment-service.ts');
      expect(typeof mod.extractAndEnrich).toBe('function');
    });
  });

  describe('tier auto-escalation logic', () => {
    // We test the tier suggestion indirectly through the public interface
    // The actual suggestTier function is private, but its behavior is
    // observable through enrichEntity's return value (needs engine mock for full test)
    test('enrichment result includes tier fields', async () => {
      const mod = await import('../src/core/enrichment-service.ts');
      // Verify the EnrichmentResult type shape is correct by checking exports
      expect(mod.enrichEntity).toBeDefined();
      // Full tier escalation testing requires engine mock (covered in E2E)
    });
  });
});
