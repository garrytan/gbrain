// Ambient declarations for image-decoder packages whose own types don't
// expose subpath imports cleanly. v0.27.1 multimodal ingestion needs
// `heic-decode` (no @types package on npm) and `@jsquash/png/encode.js`
// (subpath the package.json exports map doesn't expose).

declare module 'heic-decode' {
  interface HeicDecodeResult {
    width: number;
    height: number;
    data: Uint8ClampedArray | Uint8Array;
  }
  interface HeicDecodeOptions {
    buffer: Uint8Array | Buffer;
  }
  const heicDecode: (opts: HeicDecodeOptions) => Promise<HeicDecodeResult>;
  export default heicDecode;
  export const all: (opts: HeicDecodeOptions) => Promise<HeicDecodeResult[]>;
}

declare module '@jsquash/png/encode.js' {
  interface ImageDataLike {
    data: Uint8ClampedArray;
    width: number;
    height: number;
  }
  const encode: (data: ImageDataLike, options?: { bitDepth?: 8 | 16 }) => Promise<ArrayBuffer>;
  export default encode;
  export function init(module?: WebAssembly.Module): Promise<unknown>;
}

declare module '@jsquash/avif/codec/dec/avif_dec.wasm' {
  const path: string;
  export default path;
}
