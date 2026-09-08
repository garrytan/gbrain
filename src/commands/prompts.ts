/**
 * `gbrain prompts` — inspect and override the system prompts gbrain sends.
 *
 * The catalog is `src/core/prompts/registry.ts`; overrides persist in the
 * config KV table under `prompts.<id>` and take effect on the next LLM call
 * (call sites resolve through `resolvePromptText`, nothing is cached
 * process-wide).
 *
 * Deliberately a plain CLI command rather than an operation: an override
 * rewrites the instructions every later LLM call runs under, so it stays on
 * the trusted local plane and never becomes an agent-writable MCP tool. Same
 * reasoning `gbrain config set` follows.
 */

import { readFileSync } from 'node:fs';
import type { BrainEngine } from '../core/engine.ts';
import {
  listPrompts,
  getPromptStatus,
  setPromptOverride,
  resetPromptOverride,
  PromptAdminError,
  type PromptStatus,
} from '../core/prompts/admin.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';

export const PROMPTS_HELP = `gbrain prompts — inspect and override system prompts

USAGE
  gbrain prompts list [--group <g>] [--overridden] [--json]
  gbrain prompts show <id> [--default] [--json]
  gbrain prompts set <id> --file <path>
  gbrain prompts set <id> --stdin
  gbrain prompts reset <id>

SUBCOMMANDS
  list                 Every prompt: id, group, whether it is editable, and
                       whether an override is active.
  show <id>            The effective prompt text (override when set).
                       --default prints the built-in text instead.
  set <id>             Replace a prompt's text. Reads the new text from a file
                       (--file) or stdin (--stdin) so newlines survive the
                       shell. An override that drops a required {PLACEHOLDER}
                       is refused; saving the built-in text verbatim resets.
  reset <id>           Drop the override, restoring the built-in text.

NOTES
  Overrides live in brain config under \`prompts.<id>\` and apply on the next
  LLM call — no restart. Read-only entries (template-function prompts, or
  prompts on paths with no engine handle) are listed for traceability; \`set\`
  refuses them.

  For version-cached phases (propose_takes, grade_takes, calibration_profile)
  the effective prompt version gains a content digest while an override is
  active, so cached verdicts produced by the old instructions are not reused.
`;

function flagValue(args: string[], name: string): string | undefined {
  const eq = args.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function fail(msg: string): void {
  console.error(`prompts: ${msg}`);
  setCliExitVerdict(1);
}

function printList(rows: PromptStatus[]): void {
  const width = Math.max(...rows.map((r) => r.id.length), 2);
  let group = '';
  for (const r of rows) {
    if (r.group !== group) {
      group = r.group;
      console.log(`\n${group}`);
    }
    const state = !r.editable ? 'read-only' : r.overridden ? 'OVERRIDDEN' : 'default';
    console.log(`  ${r.id.padEnd(width)}  ${state.padEnd(10)}  ${r.label}`);
  }
  const editable = rows.filter((r) => r.editable).length;
  const overridden = rows.filter((r) => r.overridden).length;
  console.log(`\n${rows.length} prompts, ${editable} editable, ${overridden} overridden`);
}

/**
 * `engine` is nullable because the help branch below is answered BEFORE any
 * engine work — that is what lets `gbrain prompts --help` dispatch without a
 * brain (SELF_HELP_WITHOUT_ENGINE in cli.ts). Every other branch needs one.
 */
export async function runPrompts(engine: BrainEngine | null, args: string[]): Promise<void> {
  const sub = args[0];
  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') {
    console.log(PROMPTS_HELP);
    return;
  }
  if (!engine) {
    fail('no brain configured — run `gbrain init` first');
    return;
  }
  const json = args.includes('--json');

  if (sub === 'list') {
    let rows = await listPrompts(engine);
    const group = flagValue(args, '--group');
    if (group) rows = rows.filter((r) => r.group === group);
    if (args.includes('--overridden')) rows = rows.filter((r) => r.overridden);
    if (json) {
      console.log(JSON.stringify({ prompts: rows }, null, 2));
      return;
    }
    if (rows.length === 0) {
      console.log('No prompts matched.');
      return;
    }
    printList(rows);
    return;
  }

  const id = args[1];
  if (!id || id.startsWith('--')) {
    fail(`${sub} needs a prompt id (see: gbrain prompts list)`);
    return;
  }

  if (sub === 'show') {
    const status = await getPromptStatus(engine, id);
    if (!status) {
      fail(`unknown prompt id: ${id}`);
      return;
    }
    if (json) {
      console.log(JSON.stringify(status, null, 2));
      return;
    }
    const wantDefault = args.includes('--default');
    const text = status.override_text !== null && !wantDefault ? status.override_text : status.default_text;
    if (text.trim() === '') {
      // A few read-only entries are template FUNCTIONS with no standalone
      // constant to print. Say so instead of printing a blank line.
      console.error(`${status.id} is assembled by a template function — read it at ${status.defined_at}`);
      return;
    }
    console.log(text);
    return;
  }

  if (sub === 'set') {
    const file = flagValue(args, '--file');
    const useStdin = args.includes('--stdin');
    if (!file && !useStdin) {
      fail('set needs --file <path> or --stdin (prompt text is multi-line; a shell argument mangles it)');
      return;
    }
    let text: string;
    try {
      text = file ? readFileSync(file, 'utf8') : await readStdin();
    } catch (e) {
      fail(`could not read the new prompt text: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    try {
      const status = await setPromptOverride(engine, id, text);
      if (json) {
        console.log(JSON.stringify(status, null, 2));
        return;
      }
      console.log(
        status.overridden
          ? `Overrode ${id} (${text.length} chars). Applies on the next LLM call.`
          : `${id} matched the built-in text — override cleared.`,
      );
      if (status.overridden && status.effective_version) {
        console.log(`Effective prompt version is now ${status.effective_version} (cached verdicts will be re-judged).`);
      }
    } catch (e) {
      fail(e instanceof PromptAdminError ? e.message : `${e instanceof Error ? e.message : String(e)}`);
    }
    return;
  }

  if (sub === 'reset') {
    try {
      const status = await resetPromptOverride(engine, id);
      if (json) {
        console.log(JSON.stringify(status, null, 2));
        return;
      }
      console.log(`Reset ${id} to the built-in prompt.`);
    } catch (e) {
      fail(e instanceof PromptAdminError ? e.message : `${e instanceof Error ? e.message : String(e)}`);
    }
    return;
  }

  fail(`unknown subcommand: ${sub}`);
  console.error(PROMPTS_HELP);
}
