#!/usr/bin/env node
// skill-diet eval adapter for gbrain skills: runs one Claude Code (claude-*) or Codex (gpt-*) session.
// <adapter> <skill-dir|""> <prompt> <out-dir> <work-dir>; model in $EVAL_MODEL.
// The session's HOME is <work>/.home (the brain lives at <work>/.home/.gbrain, made by the task's setup), the
// target skill is installed harness-natively under its folder name, and the rest of gbrain's skills tree is at
// <work>/skills/ like a scaffolded workspace. After the session it writes <work>/.eval/{answer.txt,calls.jsonl}
// so task checks can assert on what the agent ran.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const [skillDir, prompt, out, work] = process.argv.slice(2);
const model = process.env.EVAL_MODEL;
if (!model) { console.error("EVAL_MODEL unset"); process.exit(2); }
const BIN = process.env.EVAL_AGENTS_BIN;
const SUPPORT = process.env.EVAL_SUPPORT_SKILLS;
const PRICES = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  "gpt-6.1-sol": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
};
const cost = (m, t) => { const p = PRICES[m]; if (!p) return null; return (t.input * p.input + t.output * p.output + t.cacheRead * p.cacheRead + t.cacheWrite * p.cacheWrite) / 1e6; };

const LEDGER = process.env.EVAL_LEDGER;
const CAP = Number(process.env.EVAL_SPEND_CAP ?? "0");
const spent = () => (LEDGER && existsSync(LEDGER) ? readFileSync(LEDGER, "utf8").split("\n").filter(Boolean).reduce((s, l) => s + (JSON.parse(l).costUsd ?? 0), 0) : 0);
if (CAP && spent() >= CAP) { console.error(`SPEND_CAP: ${spent().toFixed(2)} >= ${CAP} USD; stopping before another session`); process.exit(3); }

const home = join(work, ".home");
mkdirSync(home, { recursive: true });
if (SUPPORT && !existsSync(join(work, "skills"))) cpSync(SUPPORT, join(work, "skills"), { recursive: true });
const isClaude = model.startsWith("claude-");
const cfg = join(home, isClaude ? ".claude" : ".codex");
const skillsRoot = join(cfg, "skills");
mkdirSync(skillsRoot, { recursive: true });
const name = skillDir ? basename(skillDir) : null;
if (skillDir) symlinkSync(skillDir, join(skillsRoot, name));
// Relative links in a skill (../conventions/x.md) resolve beside it, as in a scaffolded workspace.
if (SUPPORT) for (const f of ["conventions", "_brain-filing-rules.md", "_output-rules.md", "_friction-protocol.md"]) if (existsSync(join(SUPPORT, f))) symlinkSync(join(work, "skills", f), join(skillsRoot, f));
const installed = name ? join(skillsRoot, name) : null;
const mapPath = (p) => (p && installed && p.startsWith(installed) ? skillDir + p.slice(installed.length) : p);
const mapText = (s) => (s && installed ? s.split(installed).join(skillDir) : s);

