import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

const dataset: {
  version: number;
  license: string;
  documents: { id: string; title: string; language: string; chunks: string[] }[];
  queries: { id: string; text: string; language: string; relevant: string[] }[];
} = JSON.parse(readFileSync(new URL('./dataset.json', import.meta.url), 'utf8'));

describe('EmbeddingGemma follow-up corpus', () => {
  test('has the frozen schema, unique IDs, and valid relevance labels', () => {
    expect(Object.keys(dataset).sort()).toEqual(['documents', 'license', 'queries', 'version']);
    expect(dataset.version).toBe(1);
    expect(dataset.license).toBe('CC0-1.0');
    expect(dataset.documents.length).toBeGreaterThanOrEqual(20);
    expect(dataset.queries.length).toBeGreaterThanOrEqual(12);

    const documentIds = dataset.documents.map((document) => document.id);
    const queryIds = dataset.queries.map((query) => query.id);
    expect(new Set(documentIds).size).toBe(documentIds.length);
    expect(new Set(queryIds).size).toBe(queryIds.length);

    for (const document of dataset.documents) {
      expect(Object.keys(document).sort()).toEqual(['chunks', 'id', 'language', 'title']);
      expect(document.id.trim()).not.toBe('');
      expect(document.title.trim()).not.toBe('');
      expect(document.language.trim()).not.toBe('');
      expect(document.chunks.length).toBeGreaterThan(0);
      for (const chunk of document.chunks) {
        expect(chunk.trim()).not.toBe('');
        expect(chunk.length).toBeLessThan(800);
      }
    }
    for (const query of dataset.queries) {
      expect(Object.keys(query).sort()).toEqual(['id', 'language', 'relevant', 'text']);
      expect(query.id.trim()).not.toBe('');
      expect(query.text.trim()).not.toBe('');
      expect(query.language.trim()).not.toBe('');
      expect(query.relevant.length).toBeGreaterThan(0);
      for (const documentId of query.relevant) expect(documentIds).toContain(documentId);
    }
  });

  test('covers English, Spanish, Chinese, code, and title-dependent retrieval', () => {
    const documentLanguages = new Set(dataset.documents.map((document) => document.language));
    const queryLanguages = new Set(dataset.queries.map((query) => query.language));
    for (const language of ['en', 'es', 'zh']) {
      expect(documentLanguages).toContain(language);
      expect(queryLanguages).toContain(language);
    }

    expect(dataset.documents.some((document) =>
      document.chunks.some((chunk) => chunk.includes('```')),
    )).toBe(true);

    const byId = new Map(dataset.documents.map((document) => [document.id, document]));
    const titleCases: [string, string, string][] = [
      ['q-cold-battery-title', 'battery-cold-weather', 'battery'],
      ['q-smoke-filter-title', 'air-filter-smoke', 'indoor'],
      ['q-graywater-title', 'graywater-garden', 'irrigation'],
      ['q-passkey-title', 'passkey-recovery', 'passkey'],
    ];
    for (const [queryId, documentId, titleTerm] of titleCases) {
      const query = dataset.queries.find((item) => item.id === queryId);
      const document = byId.get(documentId);
      expect(query?.relevant).toContain(documentId);
      expect(query?.text.toLowerCase()).toContain(titleTerm);
      expect(document?.title.toLowerCase()).toContain(titleTerm);
      expect(document?.chunks.join(' ').toLowerCase()).not.toContain(titleTerm);
    }

    const ambiguous = dataset.queries.find((query) => query.id === 'q-ambiguous-labeled-supplies');
    expect(ambiguous?.relevant).toEqual(['trail-water-cache', 'seed-storage']);
    const spanishRecovery = dataset.queries.find((query) => query.id === 'q-spanish-cuenta');
    expect(spanishRecovery?.relevant).toEqual(['account-keys-es', 'passkey-recovery']);

    const blueLane = byId.get('blue-lane-maintenance');
    const greenLane = byId.get('green-lane-maintenance');
    const blueLaneQuery = dataset.queries.find((query) => query.id === 'q-blue-lane-title');
    const greenLaneQuery = dataset.queries.find((query) => query.id === 'q-green-lane-title');
    expect(blueLane?.chunks).toEqual(greenLane?.chunks);
    expect(blueLaneQuery?.text).toContain(blueLane?.title);
    expect(blueLaneQuery?.text).not.toContain(greenLane?.title);
    expect(greenLaneQuery?.text).toContain(greenLane?.title);
    expect(greenLaneQuery?.text).not.toContain(blueLane?.title);
    expect(blueLane?.chunks.join(' ').toLowerCase()).not.toContain('blue');
    expect(greenLane?.chunks.join(' ').toLowerCase()).not.toContain('green');
    expect(blueLaneQuery?.relevant).toEqual(['blue-lane-maintenance']);
    expect(greenLaneQuery?.relevant).toEqual(['green-lane-maintenance']);
  });
});
