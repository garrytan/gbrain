import { CoeContractError, canonicalizeJson, sha256Bytes } from "../contracts/index.ts";
import type { DocumentNormalizer, NormalizationBlock, NormalizerOutput } from "./types.ts";
import { decodeUtf8 } from "./utf8.ts";

const MAX_JSON_BLOCKS = 50_000;

function pointerToken(value: string): string {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}

export class JsonDocumentNormalizer implements DocumentNormalizer {
  readonly descriptor = {
    name: "coe-json-pointers",
    version: "1.0.0",
    config_hash: sha256Bytes(canonicalizeJson({
      canonicalization: "coe-c14n-json-v1",
      blocks: "leaf-json-pointers",
      max_blocks: MAX_JSON_BLOCKS,
    })),
  } as const;

  supports(mediaType: string): boolean {
    const normalized = mediaType.split(";", 1)[0]!.trim().toLowerCase();
    return normalized === "application/json" || normalized.endsWith("+json");
  }

  async normalize({ bytes }: Parameters<DocumentNormalizer["normalize"]>[0]): Promise<NormalizerOutput> {
    let root: unknown;
    try {
      root = JSON.parse(decodeUtf8(bytes));
    } catch {
      throw new CoeContractError("invalid_json", "JSON normalizer received invalid JSON bytes");
    }
    const blocks: NormalizationBlock[] = [];
    const visit = (value: unknown, pointer: string): void => {
      if (blocks.length >= MAX_JSON_BLOCKS) {
        throw new CoeContractError("policy_violation", `JSON normalization exceeds ${MAX_JSON_BLOCKS} evidence blocks`);
      }
      if (Array.isArray(value)) {
        if (value.length === 0) {
          blocks.push({
            block_id: `json:${pointer || "/"}`,
            kind: "metadata",
            text: `${pointer || "/"} = []`,
            raw_text: "[]",
            raw_locator: { kind: "block", block_id: `json:${pointer || "/"}` },
          });
          return;
        }
        value.forEach((item, index) => visit(item, `${pointer}/${index}`));
        return;
      }
      if (typeof value === "object" && value !== null) {
        const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0
        );
        if (entries.length === 0) {
          blocks.push({
            block_id: `json:${pointer || "/"}`,
            kind: "metadata",
            text: `${pointer || "/"} = {}`,
            raw_text: "{}",
            raw_locator: { kind: "block", block_id: `json:${pointer || "/"}` },
          });
          return;
        }
        for (const [key, item] of entries) visit(item, `${pointer}/${pointerToken(key)}`);
        return;
      }
      const canonical = canonicalizeJson(value);
      blocks.push({
        block_id: `json:${pointer || "/"}`,
        kind: "metadata",
        text: `${pointer || "/"} = ${canonical}`,
        raw_text: canonical,
        raw_locator: { kind: "block", block_id: `json:${pointer || "/"}` },
      });
    };
    visit(root, "");
    return { blocks, warnings: [] };
  }
}
