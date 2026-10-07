#!/usr/bin/env bun
/**
 * Portable links in the bundled skills tree (#6198, D13).
 *
 *   bun scripts/portable-skill-links.ts          rewrite skills/**\/*.md in place
 *   bun scripts/portable-skill-links.ts --check  exit 1 when a rewrite is pending
 *
 * Skills are copied verbatim into host workspaces (`gbrain skillpack
 * scaffold`), harness skill dirs and the generated plugin trees, so a
 * relative link that leaves `skills/` dangles in every copy. This script
 * rewrites each such link at the source:
 *   - `docs/protocol/AGENT_OPERATOR_v1.md` → the bundled copy at
 *     `skills/conventions/agent-operator-protocol.md` (relative, so it works
 *     offline in every copy; `bun run build:agent-protocol` keeps it fresh);
 *   - any other repo file → an absolute `<blob base>/<path>` URL.
 * skills/migrations/** is historical record and is left alone.
 *
 * Blob base: derived from `LLMS_REPO_BASE`, the fork override llms.txt uses
 * (a raw base `https://raw.githubusercontent.com/<owner>/<repo>/<ref>` maps to
 * `https://github.com/<owner>/<repo>/blob/<ref>`; any other value is used as
 * given). Unset → `https://github.com/garrytan/gbrain/blob/master`. A fork
 * re-running with its override also retargets links already written with the
 * default base. `scripts/check-skill-refs.mjs` fails on any outside-root link
 * and names this script as the fix.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, posix, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..');
export const DEFAULT_BLOB_BASE = 'https://github.com/garrytan/gbrain/blob/master';
export const PROTOCOL_SOURCE = 'docs/protocol/AGENT_OPERATOR_v1.md';
export const BUNDLED_PROTOCOL = 'skills/conventions/agent-operator-protocol.md';

export function repoBlobBase(env: Record<string, string | undefined> = process.env): string {
  const raw = env.LLMS_REPO_BASE?.replace(/\/+$/, '');
  if (!raw) return DEFAULT_BLOB_BASE;
  const m = raw.match(/^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/(.+)$/);
  return m ? `https://github.com/${m[1]}/${m[2]}/blob/${m[3]}` : raw;
}

/**
 * Rewrite every relative markdown link in `text` (a file at repo-relative
 * `fileRel`) whose target leaves `rootRel`: the protocol page goes to the
 * bundled copy, anything else to `base`. `rootRel: null` treats every
 * relative link as outside (the bundled protocol copy itself). Links already
 * on the default base move to `base`.
 */
export function portableLinks(text: string, fileRel: string, base: string, rootRel: string | null = 'skills'): string {
  const dir = posix.dirname(fileRel);
  const retargeted = base === DEFAULT_BLOB_BASE ? text : text.split(`](${DEFAULT_BLOB_BASE}/`).join(`](${base}/`);
  return retargeted.replace(/\]\(([^)\s]+)\)/g, (whole, link: string) => {
    if (link.startsWith('#') || link.startsWith('/') || /[<{$]/.test(link) || /^[a-z][a-z0-9+.-]*:/i.test(link)) return whole;
    const [target, anchor = ''] = link.split(/(?=#)/);
    const repoPath = posix.normalize(posix.join(dir, target));
    if (repoPath.startsWith('../')) return whole;
    if (rootRel !== null && (repoPath === rootRel || repoPath.startsWith(`${rootRel}/`))) return whole;
    if (rootRel !== null && repoPath === PROTOCOL_SOURCE) {
      const rel = posix.relative(dir, BUNDLED_PROTOCOL);
      return `](${rel.startsWith('.') ? rel : `./${rel}`}${anchor})`;
    }
    return `](${base}/${repoPath}${anchor})`;
  });
}

/** The bundled protocol copy: the source page with its own links made absolute. */
export function renderBundledProtocol(protocol: string, base: string): string {
  const [title, ...rest] = protocol.split('\n');
  const body = portableLinks(rest.join('\n'), PROTOCOL_SOURCE, base, null);
  return `${title}\n\n<!-- GENERATED from ${PROTOCOL_SOURCE} by \`bun run build:agent-protocol\`. Do not edit: edit the source page and regenerate. -->\n${body}`;
}

function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === 'migrations' ? [] : markdownFiles(p);
    return e.name.endsWith('.md') ? [p] : [];
  });
}

if (import.meta.main) {
  const base = repoBlobBase();
  const pending: string[] = [];
  for (const file of markdownFiles(join(ROOT, 'skills'))) {
    const rel = relative(ROOT, file).split('\\').join('/');
    if (rel === BUNDLED_PROTOCOL) continue;
    const text = readFileSync(file, 'utf8');
    const fresh = portableLinks(text, rel, base);
    if (fresh === text) continue;
    pending.push(rel);
    if (!process.argv.includes('--check')) writeFileSync(file, fresh);
  }
  if (process.argv.includes('--check')) {
    if (pending.length) {
      console.error(`${pending.length} skill file(s) have links that leave skills/: ${pending.join(', ')}\nFix: bun scripts/portable-skill-links.ts`);
      process.exit(1);
    }
    console.log('skill links: portable');
  } else {
    console.log(pending.length ? `rewrote links in ${pending.length} file(s) (base ${base})` : 'skill links: already portable');
  }
}
