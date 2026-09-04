/**
 * Internal carrier for an MCP-native image response.
 *
 * Operation handlers return ordinary JSON-compatible metadata plus a
 * symbol-keyed byte payload. JSON.stringify deliberately cannot see symbol
 * properties, so CLI/logging paths never turn the image into a giant base64
 * text blob. The MCP dispatcher is the only layer that encodes the bytes, and
 * it places them in a protocol `type: "image"` content block.
 */

export interface NativeImagePayload {
  bytes: Uint8Array;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
}

export const NATIVE_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

const NATIVE_IMAGE_PAYLOAD = Symbol('gbrain.native-image-payload');

export type NativeImageResult = Record<string, unknown> & {
  [NATIVE_IMAGE_PAYLOAD]: NativeImagePayload;
};

export function nativeImageResult(
  metadata: Record<string, unknown>,
  payload: NativeImagePayload,
): NativeImageResult {
  const result = { ...metadata } as NativeImageResult;
  Object.defineProperty(result, NATIVE_IMAGE_PAYLOAD, {
    value: payload,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return result;
}

export function getNativeImagePayload(value: unknown): NativeImagePayload | null {
  if (value === null || typeof value !== 'object') return null;
  const payload = (value as Partial<NativeImageResult>)[NATIVE_IMAGE_PAYLOAD];
  if (!payload || !(payload.bytes instanceof Uint8Array)) return null;
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(payload.mimeType)) return null;
  return payload;
}
