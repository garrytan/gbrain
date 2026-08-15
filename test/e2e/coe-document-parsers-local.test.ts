import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { makeCoeId, type SourceContract } from "../../src/coe/contracts/index.ts";
import {
  CoeEvidenceLedger,
  InMemoryCoeEvidenceProjection,
  createHtmlDocumentNormalizer,
  createPdfDocumentNormalizer,
  preflightDocumentParsers,
} from "../../src/coe/evidence/index.ts";
import {
  CoeSnapshotLedger,
  InMemoryCoeSnapshotProjection,
} from "../../src/coe/registry/index.ts";

const enabled = process.env.COE_PARSER_E2E === "1";
const FIXED_TIME = "2026-08-04T19:30:00.000Z";

function sourceFor(uri: string): SourceContract {
  const sourceId = makeCoeId("src", { canonical_uri: uri, source_kind: "paper" });
  return {
    schema_version: "1.0.0",
    source_id: sourceId,
    source_kind: "paper",
    title: "Parser fixture",
    canonical_uri: uri,
    authors: [],
    language: "en",
    external_identifiers: [],
    scope: {
      brain_id: "science-one-coe",
      visibility: "private",
      owner_principal: "principal-owner",
      reader_principals: [],
      source_ids: [sourceId],
    },
    created_at: FIXED_TIME,
    created_by: { actor_type: "system", actor_id: "coe-parser-test" },
  };
}

