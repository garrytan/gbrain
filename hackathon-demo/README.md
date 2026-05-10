# GBrain Hackathon Demo — Persistent AI Memory for Child Learning

## What this demos

Two sessions. One child. Before vs after.

Session 1: Child asks about dinosaurs. GBrain stores the learning event.
Session 2: Agent opens knowing exactly where the child left off.

## Setup

```bash
cd hackathon-demo
bun install
cp .env.example .env
# Fill in GBRAIN_URL and GBRAIN_TOKEN in .env
bun run dev
```

## Stack

- Vanilla HTML + CSS + JS (fastest to build and demo)
- Web Speech API (browser-native voice input, no backend needed)
- GBrain HTTP MCP API (your Azure-deployed instance)
- Claude claude-haiku-4-5-20251001 via Anthropic SDK (cheapest, fastest for demo)