const env = { ...process.env, HOME: home, TMPDIR: join(work, ".tmp") };
mkdirSync(env.TMPDIR, { recursive: true });
delete env.GBRAIN_HOME;
for (const k of ["GEMINI_API_KEY", "VOYAGE_API_KEY", "JEV_TYPESAFE_API_KEY", "UBICLOUD_API_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]) delete env[k];
let argv;
if (isClaude) {
  env.CLAUDE_CONFIG_DIR = cfg;
  delete env.OPENAI_API_KEY;
  argv = [join(BIN, "claude"), "-p", prompt, "--model", model, "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions", "--max-turns", "60"];
} else {
  env.CODEX_HOME = cfg;
  env.CODEX_API_KEY = env.OPENAI_API_KEY;
  delete env.ANTHROPIC_API_KEY;
  argv = [join(BIN, "codex"), "exec", "--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "-m", model, prompt];
}
const raw = join(out, "raw.jsonl");
// The agent runs in a bubblewrap sandbox: /home/user, /workspace and /tmp are empty except for its work dir, its
// own skill version, the agent CLIs, the pinned gbrain checkout and the gbrain shim, so it cannot find another
// version's copy of the skill (or the repository's) by searching the disk.
const W = process.env.EVAL_ROOT;
// Every copy of a pilot skill inside the gbrain checkout (bundled, plugin trees, test fixtures). gbrain needs the rest
// of skills/ at runtime (the filing rules), so only these folders are hidden.
const hiddenCopies = (src) => spawnSync("find", [src, "-path", join(src, "node_modules"), "-prune", "-o", "-type", "d", "(", "-name", "brain-ops", "-o", "-name", "company-brainify", "-o", "-name", "meeting-ingestion", ")", "-print"], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
const ro = [skillDir, BIN.replace(/\/\.bin$/, ""), process.env.GBRAIN_EVAL_SRC ?? join(W, "gbrain-src"), join(W, "bin")].filter(Boolean);
const box = ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--tmpfs", "/home", "--tmpfs", "/workspace", "--tmpfs", "/root",
  "--bind", work, work, ...ro.flatMap((d) => ["--ro-bind", d, d]), ...hiddenCopies(process.env.GBRAIN_EVAL_SRC ?? join(W, "gbrain-src")).flatMap((d) => ["--tmpfs", d]), "--die-with-parent", "--chdir", work, "--"];
const child = spawn("bwrap", [...box, ...argv], { cwd: work, env, stdio: ["ignore", "pipe", "pipe"] });
const chunks = [];
const errs = [];
child.stdout.on("data", (d) => chunks.push(d));
child.stderr.on("data", (d) => errs.push(d));
for (const s of ["SIGTERM", "SIGINT"]) process.on(s, () => { try { child.kill("SIGTERM"); } catch {} process.exit(143); });
const code = await new Promise((r) => child.on("exit", (c) => r(c)));
const text = Buffer.concat(chunks).toString("utf8");
writeFileSync(raw, text);
writeFileSync(join(out, "stderr.txt"), Buffer.concat(errs).toString("utf8"));
const events = text.split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });

let answer = "", turns = null, calls = [], tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd = 0, priced = true;
if (isClaude) {
  for (const e of events) {
    if (e.type !== "assistant") continue;
    for (const c of e.message?.content ?? []) {
      if (c.type !== "tool_use") continue;
      const i = c.input ?? {};
      if (c.name === "Skill") calls.push({ name: "Skill", path: i.skill === name ? join(skillDir, "SKILL.md") : `/${i.skill}/SKILL.md` });
      else calls.push({ name: c.name, ...(i.file_path || i.path ? { path: mapPath(i.file_path ?? i.path) } : {}), ...(i.command ? { command: mapText(i.command) } : {}), ...(i.pattern ? { pattern: i.pattern } : {}) });
    }
  }
  const res = events.findLast((e) => e.type === "result");
  answer = res?.result ?? "";
  turns = res?.num_turns ?? null;
  for (const [m, u] of Object.entries(res?.modelUsage ?? {})) {
    const t = { input: u.inputTokens ?? 0, output: u.outputTokens ?? 0, cacheRead: u.cacheReadInputTokens ?? 0, cacheWrite: u.cacheCreationInputTokens ?? 0 };
    for (const k of Object.keys(tokens)) tokens[k] += t[k];
    const key = Object.keys(PRICES).find((p) => m.startsWith(p));
    const c = key ? cost(key, t) : null;
    if (c == null) { priced = false; costUsd += u.costUSD ?? 0; } else costUsd += c;
  }
} else {
  const strip = (c) => { const m = c.match(/^\/bin\/(?:ba)?sh -lc '([\s\S]*)'$/); return m ? m[1].replace(/'\\''/g, "'") : c; };
  let req = 0;
  for (const e of events) {
    const it = e.item;
    if (e.type === "item.completed" && it) {
      if (it.type === "agent_message") answer = it.text;
      else if (it.type === "command_execution") calls.push({ name: "shell", command: mapText(strip(it.command)) });
      else if (it.type === "file_change") for (const ch of it.changes ?? []) calls.push({ name: "edit", path: mapPath(ch.path) });
      else if (it.type === "mcp_tool_call") calls.push({ name: `${it.server}.${it.tool}` });
      else if (it.type === "web_search") calls.push({ name: "web_search" });
    }
    if (e.type === "turn.completed" && e.usage) {
      const u = e.usage;
      const cached = u.cached_input_tokens ?? 0, write = u.cache_write_input_tokens ?? 0;
      tokens.input += Math.max(0, (u.input_tokens ?? 0) - cached - write);
      tokens.cacheRead += cached; tokens.cacheWrite += write; tokens.output += u.output_tokens ?? 0;
    }
  }
  costUsd = cost(model, tokens);
}
writeFileSync(join(out, "result.json"), JSON.stringify({ answer, tokens, turns, calls, model, costUsd, priced, agentExit: code }, null, 1));
mkdirSync(join(work, ".eval"), { recursive: true });
writeFileSync(join(work, ".eval", "answer.txt"), answer);
writeFileSync(join(work, ".eval", "calls.jsonl"), calls.map((c) => JSON.stringify(c)).join("\n") + "\n");
if (LEDGER) appendFileSync(LEDGER, JSON.stringify({ at: new Date().toISOString(), skill: process.env.EVAL_SKILL ?? (name ?? ""), model, tags: process.env.OBSERVE_TAGS ?? "", version: (process.env.OBSERVE_TAGS ?? "").match(/version=(\S+)/)?.[1] ?? "", costUsd }) + "\n");
const hasUsage = tokens.output > 0 && tokens.input + tokens.cacheRead > 0;
process.exit(hasUsage ? 0 : 1);
