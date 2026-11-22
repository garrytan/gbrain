# Research maps: agent-facing contract overview

These maps describe what the Rust port of gbrain must keep exactly: the CLI (commands, flags, `--json` output, exit codes), the MCP tools (names, input schemas, result shapes, access rules), and the markdown brain format. They are research only. No build phase starts from them until Garry approves it.

## Reference versions

| Repo | Commit | Notes |
|---|---|---|
| `garrytan/gbrain` (reference) | `master` `8bbfd0b5e8` | VERSION `0.60.733.0` |
| `garrytan/gbrain-evals` (parity oracle) | `cd447b3ae` ("Release v0.10.237") | pins gbrain at `6ce7195b44a0`, not `#master` |

The root `CLAUDE.md` in gbrain describes roughly v0.41. Where it disagrees with the code, these maps follow the code.

## Files

| File | What it covers |
|---|---|
| [cli.md](cli.md) | All 220 public CLI commands. Part A: op-backed commands, argv parsing, global flags, agent contract v1 (`--json` documents, notices, error envelope), exit codes. Part B: the 132 CLI-only commands by category. Part C: which commands agents and evals use. |
| [mcp.md](mcp.md) | All 186 MCP tools: transports (stdio, OAuth HTTP), scopes, surfaces, publish gates, wire shapes, the full tool table, JSON schemas for the verbs and starter surfaces, MEMORY_VERBS and the qm-memory-provider contract, and which tools agents and evals use. |
| [brain-format.md](brain-format.md) | The markdown brain: directory layout, frontmatter fields and YAML rules, compiled truth vs timeline, facts/takes/links fences, slugs, wikilinks and backlinks, import/sync/export, content hash, annotated fixture pages. |
| [agent-and-eval-usage.md](agent-and-eval-usage.md) | How gbrain-evals touches gbrain (library imports, CLI argv, MCP calls, the HTTP protocol v1 seam) and how gbrain's own skills and instructions use the CLI and MCP. |
| [data/](data/) | Machine-readable snapshots: the operation manifest (204 ops), `tools/list` output per surface (non-strict and strict), the public-surface lists (commands, flags, MCP params, exit codes, config keys), and captured MCP error envelopes. Regenerate with `bun docs/research/rust-engine/scripts/dump-contract-data.ts <gbrain-checkout> docs/research/rust-engine/data`. |

## Key numbers

| Surface | Count | Source |
|---|---|---|
| Operations (single source for CLI and MCP) | 204 | `src/core/operation-manifest.generated.ts` |
| Public CLI commands / flags | 220 / 613 | `docs/contracts/public-surface.json` (CI-enforced) |
| CLI-only command records | 132 | `src/cli/command-table.ts` |
| MCP tools (not `cliOnly`) | 186 | public-surface `mcp-tool` |
| MCP tools an HTTP client can ever see | 176 | 186 minus 10 `localOnly` ops |
| Verbs / starter surfaces | 7 / 41 | `src/mcp/surface.ts` |
| Error codes / distinct exit values | 707 / 17 (658 codes exit 1) | `src/core/error-catalogue.ts` |
| gbrain-evals files importing gbrain as a library | 131 (plus 116 path-based `src/` imports in 68 files) | agent-and-eval-usage.md section 1a |

## Contract risks

These are the places where a Rust port can break agents or evals without a compile error. Each is detailed in the linked file.

