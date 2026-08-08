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
const MAX_DIAGNOSTIC_OUTPUT_BYTES = 64 * 1024;
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

async function readBoundedStream(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  onOverflow: () => void,
): Promise<Buffer> {
  const reader = stream.getReader();
  const output = Buffer.allocUnsafe(maxBytes);
  let bufferedBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - bufferedBytes;
      if (value.byteLength > remaining) {
        if (remaining > 0) {
          output.set(value.subarray(0, remaining), bufferedBytes);
          bufferedBytes += remaining;
        }
        onOverflow();
        await reader.cancel().catch(() => undefined);
        break;
      }
      output.set(value, bufferedBytes);
      bufferedBytes += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  return output.subarray(0, bufferedBytes);
}

function killProcessTree(processHandle: Bun.Subprocess): void {
  if (process.platform === "win32") {
    const result = Bun.spawnSync(
      ["taskkill", "/pid", String(processHandle.pid), "/T", "/F"],
      { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
    );
    if (result.exitCode === 0) return;
  } else {
    try {
      process.kill(-processHandle.pid, "SIGKILL");
      return;
    } catch {
      // Fall back to the direct child if process-group termination is unavailable.
    }
  }
  processHandle.kill("SIGKILL");
}

async function runProcess(argv: string[], timeoutMs: number): Promise<Buffer> {
  const processHandle = Bun.spawn(argv, {
    detached: true,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      PYTHONNOUSERSITE: "1",
      PYTHONUTF8: "1",
    },
  });
  let terminationError: CoeContractError | undefined;
  const terminate = (error: CoeContractError) => {
    if (terminationError) return;
    terminationError = error;
    killProcessTree(processHandle);
  };
  const timer = setTimeout(() => terminate(
    new CoeContractError("policy_violation", "Document parser exceeded its time limit"),
  ), timeoutMs);
  try {
    const results = await Promise.allSettled([
      readBoundedStream(processHandle.stdout, MAX_OUTPUT_BYTES, () => terminate(
        new CoeContractError("policy_violation", "Document parser output exceeds the configured byte limit"),
      )),
      readBoundedStream(processHandle.stderr, MAX_DIAGNOSTIC_OUTPUT_BYTES, () => terminate(
        new CoeContractError("policy_violation", "Document parser diagnostic output exceeds the configured byte limit"),
      )),
      processHandle.exited,
    ]);
    if (terminationError) throw terminationError;
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (rejected) throw rejected.reason;
    const stdout = (results[0] as PromiseFulfilledResult<Buffer>).value;
    const stderr = (results[1] as PromiseFulfilledResult<Buffer>).value;
    const exitCode = (results[2] as PromiseFulfilledResult<number>).value;
    if (exitCode !== 0) {
      const diagnostic = stderr.toString("utf8", 0, 300).replace(/\s+/g, " ").trim();
      throw new CoeContractError(
        "invalid_contract",
        diagnostic ? `Document parser failed: ${diagnostic}` : `Document parser exited with status ${exitCode}`,
      );
    }
    return stdout;
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
        max_diagnostic_output_bytes: MAX_DIAGNOSTIC_OUTPUT_BYTES,
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
