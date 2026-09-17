#!/usr/bin/env bun
/** Verify source-to-manifest freshness and the exact vendored binary set. */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inputDigest, targets } from './build.ts';
import manifest from '../../native/locks/manifest.json';

const root = resolve(import.meta.dir, '../../native/locks/prebuilds');
if (manifest.version !== 1 || manifest.napi !== 3 || manifest.zig !== '0.14.1') throw new Error('Native prebuild manifest format mismatch');
if (manifest.input_sha256 !== inputDigest()) throw new Error('Native lock source changed: rebuild all prebuilds and their manifest');
const expected = Object.keys(targets).sort();
if (JSON.stringify(Object.keys(manifest.artifacts).sort()) !== JSON.stringify(expected)) throw new Error('Native artifact target set is incomplete');
if (JSON.stringify(readdirSync(root).sort()) !== JSON.stringify(expected.map(target => `${target}.node`).sort())) throw new Error('Native prebuild directory must contain exactly the eight declared addons');
for (const target of expected) {
  const bytes = readFileSync(join(root, `${target}.node`));
  const record = manifest.artifacts[target as keyof typeof manifest.artifacts];
  if (bytes.length !== record.bytes || createHash('sha256').update(bytes).digest('hex') !== record.sha256) throw new Error(`Native prebuild integrity mismatch: ${target}`);
}
const i = process.argv.indexOf('--rebuilt');
if (i >= 0) {
  const rebuilt = resolve(process.argv[i + 1]);
  const files = readdirSync(rebuilt).filter(file => file.endsWith('.node'));
  if (!files.length) throw new Error('No rebuilt binaries were supplied');
  for (const file of files) {
    if (!readFileSync(join(rebuilt, file)).equals(readFileSync(join(root, file)))) throw new Error(`Native rebuild was not byte-identical: ${file}`);
  }
}
console.log(`Verified ${expected.length} native lock prebuilds`);