1. **gbrain-evals is mostly a library consumer.** 131 files import `gbrain/*` modules and 68 runners load gbrain `src/` files by path. A Rust binary cannot satisfy these. Only the CLI argv (about 26 verbs), MCP stdio (about 28 tools) and the HTTP protocol v1 shim (`eval/systems/PROTOCOL.md`) are language-neutral. ([agent-and-eval-usage.md](agent-and-eval-usage.md) section 1)
2. **JSON bytes.** CLI `--json` is `JSON.stringify(x, replacer, 2)` plus a newline. MCP success text is compact JSON, but MCP errors are indented. Key order is insertion order. bigint ids are strings. JS number text (`1` not `1.0`, `1e+21`) and `toFixed` rounding differ from Rust defaults. ([cli.md](cli.md) A.7.1)
3. **Content hash.** SHA-256 over `JSON.stringify` of `{title, type, compiled_truth, timeline, frontmatter, tags}`, with JS key order (integer-like keys first), JS number and string escaping, and a frozen list of dropped frontmatter keys. Any difference changes every stored hash and forces re-import. ([brain-format.md](brain-format.md) 5.5, 9.3)
4. **YAML.** gbrain uses js-yaml 4 with a calendar-checked timestamp type and merge keys. Rust YAML crates differ on YAML 1.1 booleans, octals, merge keys, tags and duplicate keys. A bare `date: 2024-06-01` is stored as `2024-06-01T00:00:00.000Z`. ([brain-format.md](brain-format.md) 9.1, 9.2)
5. **Unicode slugs.** Slug rules depend on Unicode tables (`\p{L}`, NFD/NFC), CJK ranges and a frontmatter-slug fallback for emoji or exotic-script filenames. Node ICU and Rust crates can disagree on new code points. ([brain-format.md](brain-format.md) 3, 9.4)
6. **Errors are tool results, not JSON-RPC errors.** MCP refusals return `{content, isError: true}` with a versioned envelope (`code`, `class`, `retryable`, `suggestion`, `docs`, `contract_version`). The CLI exit code comes from the error code, not its class. ([mcp.md](mcp.md) 3, R8; [cli.md](cli.md) A.5)
7. **The visible tool list is computed per request.** It depends on transport (stdio lists `localOnly` ops, HTTP never does), OAuth scope, publish gates, bound-client fences, surface and `strict_params`. A static list is wrong for most callers. ([mcp.md](mcp.md) 0.2, 2)
8. **Tool and schema order and text.** `tools/list` order is registry order (verbs first). Descriptions are byte-for-byte strings. `initialize.instructions` is computed from the caller's callable set. ([mcp.md](mcp.md) R3-R7)
9. **JSON on a pipe.** Op-backed commands print human output unless `--json` is passed. The four `code-*` commands switch to JSON automatically when stdout is not a TTY. Several CLI-only commands print JSON without a declared `--json` contract, so the stdout guard does not protect them. ([cli.md](cli.md) A.3.4, B.4.3)
10. **Parser quirks.** Excess positionals are dropped silently. Global flags are stripped even after `--`. `--flag false` consumes the value. Nine names are both an op and a CLI-only command, and the CLI-only one wins. ([cli.md](cli.md) A.7.4)
11. **Single-writer storage drives the CLI design.** While `gbrain serve` holds the PGLite lock, many commands delegate over an IPC socket. The Rust storage choice decides whether that protocol is part of the port. ([cli.md](cli.md) B.4.2)
12. **Host-specific commands.** `autopilot` installers (launchd, systemd, cron), `upgrade` (Bun self-update with Sigstore checks), `check-update`, `hook` (exact `git` output), `pglite-repair` and `reinit-pglite` have no direct Rust equivalent. ([cli.md](cli.md) B.4.1)

## Open questions for Garry

1. **Eval seam.** Should parity runs use the CLI and MCP stdio (as the Python `gbrain-defaults` shim does with `GBRAIN_BIN`), the HTTP protocol v1 shim, or both? The 131 library-import files cannot run against Rust without a TypeScript adapter.
2. **v1 scope.** The research suggests P0 = the agent and eval contract (`init`, `import`, `sync`, `export`, `embed`, `extract`, `serve`, `doctor`, `status`, `jobs`, `eval`, `capture`, `forget`, `call`, `dream`, `config`, `sources`, `hook`, `frontmatter validate`, plus all op-backed commands), P1 = setup and auth, P2 or retire = installers, Bun upgrade paths and PGLite repair. Is that the right cut?
3. **Byte identity.** Must human output and `--help` text be byte-identical, or only `--json` and MCP output? Must the YAML writer reproduce js-yaml dump bytes, or only parse the same and hash the same?
4. **Existing brains.** Must Rust open existing PGLite or Postgres brains, or is a one-time export and re-import acceptable? This decides whether stored hashes, ISO date strings and the legacy hash formula must match exactly.
5. **Known oddities: keep or fix?** Examples: silent drop of excess positionals, `String(date)` for date-valued tags (timezone-dependent), `note` as the default type for files without frontmatter, three `.raw/` sidecar layouts, exit 15 documented but never emitted, and three cliOnly ops listed in `docs/TOOL_CATALOG.md`.
6. **MCP protocol versions.** Accept the SDK 1.32.1 list (`2025-11-25` back to `2024-10-07`) and echo the client's version, as the TypeScript server does today?
7. **Legacy bearer HTTP transport** (`src/mcp/http-transport.ts`). It has no production caller, only tests. Drop it and re-point those tests at the OAuth transport?
8. **Moving target.** gbrain `master` moves fast. It advanced 3 commits (to `9f1d54232d`) while this research ran; those commits did not change `public-surface.json` or the operation manifest. Which gbrain commit is the parity baseline, and how often do we re-sync these maps?
9. **Library contract.** gbrain-evals imports 31 `package.json` `exports` entries and 100 non-exported `src/` paths. Is any part of that a contract the Rust project must keep (for example through a TypeScript wrapper), or is it eval-internal?

## Method and limits

- Five parallel research passes read the source with `file:line` citations. Handler-free modules (operation manifest, tool-defs, surface, callable, dispatch with a stub engine) were imported with Bun to produce the data files and the MCP error envelopes.
- The gbrain CLI itself was not executed: it requires Bun >= 1.4.4 and the research host had 1.3.14. CLI JSON examples come from tests, golden fixtures and code literals, not live captures.
- No test suites were run. Engine-method columns in the large tables are from reading handlers and are marked as heuristics where they are.
- Line numbers refer to gbrain `8bbfd0b5e8`. Re-check them after gbrain moves.
