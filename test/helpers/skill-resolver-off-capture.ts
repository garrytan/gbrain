/**
 * Captures what plain setup and the user-prompt hook produce with the skill
 * resolver off, for test/skill-resolver-off-pin.test.ts. Pass the CLI to
 * run: `bun test/helpers/skill-resolver-off-capture.ts <path/to/src/cli.ts>`
 * prints the capture as JSON. The golden was captured from master before the
 * resolver existed. To regenerate it, run this against a tree where the
 * resolver is off, and review the diff.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Machine and clock parts: the temp root, the bun path, timestamps, durations, and Codex's trust hash (it hashes hooks.json, which is pinned itself). */
function normalize(text: string, root: string): string {
  return text.split(root).join('<ROOT>').split(process.execPath).join('<BUN>')
    .replace(/"(updated_at|ts)":\s*"[^"]*"/g, '"$1":"<TS>"')
    .replace(/"duration_ms":\s*\d+/g, '"duration_ms":"<MS>"')
    .replace(/trusted_hash = "sha256:[0-9a-f]+"/g, 'trusted_hash = "<HASH>"');
}
const sha256 = (s: string) => new Bun.CryptoHasher('sha256').update(s).digest('hex');

const PROMPT = { prompt: 'Deploy the widget service to staging, then write a changelog entry.', session_id: 'off-pin-session', hook_event_name: 'UserPromptSubmit' };

function tree(dir: string, base: string, root: string, out: Record<string, string>): Record<string, string> {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join(dir, e.name);
    if (dir === base && e.name === '.bun') continue;
    if (e.isSymbolicLink()) out[p.slice(base.length + 1)] = `symlink -> ${normalize(readlinkSync(p), root)}`;
    else if (e.isDirectory()) tree(p, base, root, out);
    else out[p.slice(base.length + 1)] = `sha256:${sha256(normalize(readFileSync(p, 'utf8'), root))}`;
  }
  return out;
}

async function run(argv: string[], env: Record<string, string>, cwd: string, stdin?: string) {
  const proc = Bun.spawn(argv, { env, cwd, stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin), stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, exitCode };
}

export async function captureResolverOff(cli: string): Promise<Record<string, unknown>> {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-off-pin-'));
  try {
    const home = join(root, 'home'), project = join(root, 'project'), bin = join(root, 'bin', 'gbrain');
    for (const d of [home, project, join(root, 'bin')]) mkdirSync(d, { recursive: true });
    writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' --no-env-file '${cli}' "$@"\n`);
    chmodSync(bin, 0o755);
    for (const dir of [join(home, '.claude', 'skills'), join(home, '.agents', 'skills')]) {
      mkdirSync(join(dir, 'deploy-widget'), { recursive: true });
      writeFileSync(join(dir, 'deploy-widget', 'SKILL.md'), '---\nname: deploy-widget\ndescription: Deploy the widget service to staging or production.\n---\nSteps.\n');
    }
    const env: Record<string, string> = { HOME: home, GBRAIN_HOME: home, PATH: '/usr/bin:/bin', GBRAIN_SKIP_STARTUP_HOOKS: '1', NO_COLOR: '1' };
    const out: Record<string, unknown> = {};
    for (const harness of ['claude-code', 'codex']) {
      const r = await run([process.execPath, '--no-env-file', cli, 'setup', harness, '--instructions-only', '--gbrain-bin', bin], env, project);
      out[`setup:${harness}:exit`] = r.exitCode;
    }
    out.files = tree(home, home, root, {});
    const commands: string[] = [];
    const claude = join(home, '.claude', 'settings.json'), codex = join(home, '.codex', 'hooks.json');
    for (const f of [claude, codex]) {
      if (!existsSync(f)) continue;
      const doc = JSON.parse(readFileSync(f, 'utf8'));
      for (const g of doc.hooks?.UserPromptSubmit ?? []) for (const h of g.hooks ?? []) commands.push(h.command);
    }
    const hooks: Record<string, unknown>[] = [];
    for (const command of commands) {
      const r = await run(['sh', '-c', command], env, project, JSON.stringify({ cwd: project, ...PROMPT }));
      hooks.push({ command: normalize(command, root), exitCode: r.exitCode, stdout: normalize(r.stdout, root) });
    }
    out.userPromptHooks = hooks;
    return out;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const cli = process.argv[2];
  if (!cli) { console.error('usage: bun test/helpers/skill-resolver-off-capture.ts <path/to/src/cli.ts>'); process.exit(2); }
  console.log(JSON.stringify(await captureResolverOff(cli), null, 2));
}
