import { createHash } from "node:crypto";

export const COE_CANONICALIZATION_PROFILE = "coe-c14n-json-v1" as const;

export const COE_ID_PREFIXES = [
  "src",
  "snp",
  "ndoc",
  "evd",
  "clm",
  "cedge",
  "vrf",
  "ret",
  "ans",
  "acm",
  "ctr",
  "evt",
  "pol",
] as const;

export type CoeIdPrefix = (typeof COE_ID_PREFIXES)[number];
export type CanonicalJson =
  | null
  | boolean
  | number
  | string
  | CanonicalJson[]
  | { [key: string]: CanonicalJson };

export class CanonicalizationError extends Error {
  readonly code = "invalid_canonical_value" as const;

  constructor(message: string) {
    super(message);
    this.name = "CanonicalizationError";
  }
}

function normalizeString(value: string): string {
  return value.replace(/\r\n?/g, "\n").normalize("NFC");
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function serialize(value: unknown, path: string): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number": {
      if (!Number.isFinite(value)) {
        throw new CanonicalizationError(`${path} contains a non-finite number`);
      }
      return JSON.stringify(Object.is(value, -0) ? 0 : value);
    }
    case "string":
      return JSON.stringify(normalizeString(value));
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((item, index) => serialize(item, `${path}[${index}]`)).join(",")}]`;
      }
      if (!isPlainObject(value)) {
        throw new CanonicalizationError(`${path} must contain only plain JSON objects`);
      }

      const normalizedEntries = new Map<string, unknown>();
      for (const [rawKey, item] of Object.entries(value)) {
        const key = normalizeString(rawKey);
        if (normalizedEntries.has(key)) {
          throw new CanonicalizationError(`${path} contains duplicate keys after normalization`);
        }
        normalizedEntries.set(key, item);
      }

      return `{${[...normalizedEntries.entries()]
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => `${JSON.stringify(key)}:${serialize(item, `${path}.${key}`)}`)
        .join(",")}}`;
    }
    default:
      throw new CanonicalizationError(`${path} contains unsupported type ${typeof value}`);
  }
}

export function canonicalizeJson(value: unknown): string {
  return serialize(value, "$");
}

export function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalizeJson(value), "utf8").digest("hex");
}

export function sha256Bytes(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function makeCoeId(prefix: CoeIdPrefix, identityPayload: unknown): string {
  return `${prefix}_${sha256Canonical({
    canonicalization_profile: COE_CANONICALIZATION_PROFILE,
    identity: identityPayload,
  })}`;
}
