# GBrain Setup & File Ingestion Guide

A step-by-step record of how GBrain was installed from source and used to ingest
Excel-format customer data files into a new local knowledge base.

---

## Prerequisites

- Linux / macOS
- **Bun** runtime (GBrain requires Bun — it will not run on plain Node)
- No database server needed for the default PGLite engine

---

## Step 1 — Clone the repository

```bash
git clone https://github.com/sixuerain/gbrain.git
cd gbrain
```

## Step 2 — Install dependencies and link the CLI

```bash
bun install        # installs all packages (~276 packages, may take a few minutes)
bun link           # creates the `gbrain` symlink in ~/.bun/bin/
```

Add Bun's bin directory to your PATH if it isn't already:

```bash
export PATH="$HOME/.bun/bin:$PATH"
# To make it permanent, add the line above to ~/.bashrc or ~/.zshrc
```

Verify the install:

```bash
gbrain --version   # should print e.g. "gbrain 0.41.27.0"
```

---

## Step 3 — Initialize a new brain (PGLite, no server)

GBrain defaults to an embedded Postgres-via-WASM engine called PGLite.
No external database is required.

### Without an embedding provider (keyword search only)

If you don't have an OpenAI / ZeroEntropy / Voyage API key yet, initialize
without embeddings and add one later:

```bash
gbrain init --pglite --no-embedding
```

### With an embedding provider (full vector + hybrid search)

```bash
export OPENAI_API_KEY=sk-...
# or
export ZEROENTROPY_API_KEY=ze-...
# or
export VOYAGE_API_KEY=pa-...

gbrain init --pglite
```

After init, run the health check:

```bash
gbrain doctor --json
```

---

## Step 4 — Ingest files

### Supported binary file types

GBrain stores binary files (Excel, PDF, images, audio, etc.) in its file store
via `gbrain files upload`. The file is recorded in the database with its MIME
type and a content hash; it does NOT get chunked or embedded. Use
`gbrain import` for Markdown / code files that should be chunked and searched.

### Upload a single file

```bash
gbrain files upload /path/to/file.xlsx
```

On success the CLI prints the storage path:

```
Uploaded: unsorted/<uuid-prefix>-<filename>.xlsx (75 KB)
```

### Upload multiple files (shell loop)

```bash
for f in /path/to/data/*.xlsx /path/to/data/*.xls; do
  echo "Uploading: $f"
  gbrain files upload "$f"
done
```

### Filename gotcha — fullwidth/special characters

GBrain's CLI argument parser chokes on certain Unicode characters such as
fullwidth parentheses `（）`. If a filename contains such characters, copy the
file to a plain-ASCII name first:

```bash
cp "KIKI 客户资料（Hedy）.xlsx" /tmp/KIKI_Hedy.xlsx
gbrain files upload /tmp/KIKI_Hedy.xlsx
```

---

## Files ingested in this session

All files below are customer management Excel spreadsheets. They were uploaded
to the `unsorted/` namespace inside the default `host` brain.

| Original filename | Storage path |
|---|---|
| Vivian礼品客户管理表.xls | `unsorted/9234a876-Vivian礼品客户管理表.xls` |
| 所有客户8 .xlsx | `unsorted/94e6bebb-所有客户8 .xlsx` |
| 所有客户1.xlsx | `unsorted/e0fc553e-所有客户1.xlsx` |
| 所有客户 .xlsx | `unsorted/94e6bebb-所有客户 .xlsx` |
| KIKI 客户资料（Hedy）.xlsx | `unsorted/11ba19a4-KIKI_Hedy.xlsx` (renamed) |
| KIKI礼品客户管理表.xls | `unsorted/0fe30357-KIKI礼品客户管理表.xls` |
| KIKI  客户资料2026.05.28.xlsx | `unsorted/1e428a12-KIKI  客户资料2026.05.28.xlsx` |
| KIKI-成本表.xlsx | `unsorted/86756e32-KIKI-成本表.xlsx` |
| 客户资料2026.5.28同05.08.xlsx | `unsorted/f9e4f710-客户资料2026.5.28同05.08.xlsx` |
| 客户档案表.xlsx | `unsorted/5f70b061-客户档案表.xlsx` |
| AC Group 客户资料同05.08.xlsx | `unsorted/c7844dcf-AC Group 客户资料同05.08.xlsx` |

---

## Useful follow-up commands

```bash
# List all uploaded files
gbrain files list

# Verify file integrity (checks content hashes)
gbrain files verify

# Check brain health
gbrain doctor

# Configure an embedding model later
gbrain config set embedding_model openai:text-embedding-3-large

# Embed any pages that are missing vectors
gbrain embed --stale
```

---

## Key concepts

| Term | Meaning |
|---|---|
| **Brain** | A database instance. The default is called `host`. |
| **Source** | A named namespace inside a brain (e.g. `wiki`, `gstack`). Default is `default`. |
| **Page** | A chunked, searchable Markdown or code document. |
| **File** | A binary blob stored as-is (Excel, PDF, image). Not chunked. |
| **PGLite** | Embedded Postgres 17 running via WASM — zero config, single file on disk. |

For full documentation see `INSTALL_FOR_AGENTS.md` and `docs/INSTALL.md` in this repo.
