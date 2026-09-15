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
