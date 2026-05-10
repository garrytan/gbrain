// Compiled-binary smoke test for HEIC/AVIF decoders.
//
// Verifies that bun --compile produces a binary where heic-decode and
// @jsquash/avif both load their WASM and successfully decode a fixture
// to a non-empty pixel buffer.
//
// Output: a single JSON line on stdout.
//   {"heic":{"ok":true,"width":N,"height":N,"bytes":N},"avif":{"ok":true,...}}
//
// Exit code 0 on full success, 1 on any decode failure.
//
// Used by scripts/check-image-decoders-embedded.sh as a CI guard.
//
// The fixture paths are resolved at compile time via import attributes so
// bun --compile embeds the bytes into the binary itself. Otherwise a compiled
// binary running away from the repo would fail to find the fixtures.

import heicFixture from '../test/fixtures/images/tiny.heic' with { type: 'file' };
import avifFixture from '../test/fixtures/images/tiny.avif' with { type: 'file' };
// @jsquash/avif loads its WASM relative to its own JS file, which fails inside
// a bun --compile VFS. Pre-compile the module via `init()` with the embedded
// bytes — `with { type: 'file' }` works correctly inside compiled binaries.
import avifWasmPath from '@jsquash/avif/codec/dec/avif_dec.wasm' with { type: 'file' };
import { readFileSync } from 'node:fs';

import heicDecode from 'heic-decode';
import avifDecode, { init as initAvif } from '@jsquash/avif/decode.js';

interface DecodeResult {
  ok: boolean;
  width?: number;
  height?: number;
  bytes?: number;
  error?: string;
}

async function decodeHeic(): Promise<DecodeResult> {
  try {
    const buf = readFileSync(heicFixture);
    const result = await heicDecode({ buffer: buf });
    if (!result || !result.data || result.data.byteLength === 0) {
      return { ok: false, error: 'heic-decode returned empty pixel buffer' };
    }
    return {
      ok: true,
      width: result.width,
      height: result.height,
      bytes: result.data.byteLength,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function decodeAvif(): Promise<DecodeResult> {
  try {
    const wasmBytes = readFileSync(avifWasmPath);
    const wasmModule = await WebAssembly.compile(wasmBytes);
    await initAvif(wasmModule);
    const buf = readFileSync(avifFixture);
    const result = await avifDecode(buf);
    if (!result || !result.data || result.data.byteLength === 0) {
      return { ok: false, error: 'avif decode returned empty pixel buffer' };
    }
    return {
      ok: true,
      width: result.width,
      height: result.height,
      bytes: result.data.byteLength,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const heic = await decodeHeic();
const avif = await decodeAvif();
const allOk = heic.ok && avif.ok;
console.log(JSON.stringify({ heic, avif, ok: allOk }));
process.exit(allOk ? 0 : 1);
