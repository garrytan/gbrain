# Native writer locks

`locks.c` is a first-party C Node-API v3 addon exposing opaque `openLock`,
nonblocking `tryLock`, and idempotent `close` operations. POSIX uses `flock`;
Windows uses `LockFileEx`. The kernel releases ownership on process death.
The TypeScript wrapper in `src/core/persistence/native-lock.ts` adds cancellable
asynchronous waiting, defaults to a 5-second deadline and 25-ms polling, and
loads the addon only when a caller needs lock capability.

The caller must supply an absolute, stable lock path in a host-controlled
directory outside any replaceable datastore or worktree. Keep the file after
release. Never unlink, rotate, copy over, or infer ownership from its age or
metadata: replacing a locked inode can permit two owners. Leaf symlinks,
reparse points and nonregular files are rejected. Directory confinement and
the filesystem's cross-process lock semantics are prerequisites supplied by
the host; this binding does not establish distributed ownership across hosts.
An unavailable addon or an OS error produces `writer_lock_unavailable`.
There is no timestamp, PID, or TTL ownership fallback. A close failure must
stop publication; it cannot be treated as successful relinquishment.

Windows IPC adds two narrowly scoped operations in `windows-ipc.h`. Named
pipes retain a nonblocking Global kernel mutex from before probing through
the listener's actual close. Windows invariant Unicode uppercase plus CNG
SHA-256 gives case and prefix aliases one identity independent of homes and
logon sessions. The environment registry and a small shared kernel owner record
prevent recursive acquisition through separate addon copies on the same thread;
opaque finalizers and cleanup release on the owning thread. Failed finalizer
release retains the handle and registry reference until verified cleanup.
Abandoned mutexes are acquired only through the kernel. Namespace permission
errors refuse binding.

For a provably dead Windows AF_UNIX listener, cleanup requires a still-held
opaque file binding claim. It opens the leaf without following reparse
points, verifies `IO_REPARSE_TAG_AF_UNIX`, and marks that exact handle for
deletion. Ordinary files, directories, other reparse tags and access errors
are refused. This avoids treating Bun's stale-socket `lstat` errors as proof
that an arbitrary filesystem entry may be removed.

## Distribution and reproducible builds

All eight addons are checked in, so source installs work with
`bun install --frozen-lockfile --ignore-scripts`. They support x64 and arm64
on Linux glibc (2.17 ABI baseline), Linux musl, macOS (13.0 deployment
target), and Windows. The required CI matrix covers the repository's minimum
Bun 1.3.11, Bun 1.3.13, and the release compiler, Bun 1.4.2. OS compatibility
also requires the selected Bun version's own platform minimums.

Node-API headers and their upstream license are vendored from Node
v22.15.0. `darwin-abi.h` declares the narrow public Darwin LP64 ABI needed
for SDK-free cross-compilation, with constants/layout checked against Apple
XNU tag `xnu-11215.81.4`; macOS CI compiles `abi-check.c` against the actual
SDK. The x86_64 `fstat$INODE64` symbol and arm64 `fstat` symbol are distinct.
No Apple SDK is redistributed. Windows resolves its used Node-API symbols
from the running executable through `windows-napi.h`, including renamed
compiled CLIs. It never loads a separate `node.exe`. A process-wide once
guard publishes the complete function table before any API call; missing
exports refuse registration without borrowing another runtime's environment.
The Windows IPC helpers link the OS-provided `bcrypt` CNG library and remain
within Node-API v3 and the existing Windows platform minimum.

Use the pinned Zig 0.14.1 compiler. Archive URLs, SHA-256 hashes and sizes
are in `scripts/native/toolchain.json`; setup verifies them before extracting.

```sh
bun scripts/native/setup-toolchain.ts --dir .context/native-toolchain
ZIG=/absolute/path/to/the/downloaded/zig bun scripts/native/build.ts --target all --write-manifest
bun scripts/native/verify.ts
ZIG=/absolute/path/to/the/downloaded/zig bun scripts/native/build.ts --output /tmp/native-rebuilt
bun scripts/native/verify.ts --rebuilt /tmp/native-rebuilt
```

The manifest hashes every addon plus the build inputs, compiler recipe and
toolchain metadata. Commit source, all eight regenerated binaries and the
manifest together. Builds fix the source timestamp, macOS install name and
Linux build ID behavior to permit byte-for-byte comparison across output
directories. CI rebuilds each target on its platform and compares bytes.

## Runtime validation

`bun test test/native-lock.test.ts` runs real competing Bun processes,
retained-inode checks, cancellation, deadline cleanup, live-holder staleness,
SIGKILL recovery, and fail-closed missing-addon/invalid-path cases.
`test/scripts/native-lock-prebuilds.test.ts` proves source/binary tampering
fails verification and checks that the required CI matrix covers all twenty-four
target/runtime pairs. Native CI also runs the tests in native musl userspace.

`bun scripts/native/compiled-smoke.ts` builds a focused executable importing
the exact production wrapper, proves two compiled processes exclude each
other, kills the holder and proves immediate handoff. Release CI additionally
passes `--binary bin/<artifact>` to require that the actual CLI executable
embeds the exact current-platform addon. That assertion verifies packaging;
the focused executable verifies compiled lock execution.

`bun scripts/native/cli-persistence-smoke.ts --binary bin/<artifact>` copies
the actual release executable outside the source checkout and exercises keyless
disk-PGLite initialization, native ownership activation, canonical publication,
revision conflicts with typed receipts, exact replay, resident stdio/CLI IPC,
and shutdown/reopen. Release CI runs it for both published Linux x64 and macOS
arm64 artifacts. Child homes and credentials are isolated; the script never
loads repository TypeScript or adjacent native files to satisfy the executable.
