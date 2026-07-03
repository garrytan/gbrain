# Memvelope Ingestion

## Goal
Seed a brain from years of AI chat history -- ChatGPT and Claude exports -- instead of starting empty.

## What the User Gets
Without this: years of useful prompts, answers, decisions, and project context stay trapped in vendor exports. With this: each conversation becomes a durable brain page that `gbrain sync` can ingest, search, and route through conversation-aware features.

## Implementation

1. Export chat history from the vendor.
   - ChatGPT: Settings -> Data controls -> Export.
   - Claude: Settings -> Privacy -> Export data.
2. Convert the export to a Memvelope envelope. The free in-browser converter at memvelope.com works, or use any tool conforming to the spec at github.com/memvelope/memvelope. The spec repo contains the format, JSON schema, and golden fixtures. Nothing uploads; conversion is client-side.
3. Write conversation pages into the brain repo:

   ```bash
   node scripts/envelope-to-gbrain.mjs history.mve.json <brain-repo>/conversations
   ```

4. Sync the brain:

   ```bash
   gbrain sync
   ```

Each conversation lands as one Markdown page. The filename is date + conversation id, so shared titles cannot collide. Frontmatter carries `type: conversation`, the source provider, the Memvelope conversation id, and `origin: memvelope/envelope-v0`. The body keeps message-id citations beside each speaker turn.

## Tricky Spots

1. **Duplicate conversation ids warn loudly.** The importer overwrites the colliding filename because the id is the natural key, but stderr reports the collision and stdout reports DISTINCT files written, not write calls.
2. **Page dates come from the conversation timestamp.** The page `date` is the first 10 characters of `created_at`; envelope timestamps are ISO-8601.
3. **Large exports are fine.** The importer streams nothing and holds one envelope in memory. In validation, a 662MB source export reduced to a much smaller envelope before import.
4. **Conversation type matters.** `type: conversation` keeps these pages eligible for conversation-facts extraction and chronicle behavior after sync.

## How to Verify

1. Run the checked-in sample fixture:

   ```bash
   node scripts/envelope-to-gbrain.mjs test/fixtures/memvelope/sample.mve.json /tmp/gbrain-memvelope-sample
   ```

   Expect `wrote 1 markdown page(s)`.

2. Run the importer tests:

   ```bash
   bun test test/envelope-to-gbrain.test.ts
   ```

3. After `gbrain sync`, run keyword searches from the imported conversations. Confirm the pages are searchable and `type: conversation` features apply.

