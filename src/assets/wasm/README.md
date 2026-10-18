# Vendored tree-sitter assets

`src/core/chunkers/code.ts` embeds the runtime and grammar files directly with
Bun file imports. Its `LANGUAGE_MANIFEST` records paths, not content hashes;
replacing a grammar at the same path does not require regenerating a manifest.
Run `bun run check:wasm` to verify semantic parsing in the compiled binary.

## Bash (#5082)

`grammars/tree-sitter-bash.wasm` is the official
[`tree-sitter/tree-sitter-bash` v0.23.3 release asset](https://github.com/tree-sitter/tree-sitter-bash/releases/tag/v0.23.3),
not a binary taken from a contributor branch or the npm `tree-sitter-wasms` bundle.

- Upstream source tag: `v0.23.3`, commit
  `487734f87fd87118028a65a4599352fa99c9cde8` (MIT license).
- SHA-256: `d1844429a58620f306b6f42aebe92298243ca8120cd833a3ab5d87c7a2e7b9fd`.
- Size: 1,364,404 bytes. Language ABI: 14, compatible with the pinned
  `web-tree-sitter@0.22.6` runtime (ABI 13–14).
- The release source archive's `src/scanner.c` matches the tagged source
  (Git blob `748cf1bc4c928a52b4e6f9c27bc9a2bb4eeb6bce`). It uses `iswalpha` and
  `iswalnum`, exported by the runtime, instead of the previous binary's missing
  `isalpha` import. The remaining unresolved `__assert_fail` import is an
  assertion-only path; this update does not change the runtime's libc exports.

Re-vendor the pinned official asset, verifying its checksum before replacement:

```sh
bash scripts/vendor-bash-wasm.sh
bun test test/chunkers/code-bash.test.ts
bun run check:wasm
```

This is a verified upstream prebuilt, not a claim of a byte-reproducible local
build. The regression suite checks imports, ABI compatibility, real `case`,
heredoc and loop parsing, and semantic function preservation. `CHUNKER_VERSION`
advances to 7 to trigger the existing re-chunk gate when Git HEAD is unchanged.
That gate does not force a full walk when new commits are present; use
`gbrain sync --source <id> --full` to recover all previously affected files in
an active repository rather than relying on an incremental sync.

## Lua (`gbrain serve` hang, GBRA-49 Q1 scoreboard)

`grammars/tree-sitter-lua.wasm` is the official
[`tree-sitter-grammars/tree-sitter-lua` v0.3.0 release asset](https://github.com/tree-sitter-grammars/tree-sitter-lua/releases/tag/v0.3.0),
replacing the `tree-sitter-wasms` bundle's build of the unmaintained
`Azganoth/tree-sitter-lua` 2.1.3.

- Upstream source tag: `v0.3.0`, commit
  `534c461d2b75b0887ec968ef9635f4460b0878b7` (MIT license).
- SHA-256: `8fe0afe3238dad43a1dd541ba3024c28d3cd23466b031fe0a39d8f9d7e81ee0d`.
- Size: 48,189 bytes. Language ABI: 14, compatible with the pinned
  `web-tree-sitter@0.22.6` runtime (ABI 13–14). v0.4.0 and later are ABI 15.
- Why: the previous grammar's external scanner allocated its state with
  `malloc` and only reset it in `deserialize` when handed a 2-byte buffer, so a
  fresh parse (which deserializes an empty buffer) started from whatever the
  recycled heap held. The first Lua parse in a process was sound; every later
  one began "inside" a string or long bracket, misparsed `x = 1` as an error,
  or spun until the chunker timeout (30 s per fence). A conversation page with
  five ChatGPT-style ```` ```lua ```` fences around shell commands kept
  `gbrain serve` at 100% CPU for 9.5 hours: each preparation attempt blocked
  the event loop for about 150 s, exceeded its deadline, and was retried.
  The maintained grammar uses `calloc` and resets state on every parse.
- The node types also changed (`function_declaration` for every
  `function` / `local function` / `function M.f()` form), which is what
  `TOP_LEVEL_TYPES.lua` expected all along: Lua definitions become semantic
  chunks for the first time. `GRAMMAR_REVISIONS.lua = 1` in
  `src/core/chunkers/code.ts` folds into Lua code-file hashes and into the
  `sources.chunker_version` stamp (`8;lua=1`), so the next sync walks each
  source and re-imports only its Lua files; `CHUNKER_VERSION` stays 8 and no
  other code page re-chunks or re-embeds.

Re-vendor the pinned official asset, verifying its checksum before replacement:

```sh
bash scripts/vendor-lua-wasm.sh
bun test test/chunkers/code-lua.test.ts
bun run check:wasm
```

## Dart (#3356)

`grammars/tree-sitter-dart.wasm` is the one grammar not taken from the
`tree-sitter-wasms` npm bundle: that package's Dart build is ABI 15, which the
pinned `web-tree-sitter@0.22.6` runtime rejects. `scripts/build-dart-wasm.sh`
regenerates the same upstream grammar at ABI 14 (needs git, npm and podman or
docker):

```sh
bash scripts/build-dart-wasm.sh
bun run check:wasm
```
