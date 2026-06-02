---
title: "OpenAI and Anthropic Tech"
type: note
created: 2026-03-03
updated: 2026-03-03
source: chatgpt-export
conversation_id: 69a738f1-e18c-8330-95bc-f5916ab428c6
message_count: 9
tags: [chatgpt, import, long-form]
---
# OpenAI and Anthropic Tech

> Conversation ID: 69a738f1-e18c-8330-95bc-f5916ab428c6
> Created: 2026-03-03T19:39:32Z
> Updated: 2026-03-03T19:42:52Z
> Messages: 9

---

## User

what libraries or packages are open ai and anthropic using

---

## Assistant

High-level packages and libraries directly used by **OpenAI** and **Anthropic** aren’t comprehensively published by either company, but you can infer important parts of their stacks from official SDKs, public standards, and community knowledge:

## **OpenAI**
**SDKs / API client libraries**
- Official **OpenAI SDKs** for multiple languages (Python, JavaScript/TypeScript, .NET, Java, Go) to call OpenAI APIs. These are wrappers around REST endpoints and handle auth, requests, and responses. citeturn1search4

**Typical ML & infrastructure libraries (industry standard)**
While OpenAI doesn’t publish its internal training stack in detail, widely used open-source ML frameworks are standard for training and experimentation in the research community:
- **PyTorch** – primary deep learning framework for model development and training (common in the industry).  
- **DeepSpeed**, **Accelerated Linear Algebra (XLA)** and other optimization tools help scale training.  
- **JAX** + **Flax/Optax** – used for research and scalable array computation in many modern LLM research setups.

These libraries are typical in large LLM training pipelines, even if not explicitly detailed by OpenAI (industry standard in large model training and research).  

**Standards / protocols**
- **Model Context Protocol (MCP)** – an openAI-adopted open standard (originated by Anthropic) for communicating between models and applications. OpenAI has integrated MCP into parts of its ecosystem. citeturn1search20

## **Anthropic**
**API and developer libs**
- Official client SDKs in languages like **Python**, **TypeScript**, **Ruby**, **Go**, **C#**, etc., for calling the Claude API. citeturn0search1

**Open standards and protocols**
- **Model Context Protocol (MCP)** – open-source framework developed by Anthropic to standardize tool and data integration for LLMs; includes SDKs in Python, TypeScript, Java, C#, and others. citeturn1search20

**Agent & integration frameworks**
Anthropic has released or supports:
- Claude Agent SDK / agentic libraries (in community/official docs) with context management and modular tooling, though specifics vary by platform and language (Python/TypeScript communities).  
- MCP implementations and reference servers (JSON-RPC based).

## **Shared ecosystem components**
Both companies interact with and support the broader ML/AI ecosystem, including open-source tooling:
- **Transformers ecosystem** (Hugging Face) for model architectures and tokenizers.
- **Vector databases**, orchestration frameworks (e.g., LangChain, LlamaIndex) when building applications on top of LLM APIs.
- Distributed training and optimization libraries (DeepSpeed, Horovod) are widely used in large-model contexts, though not explicitly confirmed as core infrastructure for either company.

**Summary**
- **OpenAI**: Official multi-language API SDKs, industry-standard ML frameworks (PyTorch, JAX ecosystem), and adoption of open protocols like MCP. citeturn1search4turn1search20  
- **Anthropic**: Official client SDKs, Model Context Protocol (open-source), and agent-oriented tooling / libraries across languages. citeturn0search1turn1search20

This reflects *external developer-facing* packages and inferred common stacks; internal proprietary optimizations and training libraries are generally not publicly detailed.

---

## User

what about things like tanstack query or nuqs

---

## Assistant

If you’re asking *whether OpenAI or Anthropic themselves use frontend libraries like **TanStack Query** or **Nuqs** in their official products (e.g., ChatGPT, Claude web UIs / dashboards)* — that information is **not publicly documented** and there’s no official stack breakdown confirming use of those specific libraries.

Here’s what is known and what can be reasonably inferred from public sources:

### Libraries *They Provide / Officially Support*
- **OpenAI** publishes official SDKs for languages like JavaScript/TypeScript, Python, .NET, Java, Go, etc., for interacting with their API. These are application-agnostic client libraries and not tied to any specific UI/state management library. citeturn0search4
- **Anthropic** similarly publishes client libraries/SDKs for accessing Claude but does not publish its internal frontend stack.

### Frontend Libraries Like TanStack Query & Nuqs
- **TanStack Query** and **Nuqs** are open-source libraries for React state and URL/search param management widely used by developers building applications that *consume* APIs — including OpenAI and Anthropic APIs — but there’s no official statement that either company uses them internally in their own web products.  
- There *are* ecosystem tools that integrate AI providers (OpenAI, Anthropic) with libraries like TanStack: for example **TanStack AI** provides unified adapters/clients for AI backends including OpenAI and Anthropic in TypeScript/React apps. citeturn0search8

  - TanStack AI includes provider adapters (OpenAI, Anthropic, Gemini, etc.) so a developer can use a common interface with those providers. citeturn0search8

- **Nuqs** is a lightweight URL/state manager for React apps with *adapter support* for React, Next.js, and even integration with TanStack Router — but this is a community library, not a dependency explicitly tied to OpenAI or Anthropic. citeturn0search6turn0search16

### Internal Stacks Are Proprietary
- Neither OpenAI nor Anthropic publishes detailed internal frontend stacks that confirm use of specific tools like TanStack Query or Nuqs in their own dashboards, apps, or management UIs. Most of what they use internally for frontend engineering is proprietary or not publicly detailed.

### Summary
- **Officially supported libraries** from OpenAI/Anthropic are the API client SDKs in various languages. citeturn0search4  
- **Community ecosystem libraries** (e.g., **TanStack AI**) can integrate with OpenAI/Anthropic APIs, but that doesn’t mean the companies themselves use them internally. citeturn0search8  
- There is no public evidence that OpenAI or Anthropic *directly use* frontend packages like **TanStack Query** or **Nuqs** in their own web products.

If you are asking which libraries to use *when building your own apps on top of OpenAI/Anthropic APIs*, libraries like **TanStack Query** (data fetching) and **Nuqs** (URL state) are popular and valid choices, even though they are not official dependencies of those platforms.

---

## User

i mean like what are they using in house in their apps. like do the use dom pirief or anything liek that. you have their code to search through on github. are any using anything interest like what do their lock fiels lists

---

## Assistant

**Direct answer:** There is *no public evidence* that OpenAI or Anthropic’s *internal proprietary production applications* (e.g., the ChatGPT front end, Claude web UI, mobile app) have their source code open-sourced on GitHub. That means we **cannot pull their actual lockfiles** (yarn.lock, package-lock.json, pnpm.lock.yaml) for those products and enumerate the exact libraries they use internally.

All you *can* examine are the **open-source repos they have published**. These are mostly SDKs, tooling, or example projects — not the internal codebases for the web apps that run ChatGPT or Claude for end users. That severely limits what you can infer about their *actual application stacks*. Here’s what is publicly available and observable from published repositories:

---

## **OpenAI (published code)**
### **Official SDKs and Tooling**
- **openai-node** — official TypeScript/JavaScript SDK for the OpenAI API. It includes a `yarn.lock` in the repository, which means this SDK itself has a dependency tree, but that’s just for *API client functionality*; it’s not the production UI stack. citeturn0search0
- **openai-agents-js / openai-agents-python** — SDKs for building agent workflows. These include `pnpm-lock.yaml`, TypeScript tooling configs, Vitest test configs, etc. This shows they use modern TypeScript tooling, test frameworks, and package managers. citeturn0search1
- **openai-assistants-quickstart** — example Next.js project with a `package-lock.json`, used for starter web apps integrated with OpenAI APIs. By inspecting that lockfile (it’s long), you’d see dependencies common to Next.js apps (React, Next, streaming utilities, websockets, etc.) — but *this is a template*, not the internal ChatGPT production UI. citeturn1search0

### **What this tells us**
From those repos, you can see the sort of libraries used *in SDKs and examples*:

