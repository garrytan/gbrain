/** Bun asset anchor, loaded only when the synchronous encoder is first used.
 * The package's Node loader reads WASM relative to its build-time __dirname;
 * explicit file imports instead survive bun build --compile relocation.
 */
import { readFileSync } from 'node:fs';
import wasmPath from '@dqbd/tiktoken/lite/tiktoken_bg.wasm' with { type: 'file' };
import cl100k from '@dqbd/tiktoken/encoders/cl100k_base.json';
import { Tiktoken } from '@dqbd/tiktoken/lite/init';

// init's async wrapper re-exports the WASM glue. Use the same synchronous
// handshake as tiktoken's Node loader so estimateTokens remains synchronous,
// without top-level await or eagerly initializing the encoder at CLI startup.
const glue = require('@dqbd/tiktoken/lite/init');
// The package's .wasm.d.ts describes native WASM exports; Bun's file loader
// returns a path instead, in both source and compiled execution.
const wasm = new WebAssembly.Module(readFileSync(wasmPath as unknown as string));
const instance = new WebAssembly.Instance(wasm, { './tiktoken_bg.js': glue });
glue.__wbg_set_wasm(instance.exports);

export function createEncoder(): Tiktoken {
  return new Tiktoken(cl100k.bpe_ranks, cl100k.special_tokens, cl100k.pat_str);
}