function minimalPdf(text: string): Buffer {
  const escaped = text.replace(/([\\()])/g, "\\$1");
  const stream = `BT\n/F1 18 Tf\n72 720 Td\n(${escaped}) Tj\nET\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
  ];
  let serialized = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(serialized));
    serialized += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(serialized);
  serialized += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) serialized += `${String(offset).padStart(10, "0")} 00000 n \n`;
  serialized += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(serialized, "ascii");
}

describe.skipIf(!enabled)("CoE local deterministic HTML/PDF parser bridge", () => {
  let root: string;
  let snapshotLedger: CoeSnapshotLedger;
  let evidenceLedger: CoeEvidenceLedger;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "gbrain-coe-parser-e2e-"));
    snapshotLedger = new CoeSnapshotLedger({
      root,
      projection: new InMemoryCoeSnapshotProjection(),
      clock: () => new Date(FIXED_TIME),
      nonce: () => crypto.randomUUID(),
    });
    evidenceLedger = new CoeEvidenceLedger({
      root,
      snapshotLedger,
      projection: new InMemoryCoeEvidenceProjection(),
      clock: () => new Date(FIXED_TIME),
      nonce: () => crypto.randomUUID(),
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("preflight records the exact local parser identities", async () => {
    const preflight = await preflightDocumentParsers();
    expect(preflight.html.available).toBe(true);
    expect(preflight.pdf.available).toBe(true);
    expect(preflight.pdf.name).toBe("PyMuPDF");
  });

  test("HTML extraction omits executable content and emits blocking figure warnings", async () => {
    const uri = "https://example.invalid/parser.html";
    const snapshot = await snapshotLedger.acquire({
      source: sourceFor(uri),
      content: "<!doctype html><html><head><meta charset='utf-8'><title>Fixture</title><script>hidden payload</script></head><body><h1>Methods</h1><p>The method is deterministic.</p><table><tr><td>Recall</td><td>0.91</td></tr></table><img src='figure.png'><p>Text after the void image remains addressable.</p></body></html>",
      requested_uri: uri,
      final_uri: uri,
      media_type: "text/html",
      acquisition_method: "http",
      acquired_at: FIXED_TIME,
    });
    const normalizer = await createHtmlDocumentNormalizer();
    const result = await evidenceLedger.normalizeSnapshot(snapshot.snapshot!.snapshot_id, normalizer);

    expect(result.evidence_items.some(({ normalized_text }) => normalized_text.includes("hidden payload"))).toBe(false);
    expect(result.evidence_items.filter(({ evidence_type }) => evidence_type === "table_cell")).toHaveLength(2);
    expect(result.evidence_items.some(({ normalized_text }) =>
      normalized_text === "Text after the void image remains addressable."
    )).toBe(true);
    expect(result.normalized_document.warnings.some(({ code, severity }) =>
      code === "html_figure_without_text" && severity === "blocking"
    )).toBe(true);
    expect((await evidenceLedger.verifyBundle(
      result.normalized_document.normalized_document_id,
      normalizer,
    )).raw_mapping_verified).toBe(true);
  });

  test("HTML extraction keeps rendered MathML text but omits annotation alternatives", async () => {
    const uri = "https://example.invalid/mathml-parser.html";
    const snapshot = await snapshotLedger.acquire({
      source: sourceFor(uri),
      content: "<!doctype html><html><body><table><tr><td>2.2 <math><semantics><mo>±</mo><annotation encoding='application/x-tex'>\\pm</annotation><annotation-xml encoding='application/xhtml+xml'><span>hidden alternative</span></annotation-xml></semantics></math> 1.5</td></tr></table></body></html>",
      requested_uri: uri,
      final_uri: uri,
      media_type: "text/html",
      acquisition_method: "http",
      acquired_at: FIXED_TIME,
    });
    const normalizer = await createHtmlDocumentNormalizer();
    const result = await evidenceLedger.normalizeSnapshot(snapshot.snapshot!.snapshot_id, normalizer);
    const cells = result.evidence_items.filter(({ evidence_type }) => evidence_type === "table_cell");

    expect(cells.map(({ normalized_text }) => normalized_text)).toEqual(["2.2 ± 1.5"]);
    expect(cells.some(({ normalized_text }) => normalized_text.includes("\\pm"))).toBe(false);
    expect(cells.some(({ normalized_text }) => normalized_text.includes("hidden alternative"))).toBe(false);
    expect(normalizer.descriptor.version).toStartWith("1.2.0+");
  });

  test("PDF extraction keeps page locators and blocks unstructured table or figure claims", async () => {
    const uri = "https://example.invalid/parser.pdf";
    const snapshot = await snapshotLedger.acquire({
      source: sourceFor(uri),
      content: minimalPdf("Table 1: Stable PDF evidence"),
      requested_uri: uri,
      final_uri: uri,
      media_type: "application/pdf",
      acquisition_method: "http",
      acquired_at: FIXED_TIME,
    });
    const normalizer = await createPdfDocumentNormalizer();
    const result = await evidenceLedger.normalizeSnapshot(snapshot.snapshot!.snapshot_id, normalizer);

    expect(result.evidence_items.some(({ normalized_text }) => normalized_text.includes("Stable PDF evidence"))).toBe(true);
    expect(result.evidence_items.every(({ raw_locator }) => raw_locator.kind === "pdf_page")).toBe(true);
    expect(result.normalized_document.warnings.some(({ code, severity }) =>
      code === "pdf_tables_not_structured" && severity === "blocking"
    )).toBe(true);
    expect((await evidenceLedger.verifyBundle(
      result.normalized_document.normalized_document_id,
      normalizer,
    )).raw_mapping_verified).toBe(true);
  });

  test("PDF extraction does not invent a table warning without a detected candidate", async () => {
    const uri = "https://example.invalid/plain-parser.pdf";
    const snapshot = await snapshotLedger.acquire({
      source: sourceFor(uri),
      content: minimalPdf("Stable PDF evidence without a table"),
      requested_uri: uri,
      final_uri: uri,
      media_type: "application/pdf",
      acquisition_method: "http",
      acquired_at: FIXED_TIME,
    });
    const result = await evidenceLedger.normalizeSnapshot(
      snapshot.snapshot!.snapshot_id,
      await createPdfDocumentNormalizer(),
    );

    expect(result.normalized_document.warnings.some(({ code }) =>
      code === "pdf_tables_not_structured"
    )).toBe(false);
  });
});
