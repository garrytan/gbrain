import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

const dataset = JSON.parse(
  readFileSync(new URL("./dataset.json", import.meta.url), "utf8"),
);

describe("EmbeddingGemma follow-up corpus", () => {
  test("has the frozen schema, unique content, and valid relevance labels", () => {
    expect(Object.keys(dataset).sort()).toEqual(["documents", "license", "queries", "version"]);
    expect(dataset.version).toBe(1);
    expect(dataset.license).toBe("CC0-1.0");
    expect(dataset.documents.length).toBeGreaterThanOrEqual(20);
    expect(dataset.queries.length).toBeGreaterThanOrEqual(12);

    const documentIds = dataset.documents.map((document: { id: string }) => document.id);
    const queryIds = dataset.queries.map((query: { id: string }) => query.id);
    expect(new Set(documentIds).size).toBe(documentIds.length);
    expect(new Set(queryIds).size).toBe(queryIds.length);

    const chunks = dataset.documents.flatMap((document: { chunks: string[] }) => document.chunks);
    expect(new Set(chunks).size).toBe(chunks.length);
    for (const document of dataset.documents) {
      expect(Object.keys(document).sort()).toEqual(["chunks", "id", "language", "title"]);
      expect(document.id.trim()).not.toBe("");
      expect(document.title.trim()).not.toBe("");
      expect(document.language.trim()).not.toBe("");
      expect(document.chunks.length).toBeGreaterThan(0);
      for (const chunk of document.chunks) {
        expect(chunk.trim()).not.toBe("");
        expect(chunk.length).toBeLessThan(800);
      }
    }
    for (const query of dataset.queries) {
      expect(Object.keys(query).sort()).toEqual(["id", "language", "relevant", "text"]);
      expect(query.id.trim()).not.toBe("");
      expect(query.text.trim()).not.toBe("");
      expect(query.language.trim()).not.toBe("");
      expect(query.relevant.length).toBeGreaterThan(0);
      for (const documentId of query.relevant) expect(documentIds).toContain(documentId);
    }
  });

  test("covers English, Spanish, Chinese, code, and title-dependent retrieval", () => {
    const documentLanguages = new Set(dataset.documents.map((document: { language: string }) => document.language));
    const queryLanguages = new Set(dataset.queries.map((query: { language: string }) => query.language));
    for (const language of ["en", "es", "zh"]) {
      expect(documentLanguages).toContain(language);
      expect(queryLanguages).toContain(language);
    }

    expect(dataset.documents.some((document: { chunks: string[] }) =>
      document.chunks.some((chunk) => chunk.includes("```")),
    )).toBe(true);

    const byId = new Map(dataset.documents.map((document: { id: string; title: string }) => [document.id, document]));
    for (const [queryId, documentId, titleTerm] of [
      ["q-cold-battery-title", "battery-cold-weather", "battery"],
      ["q-smoke-filter-title", "air-filter-smoke", "indoor"],
      ["q-graywater-title", "graywater-garden", "irrigation"],
      ["q-passkey-title", "passkey-recovery", "passkey"],
    ]) {
      const query = dataset.queries.find((item: { id: string }) => item.id === queryId);
      const document = byId.get(documentId);
      expect(query?.relevant).toContain(documentId);
      expect(query?.text.toLowerCase()).toContain(titleTerm);
      expect(document?.title.toLowerCase()).toContain(titleTerm);
      expect(document?.chunks.join(" ").toLowerCase()).not.toContain(titleTerm);
    }

    const ambiguous = dataset.queries.find((query: { id: string }) => query.id === "q-ambiguous-labeled-supplies");
    expect(ambiguous?.relevant).toEqual(["trail-water-cache", "seed-storage"]);
  });
});
