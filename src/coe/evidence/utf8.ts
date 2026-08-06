import { CoeContractError } from "../contracts/index.ts";

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export function decodeUtf8(bytes: Uint8Array): string {
  try {
    return UTF8_DECODER.decode(bytes);
  } catch {
    throw new CoeContractError("invalid_contract", "Content is not valid UTF-8");
  }
}

export function normalizeUnicodeText(value: string): string {
  return value.replace(/\r\n?/g, "\n").normalize("NFC");
}

export function sliceUtf8(bytes: Uint8Array, start: number, end: number): string {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > bytes.byteLength) {
    throw new CoeContractError("invalid_contract", "Normalized span is outside the normalized byte object");
  }
  try {
    return UTF8_DECODER.decode(bytes.subarray(start, end));
  } catch {
    throw new CoeContractError("invalid_contract", "Normalized span does not align to a UTF-8 boundary");
  }
}
