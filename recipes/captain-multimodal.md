# Captain Multimodal Search

GBrain handles text. Captain handles everything else — images, video, audio, PDFs with complex layouts. One API, same search pattern.

## What this adds

- Search photos, screenshots, diagrams by describing what's in them
- Search video recordings by scene, dialogue, or topic
- Search audio (calls, podcasts, voice memos) by spoken content
- Cross-modal reranking via Gemini so text and media results rank correctly together

GBrain's text pipeline is unchanged. Captain runs alongside it for non-text content.

## Setup

```bash
export CAPTAIN_API_KEY=cap_...       # get one at runcaptain.com/studio
export CAPTAIN_ORG_ID=019a...        # your organization ID
```

### With OpenClaw

```bash
openclaw plugins install @captain-sdk/openclaw-captain
```

Add to your OpenClaw config:

```json5
{
  plugins: {
    entries: {
      captain: {
        apiKey: process.env.CAPTAIN_API_KEY,
        organizationId: process.env.CAPTAIN_ORG_ID,
      }
    }
  },
  tools: {
    allow: [
      "captain_search",
      "captain_list_collections",
      "captain_create_collection",
      "captain_index_url",
      "captain_index_s3",
      "captain_index_text"
    ]
  }
}
```

### Without OpenClaw (direct API)

```bash
# Create a collection
curl -X PUT https://api.runcaptain.com/v2/collections/my-media \
  -H "Authorization: Bearer $CAPTAIN_API_KEY" \
  -H "X-Organization-ID: $CAPTAIN_ORG_ID"

# Index media from S3
curl -X POST https://api.runcaptain.com/v2/collections/my-media/index/s3 \
  -H "Authorization: Bearer $CAPTAIN_API_KEY" \
  -H "X-Organization-ID: $CAPTAIN_ORG_ID" \
  -H "Content-Type: application/json" \
  -d '{"bucket_name":"my-bucket","aws_access_key_id":"...","aws_secret_access_key":"..."}'

# Search
curl -X POST https://api.runcaptain.com/v2/collections/my-media/query \
  -H "Authorization: Bearer $CAPTAIN_API_KEY" \
  -H "X-Organization-ID: $CAPTAIN_ORG_ID" \
  -H "Content-Type: application/json" \
  -d '{"query":"red sneakers with white sole","rerank":true,"rerank_model":"gemini"}'
```

## Supported formats

| Type | Formats |
|------|---------|
| Documents | PDF, DOCX, TXT, MD, CSV, XLSX |
| Images | PNG, JPEG, GIF, TIFF, WEBP |
| Video | MP4, MOV, AVI, MKV, WEBM |
| Audio | MP3, WAV, AAC, FLAC, M4A, OGG |

## How it fits

```
Text (markdown, notes)  →  GBrain (pgvector + keyword + RRF)
Media (images, video, audio)  →  Captain (multimodal embeddings + Gemini reranking)
```

Both are searched. GBrain for your written knowledge. Captain for everything visual and auditory. The agent checks both and synthesizes.

## Verify

```bash
# List collections
curl https://api.runcaptain.com/v2/collections \
  -H "Authorization: Bearer $CAPTAIN_API_KEY" \
  -H "X-Organization-ID: $CAPTAIN_ORG_ID"
```

If you get a JSON response with your collections, you're good.

## Links

- [Captain docs](https://docs.runcaptain.com)
- [Multimodal search](https://docs.runcaptain.com/multimodal-search)
- [OpenClaw plugin](https://www.npmjs.com/package/@captain-sdk/openclaw-captain)
