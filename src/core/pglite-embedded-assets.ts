import pgliteWasm from '../../node_modules/@electric-sql/pglite/dist/pglite.wasm' with { type: 'file' };
import initdbWasm from '../../node_modules/@electric-sql/pglite/dist/initdb.wasm' with { type: 'file' };
import fsBundle from '../../node_modules/@electric-sql/pglite/dist/pglite.data' with { type: 'file' };
import vectorArchive from '../../node_modules/@electric-sql/pglite/dist/vector.tar.gz' with { type: 'file' };
import trgmArchive from '../../node_modules/@electric-sql/pglite/dist/pg_trgm.tar.gz' with { type: 'file' };
import { readFileSync, mkdirSync, writeFileSync, renameSync, existsSync, statSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import type { PGliteOptions } from '@electric-sql/pglite';

function materialize(path: string, name: string): URL {
  const bytes = readFileSync(path);
  const hash = createHash('sha256').update(bytes).digest('hex');
  const directory = join(tmpdir(), 'pmbrain-pglite-assets');
  mkdirSync(directory, { recursive: true });
  const destination = join(directory, `${name}-${hash}.tar.gz`);
  if (!existsSync(destination) || statSync(destination).size !== bytes.length) {
    const temporary = `${destination}.${randomUUID()}.tmp`;
    writeFileSync(temporary, bytes);
    renameSync(temporary, destination);
  }
  return pathToFileURL(destination);
}

let options: Promise<Partial<PGliteOptions>> | undefined;
export function getEmbeddedPgliteOptions(): Promise<Partial<PGliteOptions>> {
  return options ??= (async () => {
    const [pgliteWasmModule, initdbWasmModule] = await Promise.all([
      WebAssembly.compile(readFileSync(pgliteWasm)),
      WebAssembly.compile(readFileSync(initdbWasm)),
    ]);
    const vectorBundle = materialize(vectorArchive, 'vector');
    const trgmBundle = materialize(trgmArchive, 'pg_trgm');
    return {
      pgliteWasmModule, initdbWasmModule,
      fsBundle: new Blob([readFileSync(fsBundle)]),
      extensions: {
        vector: { name: 'pgvector', setup: async (_pg, emscriptenOpts) => ({ emscriptenOpts, bundlePath: vectorBundle }) },
        pg_trgm: { name: 'pg_trgm', setup: async () => ({ bundlePath: trgmBundle }) },
      },
    };
  })();
}
