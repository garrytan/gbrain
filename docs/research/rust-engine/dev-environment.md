# Rust engine: dev machine setup

One script sets up an Ubuntu machine for Rust engine parity work: the right
Bun, a local Postgres with pgvector, the Rust toolchain and the napi-rs CLI.
It serves the Rust engine plan (`docs/designs/RUST_ENGINE.md`, proposed in
https://github.com/garrytan/gbrain/pull/9593 and not yet merged).

## Run it

From the repository root:

```bash
bash scripts/dev/rust-engine-bootstrap.sh && . ~/.gbrain-rust-dev.env
```

It needs Ubuntu and root or passwordless sudo. It never prompts. Run it again
at any time: it skips what is already there, and after a machine restart it
only starts Postgres again. It ends with one line per step and
`RESULT: PASS` or `RESULT: FAIL`. Each run writes every step's full output to
a new private folder, `~/.gbrain-rust-dev/logs/run-<time>-<random>/<step>.log`,
and prints that folder's path first. Old run folders stay until you delete them.

The script ignores `PGHOST`, `PGHOSTADDR` and `PGSERVICE` (it unsets them for
itself), so it always works on the local `16/main` cluster.

## What it does

| Step | What happens |
|---|---|
| `preflight` | Checks for Ubuntu and sudo. Installs `ca-certificates`, `curl`, `unzip`, `git`, `pkg-config`, `python3`, `procps` and a C compiler if they are missing. The e2e wrapper needs `python3` and `pgrep`. |
| `bun` | Installs the Bun version in `package.json` `engines.bun` (1.4.4 today) into `~/.bun`, and links `bun` and `bunx` into `/usr/local/bin`, so it wins over an older system Bun in every shell. |
| `postgres` | Installs `postgresql-16` and `postgresql-16-pgvector` from the PostgreSQL apt archive if they are missing. `pg_trgm` and `pgcrypto` come with the server. |
| `pg-start` | Creates the `16/main` cluster if there is none and starts it. It uses `pg_ctlcluster`, so it works without systemd. |
| `pg-database` | Creates the role `gbrain` (password `gbrain`, superuser) if it does not exist, and the database `gbrain_test`, and enables `vector`, `pg_trgm` and `pgcrypto` in it. It never changes a role that already exists. If that role cannot log in with the configured password or is not a superuser, the step fails and tells you to set `GBRAIN_DEV_PG_USER` or `GBRAIN_DEV_PG_PASSWORD`. |
| `rust` | Installs rustup with the stable toolchain, `rustfmt` and `clippy`, and links `cargo`, `rustc`, `rustup`, `rustfmt`, `cargo-fmt`, `cargo-clippy`, `clippy-driver` and `rustdoc` into `/usr/local/bin`. |
| `napi-cli` | Installs the napi-rs CLI (`@napi-rs/cli` 3.x) as a global Bun tool, plus a small `napi` wrapper in `~/.gbrain-rust-dev/bin` that runs it on Bun. Node is not needed: Ubuntu's Node 18 is too old for the CLI. Nothing is added to `package.json`. |
| `bun-install` | Runs `bun install --frozen-lockfile` in the repository. |
| `env-file` | Writes `~/.gbrain-rust-dev.env` (mode 600). |

The role is a superuser because the tests run `CREATE DATABASE` and
`CREATE EXTENSION vector`. It is for a throwaway dev machine only.

## Environment variables

The env file sets these:

| Variable | Value |
|---|---|
| `PATH` | `~/.gbrain-rust-dev/bin`, `~/.cargo/bin` and `~/.bun/bin` in front, in that order |
| `BUN_INSTALL`, `CARGO_HOME`, `RUSTUP_HOME` | `~/.bun`, `~/.cargo`, `~/.rustup` |
| `RUST_ENGINE_DATABASE_URL` | A `postgresql://` URL for role `gbrain` (password `gbrain`) on `127.0.0.1:5432`, database `gbrain_test` |

The env file does not set `DATABASE_URL`, on purpose. The tests read
`DATABASE_URL`, but the test preload
(`test/helpers/database-url-guard-preload.ts`) stops every plain `bun test`
while it is set, to protect real brains. So you pass it on the command line of
the e2e wrapper only, as shown below. The database name must contain `test` as
a word (`gbrain_test` does), or `test/helpers/db-guard.ts` refuses it.

You can change the defaults before the run with `GBRAIN_DEV_BUN_VERSION`,
`GBRAIN_DEV_PG_PORT`, `GBRAIN_DEV_PG_USER`, `GBRAIN_DEV_PG_PASSWORD`,
`GBRAIN_DEV_PG_DB` (letters, digits and `_` only), `GBRAIN_DEV_ENV_FILE`,
`GBRAIN_DEV_BIN` and `GBRAIN_DEV_LOG_DIR`. Set `GBRAIN_DEV_LINK_BINS=0` to
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
| Script, fresh `ubuntu:24.04` container (no Bun, Postgres, Rust or Node; user with passwordless sudo) | PASS | 52 s |
| Script again, same container | PASS | 0 s |
| `test/pglite-engine.test.ts`, same container | 110 pass, 0 fail | 6 s |
| `test/e2e/engine-parity.test.ts`, same container, Postgres 16.16 + pgvector 0.8.7 | 76 pass, 0 fail | 56 s |
| Script, dev VM (Postgres 16 installed but stopped, Bun 1.3.14) | PASS | 36 s |
| Script again, same VM | PASS | 1 s |
| `test/pglite-engine.test.ts`, same VM | 110 pass, 0 fail | 5 s |
| `test/e2e/engine-parity.test.ts`, same VM, Postgres 16.14 + pgvector 0.8.2 | 76 pass, 0 fail | 53 s |

In the fresh container, most of the 52 s went to apt: base packages 20 s,
Postgres 17 s. Rust took 8 s.

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
- If you set `GBRAIN_DEV_LOG_DIR`, it must be a folder you own that no other
  user can write to. The script stops otherwise.
- Run the tests with `PGHOSTADDR` and `PGSERVICE` unset. The script clears them
  only for itself, not in your shell, and either one could send the test
  connection to a different server.
- An existing `gbrain` role from other work is kept. If its password is not
  `gbrain`, set `GBRAIN_DEV_PG_PASSWORD` to its password or pick another name
  with `GBRAIN_DEV_PG_USER`.
