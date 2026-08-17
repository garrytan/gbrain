/**
 * Standalone entrypoint for the WS2 compiled-binary integrity smoke test.
 *
 * The unit tests inject `computeDigest`/`fetchAttestation`, which HIDES the one
 * risk that actually matters for a compiled binary: do node:crypto (sha256),
 * base64 decode, and JSON parse survive `bun build --compile`? (The `sigstore`
 * npm package does NOT — that's why the verify is dependency-free.) This harness
 * runs the REAL verify path — `defaultComputeDigest` (node:crypto) +
 * `parseAttestationBundle` (base64 + JSON) + `verifyIntegrity` — fully OFFLINE
 * (the attestation is crafted in-process), and prints a sentinel.
 *
 * Compiled + executed by test/binary-self-update-compiled.serial.test.ts.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultComputeDigest,
  EXPECTED_BUILDER_IDS,
  parseAttestationBundle,
  verifyIntegrity,
  type ParsedAttestation,
} from '../../src/core/binary-self-update.ts';

// Derived from the source constant so a workflow rename can't silently split
// the harness from the real verify. (test/binary-self-update.test.ts keeps its
// own literal deliberately, as a regression pin.)
const BUILDER = EXPECTED_BUILDER_IDS[0]!;

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-smoke-'));
  try {
    const bin = join(dir, 'gbrain-linux-x64');
    writeFileSync(bin, 'PRETEND BINARY BYTES\n');

    // Real crypto: sha256 of the file.
    const digest = defaultComputeDigest(bin);
    if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error(`bad digest: ${digest}`);

    // Real base64 + JSON: build a bundle exactly like the GitHub API returns,
    // then round-trip it through parseAttestationBundle.
    const stmt = {
      _type: 'https://in-toto.io/Statement/v1',
      subject: [{ name: 'gbrain-linux-x64', digest: { sha256: digest } }],
      predicateType: 'https://slsa.dev/provenance/v1',
      predicate: { runDetails: { builder: { id: BUILDER } } },
    };
    const bundle = { dsseEnvelope: { payload: Buffer.from(JSON.stringify(stmt)).toString('base64') } };
    const parsed = parseAttestationBundle(bundle);
    if (!parsed) throw new Error('parseAttestationBundle returned null on a valid bundle');

    const fetchOk = async (): Promise<ParsedAttestation[]> => [parsed];
    const fetchNone = async (): Promise<ParsedAttestation[] | null> => null;

    const okReason = await verifyIntegrity(bin, 'gbrain-linux-x64', defaultComputeDigest, fetchOk);
    if (okReason !== null) throw new Error(`expected verified, got ${okReason}`);

    const failReason = await verifyIntegrity(bin, 'gbrain-linux-x64', defaultComputeDigest, fetchNone);
    if (failReason !== 'integrity_unavailable') throw new Error(`expected integrity_unavailable, got ${failReason}`);

    console.log('SMOKE_OK');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.log(`SMOKE_FAIL: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