- TypeScript + Node tooling: `typescript`, `@types/*`, build/test tools (like `vitest` in the Agents SDK). citeturn0search1
- Modern package managers (`pnpm`, `yarn`) showing standard ecosystem usage. citeturn0search1
- Example apps often depend on React/Next.js — but that’s from demo starter projects, not OpenAI’s internal products. citeturn1search0

Nothing in these public repos shows use of unusual front-end libraries like **DOM Pirief** (not publicly recognized), **Nuqs**, or unconventional state management — only typical ecosystem packages tied to the purpose of that repo.

---

## **Anthropic (published code)**
### **Official Repositories**
Anthropic’s public GitHub org shows several key repositories:

- **anthropic-sdk-typescript**, **-python**, **-go**, etc. — official SDKs for Claude APIs in multiple languages. citeturn1search1
- **claude-agent-sdk-typescript** — TypeScript SDK for agent tooling. citeturn1search1
- **claude-code** — the agentic coding CLI tool; actual source includes code in Shell, Python, and TypeScript. citeturn1search5

These repos are tools or SDKs — not the internal Claude web/app UI stacks.

### **Implications**
From available repos you can *inspect lockfiles and package.json files* for these published SDKs. They will show typical language runtimes (TypeScript tooling, Python dependencies, Go modules, Ruby gems, etc.) — but not evidence that Anthropic internally uses any opaque or exotic libraries like the ones you asked about.

---

## **What you *cannot* do via GitHub**
- You **do not have the production source** for the ChatGPT web UI or the internal Claude application code on GitHub.
- There are **no public lockfiles** for OpenAI’s ChatGPT UI or Anthropic’s Claude UI published in official repos.
- Therefore you cannot legitimately extract the **real production dependency lists** for those front-end stacks from official source code — because those codebases are **closed source**.

---

## **What the lockfiles from public repos *would show***
If you inspect lockfiles in *open source examples* like an SDK or quickstart project (e.g., `openai-assistants-quickstart`), you’d typically see dependencies like:

- **React / Next / React DOM / SWR / Tailwind** (common in web starter kits)  
- **TypeScript + bundlers / linters** (`tsconfig`, ESLint, Prettier)  
- **Test frameworks** (`vitest`, `jest`) in SDK repos that include test suit configs  
- **HTTP clients** (`httpx` in Python, `node-fetch` or `undici` in JS SDKs)

But since these are *starter/example* projects, they reflect community conventions, not the internal UI codebases.

---

## **Summary**
**What you *can* see in published code:**
- SDKs and tools use standard ecosystem libraries (TypeScript tooling, build/test frameworks, HTTP clients, etc.). citeturn0search0turn0search1

**What you *cannot* see publicly:**
- The internal ChatGPT/Claude app stacks with their lockfiles and exact dependencies.  
- Any proprietary usage of specific front-end libraries like **DOM Pirief**, **Nuqs**, or internal state/data-fetch libraries.

Because those production codebases are *not open-source*, there is no public lockfile to inspect to answer specifically “what libraries is their UI using” — only that the open-source SDKs and templates use standard ecosystem packages.

---

## Assistant

There is **no public access to OpenAI’s or Anthropic’s private production repositories**, lockfiles, or internal dependency graphs. Neither company publishes the source for ChatGPT, Claude, or their internal dashboards. I do not have access to their private codebases.

What can be determined from public sources:

## 1. Public GitHub Repositories
Both companies have open-source repos (SDKs, tooling, eval frameworks, MCP, etc.). Those repos expose their **library choices for those specific projects**, but they do **not** reflect the internal stack used for ChatGPT or Claude web apps.

Examples:
- OpenAI JS SDK → uses standard TypeScript tooling (tsup, zod, fetch, etc.)
- Anthropic SDKs → similar modern TypeScript/Python toolchains

These are typical for SDK libraries, not product frontends.

## 2. Production App Stack (ChatGPT / Claude Web)

There is **no official disclosure** of their frontend architecture. However, from publicly observable behavior and job postings, you can reasonably infer:

### Likely
- **React** (strongly implied from hiring patterns and industry norm)
- **Next.js or custom React framework**
- TypeScript
- Modern build tooling (Vite, Webpack, Turbopack, or internal equivalents)
- Internal design system components
- Custom streaming + websocket infrastructure
- Likely heavy internal abstractions around model streaming and state

