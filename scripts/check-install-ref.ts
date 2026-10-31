#!/usr/bin/env bun
/**
 * Install-ref lint (GBRA-224): every install surface names INSTALL_REF (src/core/install-ref.ts).
 *
 * Checked in every tracked file except CHANGELOG.md and test/:
 *   - `github:garrytan/gbrain#<ref>` install pins with a named ref (a `v<version>`, a commit or a template is an exact pin,
 *     not a channel ref, and is left alone) must name INSTALL_REF; `#master` is never an install ref;
 *   - raw fetches of the install artifacts (BOOTSTRAP_FOR_AGENTS.md, scripts/setup-in-agent.sh) must use INSTALL_REF;
 *   - the setup helper's `gbrain_install_ref=` must equal INSTALL_REF;
 *   - TypeScript sources never spell the ref: they import INSTALL_PIN / INSTALL_RAW_BASE.
 *
 * `--write` rewrites the text surfaces to INSTALL_REF (the flip after a stable promotion); TypeScript violations are
 * listed, never rewritten. Exit 1 on drift.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { INSTALL_REF } from '../src/core/install-ref.ts';

export interface InstallRefDrift { file: string; line: number; found: string; why: string }

const PIN = /github:garrytan\/gbrain#([A-Za-z][A-Za-z0-9._-]*)/g;
const ARTIFACT = /raw\.githubusercontent\.com\/garrytan\/gbrain\/([A-Za-z0-9._-]+)\/(BOOTSTRAP_FOR_AGENTS\.md|scripts\/setup-in-agent\.sh)/g;
const HELPER_REF = /^gbrain_install_ref=([A-Za-z0-9._-]+)$/gm;
const EXACT_PIN = /^v|^[0-9]/;
const OWNER = 'src/core/install-ref.ts';

const skipped = (file: string) => file === 'CHANGELOG.md' || file.startsWith('test/') || file === OWNER;

/** Drift in one file's text; `ref` is the sanctioned install ref. */
export function driftIn(file: string, text: string, ref: string = INSTALL_REF): InstallRefDrift[] {
  if (skipped(file)) return [];
  const out: InstallRefDrift[] = [];
  const at = (index: number) => text.slice(0, index).split('\n').length;
  const ts = file.endsWith('.ts');
  for (const m of text.matchAll(PIN)) {
    if (EXACT_PIN.test(m[1]!)) continue;
    if (ts) out.push({ file, line: at(m.index!), found: m[0], why: `TypeScript names install refs through INSTALL_PIN (${OWNER})` });
    else if (m[1] !== ref) out.push({ file, line: at(m.index!), found: m[0], why: `install pins name ${ref}` });
  }
  for (const m of text.matchAll(ARTIFACT)) {
    if (/^[0-9a-f]{40}$/.test(m[1]!)) continue;
    if (ts) out.push({ file, line: at(m.index!), found: m[0], why: `TypeScript fetches install artifacts through INSTALL_RAW_BASE (${OWNER})` });
    else if (m[1] !== ref) out.push({ file, line: at(m.index!), found: m[0], why: `install artifacts are fetched from ${ref}` });
  }
  for (const m of text.matchAll(HELPER_REF)) {
    if (m[1] !== ref) out.push({ file, line: at(m.index!), found: m[0], why: `the setup helper resolves ${ref}` });
  }
  return out;
}

/** The text surface rewritten to `ref` (TypeScript is left for a human). */
export function rewriteText(file: string, text: string, ref: string = INSTALL_REF): string {
  if (skipped(file) || file.endsWith('.ts')) return text;
  return text
    .replace(PIN, (all, r: string) => (EXACT_PIN.test(r) ? all : `github:garrytan/gbrain#${ref}`))
    .replace(ARTIFACT, (all, r: string, path: string) => (/^[0-9a-f]{40}$/.test(r) ? all : `raw.githubusercontent.com/garrytan/gbrain/${ref}/${path}`))
    .replace(HELPER_REF, `gbrain_install_ref=${ref}`);
}

function trackedFiles(root: string): string[] {
  const r = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ls-files failed: ${r.stderr}`);
  return r.stdout.split('\0').filter(f => f && /\.(md|txt|ts|sh|json|yml|yaml)$|gbrain-launcher$/.test(f));
}

export function findInstallRefDrift(root: string, write = false): InstallRefDrift[] {
  const drift: InstallRefDrift[] = [];
  for (const file of trackedFiles(root)) {
    let text: string;
    try { text = readFileSync(join(root, file), 'utf8'); } catch { continue; }
    if (write) {
      const next = rewriteText(file, text);
      if (next !== text) writeFileSync(join(root, file), next);
      text = next;
    }
    drift.push(...driftIn(file, text));
  }
  return drift;
}

if (import.meta.main) {
  const root = process.env.GBRAIN_GUARD_ROOT || join(import.meta.dir, '..');
  const drift = findInstallRefDrift(root, process.argv.includes('--write'));
  for (const d of drift) console.error(`FAIL: ${d.file}:${d.line} ${d.found} (${d.why})`);
  if (drift.length) {
    console.error(`check-install-ref: ${drift.length} install surface(s) off ${INSTALL_REF}; run bun run check:install-ref --write for text surfaces.`);
    process.exit(1);
  }
  console.log(`check-install-ref: ok (every install surface names ${INSTALL_REF})`);
}
