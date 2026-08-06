import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import {
  CoeContractError,
  RawLocatorSchema,
  canonicalizeJson,
  sha256Bytes,
} from "../contracts/index.ts";
import {
  NORMALIZATION_BLOCK_KINDS,
  type DocumentNormalizer,
  type NormalizerOutput,
} from "./types.ts";

const HELPER_PATH = fileURLToPath(new URL("./parse_document.py", import.meta.url));
const MAX_INPUT_BYTES = 32 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const PARSER_TIMEOUT_MS = 60_000;

const PreflightSchema = z.strictObject({
  python: z.string().min(1),
  html: z.strictObject({
    available: z.boolean(),
    name: z.string().min(1),
    version: z.string().min(1).nullable(),
  }),
  pdf: z.strictObject({
    available: z.boolean(),
    name: z.string().min(1),
    version: z.string().min(1).nullable(),
  }),
});

const ParserOutputSchema = z.strictObject({
  parser: z.strictObject({ name: z.string().min(1), version: z.string().min(1) }),
  blocks: z.array(z.strictObject({
    block_id: z.string().min(1),
    kind: z.enum(NORMALIZATION_BLOCK_KINDS),
    text: z.string().min(1),
    raw_text: z.string().optional(),
    raw_locator: RawLocatorSchema,
    heading_level: z.number().int().min(1).max(6).optional(),
  })),
  warnings: z.array(z.strictObject({
    code: z.string().min(1),
    message: z.string().min(1),
    severity: z.enum(["warning", "blocking"]),
    locator: RawLocatorSchema.optional(),
  })),
});

export type DocumentParserPreflight = z.output<typeof PreflightSchema>;

async function runProcess(argv: string[], timeoutMs: number): Promise<Buffer> {
  const processHandle = Bun.spawn(argv, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      PYTHONNOUSERSITE: "1",
      PYTHONUTF8: "1",
    },
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    processHandle.kill();
  }, timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(processHandle.stdout).arrayBuffer(),
      new Response(processHandle.stderr).arrayBuffer(),
      processHandle.exited,
    ]);
    if (timedOut) throw new CoeContractError("policy_violation", "Document parser exceeded its time limit");
    if (exitCode !== 0) {
      const diagnostic = Buffer.from(stderr).toString("utf8", 0, 300).replace(/\s+/g, " ").trim();
      throw new CoeContractError(
        "invalid_contract",
        diagnostic ? `Document parser failed: ${diagnostic}` : `Document parser exited with status ${exitCode}`,
      );
    }
    const output = Buffer.from(stdout);
    if (output.byteLength > MAX_OUTPUT_BYTES) {
      throw new CoeContractError("policy_violation", "Document parser output exceeds the configured byte limit");
    }
    return output;
  } finally {
    clearTimeout(timer);
  }
}

export async function preflightDocumentParsers(pythonBinary = "python3"): Promise<DocumentParserPreflight> {
  let output: Buffer;
  try {
    output = await runProcess([pythonBinary, HELPER_PATH, "--preflight"], 10_000);
  } catch (error) {
    if (error instanceof CoeContractError) throw error;
    throw new CoeContractError("policy_violation", "Python document-parser runtime is unavailable");
  }
  try {
    return PreflightSchema.parse(JSON.parse(output.toString("utf8")));
  } catch {
    throw new CoeContractError("invalid_contract", "Document-parser preflight returned an invalid contract");
  }
}

export class PythonDocumentNormalizer implements DocumentNormalizer {
  readonly descriptor;

  private constructor(
    private readonly kind: "html" | "pdf",
    private readonly pythonBinary: string,
    private readonly parser: { name: string; version: string },
  ) {
    const bridgeRevision = kind === "html" ? "1.2.0" : "1.1.0";
    this.descriptor = {
      name: kind === "html" ? "coe-html-blocks" : "coe-pdf-pymupdf",
      version: `${bridgeRevision}+${parser.name.replace(/[^A-Za-z0-9]+/g, "-").toLowerCase()}-${parser.version}`,
      config_hash: sha256Bytes(canonicalizeJson({
        bridge_revision: bridgeRevision,
        parser,
        offsets: "utf8-bytes",
        max_input_bytes: MAX_INPUT_BYTES,
        max_output_bytes: MAX_OUTPUT_BYTES,
        timeout_ms: PARSER_TIMEOUT_MS,
      })),
    };
  }

  static async create(kind: "html" | "pdf", pythonBinary = "python3"): Promise<PythonDocumentNormalizer> {
    const preflight = await preflightDocumentParsers(pythonBinary);
    const selected = preflight[kind];
    if (!selected.available || !selected.version) {
      throw new CoeContractError("policy_violation", `${selected.name} is unavailable for ${kind.toUpperCase()} normalization`);
    }
    return new PythonDocumentNormalizer(kind, pythonBinary, { name: selected.name, version: selected.version });
  }

  supports(mediaType: string): boolean {
    const normalized = mediaType.split(";", 1)[0]!.trim().toLowerCase();
    return this.kind === "html"
      ? normalized === "text/html" || normalized === "application/xhtml+xml"
      : normalized === "application/pdf";
  }

  async normalize({ bytes }: Parameters<DocumentNormalizer["normalize"]>[0]): Promise<NormalizerOutput> {
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_INPUT_BYTES) {
      throw new CoeContractError("policy_violation", `Document input must contain 1 to ${MAX_INPUT_BYTES} bytes`);
    }
    const directory = await mkdtemp(join(tmpdir(), "gbrain-coe-parser-"));
    const inputPath = join(directory, this.kind === "html" ? "input.html" : "input.pdf");
    try {
      await writeFile(inputPath, bytes, { mode: 0o600 });
      const output = await runProcess(
        [this.pythonBinary, HELPER_PATH, "--kind", this.kind, "--input", inputPath],
        PARSER_TIMEOUT_MS,
      );
      let parsed: z.output<typeof ParserOutputSchema>;
      try {
        parsed = ParserOutputSchema.parse(JSON.parse(output.toString("utf8")));
      } catch {
        throw new CoeContractError("invalid_contract", "Document parser returned an invalid normalization contract");
      }
      if (parsed.parser.name !== this.parser.name || parsed.parser.version !== this.parser.version) {
        throw new CoeContractError("id_mismatch", "Document parser identity changed after preflight");
      }
      return { blocks: parsed.blocks, warnings: parsed.warnings };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

export async function createHtmlDocumentNormalizer(pythonBinary = "python3"): Promise<PythonDocumentNormalizer> {
  return PythonDocumentNormalizer.create("html", pythonBinary);
}

export async function createPdfDocumentNormalizer(pythonBinary = "python3"): Promise<PythonDocumentNormalizer> {
  return PythonDocumentNormalizer.create("pdf", pythonBinary);
}
