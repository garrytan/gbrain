# Rust engine: dev machine setup

One script sets up an Ubuntu machine for Rust engine parity work: the right
Bun, a local Postgres with pgvector, the Rust toolchain and the napi-rs CLI.
The plan this serves is [docs/designs/RUST_ENGINE.md](../../designs/RUST_ENGINE.md).

## Run it

From the repository root:

```bash
bash scripts/dev/rust-engine-bootstrap.sh && . ~/.gbrain-rust-dev.env
```

It needs Ubuntu and root or passwordless sudo. It never prompts. Run it again
at any time: it skips what is already there, and after a machine restart it
only starts Postgres again. It ends with one line per step and
`RESULT: PASS` or `RESULT: FAIL`. Each step's full output is in
`/var/tmp/gbrain-rust-bootstrap/<step>.log`.

## What it does

| Step | What happens |
|---|---|
| `preflight` | Checks for Ubuntu and sudo. Installs `curl`, `unzip`, `git`, `pkg-config`, `python3`, `procps` and a C compiler if they are missing. The e2e wrapper needs `python3` and `pgrep`. |
| `bun` | Installs the Bun version in `package.json` `engines.bun` (1.4.4 today) into `~/.bun`, and links `bun` and `bunx` into `/usr/local/bin`, so it wins over an older system Bun in every shell. |
| `postgres` | Installs `postgresql-16` and `postgresql-16-pgvector` from the PostgreSQL apt archive if they are missing. `pg_trgm` and `pgcrypto` come with the server. |
| `pg-start` | Creates the `16/main` cluster if there is none and starts it. It uses `pg_ctlcluster`, so it works without systemd. |
| `pg-database` | Creates the role `gbrain` (password `gbrain`, superuser) and the database `gbrain_test`, and enables `vector`, `pg_trgm` and `pgcrypto` in it. |
| `rust` | Installs rustup with the stable toolchain, `rustfmt` and `clippy`, and links `cargo`, `rustc` and `rustup` into `/usr/local/bin`. |
| `napi-cli` | Installs the napi-rs CLI (`@napi-rs/cli` 3.x) as a global Bun tool, plus a small `napi` wrapper in `~/.gbrain-rust-dev/bin` that runs it on Bun. Node is not needed: Ubuntu's Node 18 is too old for the CLI. Nothing is added to `package.json`. |
| `bun-install` | Runs `bun install --frozen-lockfile` in the repository. |
| `env-file` | Writes `~/.gbrain-rust-dev.env` (mode 600). |

The role is a superuser because the tests run `CREATE DATABASE` and
`CREATE EXTENSION vector`. It is for a throwaway dev machine only.

## Environment variables

The env file sets these:

| Variable | Value |
|---|---|
| `PATH` | `~/.gbrain-rust-dev/bin`, `~/.bun/bin` and `~/.cargo/bin` in front |
| `BUN_INSTALL`, `CARGO_HOME`, `RUSTUP_HOME` | `~/.bun`, `~/.cargo`, `~/.rustup` |
| `RUST_ENGINE_DATABASE_URL` | `postgresql://gbrain:gbrain@127.0.0.1:5432/gbrain_test` |

The env file does not set `DATABASE_URL`, on purpose. The tests read
`DATABASE_URL`, but the test preload
(`test/helpers/database-url-guard-preload.ts`) stops every plain `bun test`
while it is set, to protect real brains. So you pass it on the command line of
the e2e wrapper only, as shown below. The database name must contain `test` as
a word (`gbrain_test` does), or `test/helpers/db-guard.ts` refuses it.

You can change the defaults before the run with `GBRAIN_DEV_BUN_VERSION`,
`GBRAIN_DEV_PG_PORT`, `GBRAIN_DEV_PG_USER`, `GBRAIN_DEV_PG_PASSWORD`,
`GBRAIN_DEV_PG_DB`, `GBRAIN_DEV_ENV_FILE` and `GBRAIN_DEV_BIN`. Set `GBRAIN_DEV_LINK_BINS=0` to
leave `/usr/local/bin` alone, and `GBRAIN_DEV_SKIP_RUST=1` to skip Rust.

## Run the parity tests

PGLite (no database needed):

```bash
. ~/.gbrain-rust-dev.env
bun test --timeout=60000 test/pglite-engine.test.ts
```

Postgres against PGLite, through the e2e wrapper (it isolates `HOME` and opts in
to the database guard):

```bash
. ~/.gbrain-rust-dev.env
DATABASE_URL="$RUST_ENGINE_DATABASE_URL" bash scripts/run-e2e.sh test/e2e/engine-parity.test.ts
```

Run `bun test test/e2e/engine-parity.test.ts` without `DATABASE_URL` and the
Postgres half is skipped. Bun then reports about 108 tests, because it also
counts the skipped setup hooks; the real count is 76.

Pass `--timeout=60000` to a direct `bun test`. Bun ignores the timeout in
`bunfig.toml`, and PGLite's first start can take longer than Bun's 5 seconds.

## Measured runs

On 2026-11-17, at master `0d78dcfa2e`, 8 CPUs:

| Run | Result | Time |
|---|---|---|
| Script, fresh `ubuntu:24.04` container (no Bun, Postgres, Rust or Node; user with passwordless sudo) | PASS | 42 s |
| Script again, same container | PASS | 0 s |
| `test/pglite-engine.test.ts`, same container | 110 pass, 0 fail | 6 s |
| `test/e2e/engine-parity.test.ts`, same container, Postgres 16.16 + pgvector 0.8.7 | 76 pass, 0 fail | 58 s |
| Script, Vorflux sandbox (Postgres 16 installed but stopped, Bun 1.3.14) | PASS | 36 s |
| Script again, same sandbox | PASS | 1 s |
| `test/pglite-engine.test.ts`, sandbox | 110 pass, 0 fail | 5 s |
| `test/e2e/engine-parity.test.ts`, sandbox, Postgres 16.14 + pgvector 0.8.2 | 76 pass, 0 fail | 56 s |

In the fresh container, most of the 42 s went to apt: base packages 16 s,
Postgres 13 s. Rust took 8 s.

## Known problems

- Port 5432 taken: some machines also carry a Postgres 17 cluster on 5432. The
  script stops with a plain message if another server holds the port. Stop that
  server, or move one cluster to another port (`pg_lsclusters` lists them).
- A machine restart stops Postgres. Run the script again; it takes seconds.
- Each new shell needs `. ~/.gbrain-rust-dev.env` for `RUST_ENGINE_DATABASE_URL`.
  `bun`, `cargo`, `rustc` and `napi` work without it, through `/usr/local/bin`.
- The script installs the Rust stable toolchain. When the Rust workspace adds
  `rust/rust-toolchain.toml`, cargo will pick that pin up by itself.
- Ubuntu only. macOS and other Linux distributions are not supported.