### Not Publicly Confirmed
There is **no confirmation** they use:
- TanStack Query
- Nuqs
- DOMPurify
- Zustand
- Redux
- React Query
- SWR
- etc.

Security libraries like **DOMPurify** are common in apps rendering user-generated HTML, but there is no public evidence confirming usage by either company.

## 3. What You Can Actually Inspect
You can inspect:

- OpenAI open-source repos:
  - `openai/openai-node`
  - `openai/openai-python`
  - `openai/evals`
  - `openai/mcp` related work

- Anthropic repos:
  - `anthropics/anthropic-sdk-typescript`
  - `anthropics/anthropic-sdk-python`
  - MCP repos

Those lockfiles reflect standard modern TypeScript or Python dependency stacks, not their product frontend stack.

## 4. Internal Tooling Reality
At their scale, it is highly probable that:
- Large portions of their frontend and infra are **custom internal frameworks**
- They avoid dependency sprawl in core surfaces
- They may use internal forks of common tooling
- They likely prioritize performance, streaming reliability, and security over trendy frontend libraries

Companies at that level often:
- Write custom data-fetch layers
- Avoid heavy client cache abstractions
- Use bespoke sanitization and rendering layers
- Use server components or hybrid SSR strategies

## Direct Answer

There is **no public evidence** that OpenAI or Anthropic use TanStack Query, Nuqs, DOMPurify, or similar libraries in their production web apps. Their private lockfiles are not public. Their GitHub repositories only reflect SDK/tooling dependencies, not the ChatGPT or Claude frontend stack.

If you want, specify whether you’re analyzing this for:
- Hiring benchmarking  
- Stack comparison  
- Competitive intelligence  
- Architectural inspiration  

The answer differs depending on intent.

---

## User

yeah i want dependincies

---

## Assistant

There is no public access to the private ChatGPT or Claude production lockfiles.

Below are **dependencies visible in their public GitHub SDK repositories**, which are the only inspectable sources.

---

## entity["organization","OpenAI","ai research company"] – Public JS SDK (`openai-node`)

From public `package.json` (recent versions):

**Runtime deps**
- `undici` (HTTP client)
- `formdata-node`
- `zod` (schema validation)
- `agentkeepalive` (Node HTTP keepalive)
- `node-fetch` (older versions)

**Dev / build tooling**
- `typescript`
- `tsup` (bundler)
- `vitest`
- `eslint`
- `prettier`

Observations:
- No TanStack Query
- No Redux
- No SWR
- No React dependencies (it’s backend SDK only)
- Very minimal runtime surface

---

## entity["organization","Anthropic","ai safety research company"] – Public TypeScript SDK

Typical dependencies:

**Runtime deps**
- `cross-fetch` or native fetch
- `zod` (in some tooling layers)
- Minimal HTTP abstraction

**Dev / build tooling**
- `typescript`
- `tsup` or similar bundler
- `vitest`
- `eslint`

Also intentionally lean. No frontend libraries.

---

## Python SDKs (Both Companies)

Common dependencies:

- `httpx`
- `pydantic`
- `typing-extensions`
- `anyio`

Again: API client only.

---

## What You Will NOT Find Publicly

There are **no published lockfiles** for:

- ChatGPT frontend
- Claude web app
- Internal dashboards
- Design systems
- Production infra

No evidence of:
- TanStack Query
- Nuqs
- Zustand
- Redux
- SWR
- DOMPurify

Those may exist internally, but nothing public confirms them.

---

## Realistic Inference (Large AI Web App Pattern)

Based on industry norms for teams at their scale, likely characteristics:

- React + TypeScript
- Internal data-fetch abstraction
- Custom streaming layer
- Custom markdown/HTML sanitization
- Heavy server-side rendering or hybrid SSR
- Strong bias toward minimizing third-party frontend state libraries

Companies at that level often write their own cache + streaming layer instead of adopting TanStack Query.

---

If you want, I can:

- Pull exact current dependency trees from their public repos
- Compare their SDK dependency footprint vs competitors
- Analyze what a “ChatGPT-scale” frontend likely avoids dependency-wise
