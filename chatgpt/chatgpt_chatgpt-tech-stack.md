---
conversation_id: 68c6fb86-f908-832b-87e9-89f2ad54f3dc
created: 2025-09-14
links:
- '[[chatgpt-clusters/coding_ai_ml]]'
message_count: 4
source: chatgpt-export
tags:
- chatgpt
- import
title: ChatGPT tech stack
type: note
updated: 2025-09-14
---

# ChatGPT tech stack

**Related:** [[coding_ai]]

> Conversation ID: 68c6fb86-f908-832b-87e9-89f2ad54f3dc
> Created: 2025-09-14T17:29:43Z
> Updated: 2025-09-14T17:31:51Z
> Messages: 4

---

## User

How is chatgpt built. The actual tech stack and what is actually being used to make the magic happen

---

## Assistant

Mr. White — here’s the real stack, stripped to essentials:

## Core model & training
- **Architecture:** Transformer LLMs (now “omni”/multimodal for GPT-4o: one network that natively handles text, images, audio). citeturn1search0turn1search2  
- **Method:** Large-scale pretraining (next-token prediction) + supervised finetuning + **RLHF** safety alignment (outlined at a high level in the GPT-4 technical report/system card). citeturn0search5turn1search6  
- **Frameworks & kernels:** **PyTorch** plus OpenAI’s **Triton** (Pythonic GPU-kernel compiler) for custom, faster kernels. citeturn0search3  

## Compute & infrastructure
- **Where it runs:** Microsoft **Azure AI supercomputers** purpose-built with NVIDIA GPUs (A100/H100 generations), NVLink/InfiniBand networking, massive storage; this is the main platform behind ChatGPT serving/training. citeturn0search4turn0search0  
- **Additional capacity:** Reporting indicates OpenAI has also rented **Google TPU** capacity in 2025 to augment supply. citeturn0news44  
- **Environmental footprint:** Training runs (e.g., GPT-4) were associated with large data-center builds (Iowa) and heavy cooling/water usage. citeturn0news45  

## Inference (how responses are made fast/cheap)
- **Batching + KV caching** (standard transformer serving), **tensor/sequence parallelism** (on GPU clusters). (Implied by Azure/LLM serving talks.) citeturn0search4  
- **Speculative decoding / “predicted outputs”** to accelerate token generation (draft small model, verify with big model). OpenAI published/spec’d this technique and has shipped variants. citeturn0search2turn0search6turn1search3  
- **Long contexts & structured outputs:** Current models support large context windows (up to **1M tokens** in the GPT-4.1 family) and schema-locked JSON (**Structured Outputs**). citeturn1news41turn1search16  

## Product layer (ChatGPT)
- **App/API:** ChatGPT (web/mobile) is a thin app over OpenAI’s inference API (also exposed via **Azure OpenAI Service**). Newer multimodal/runtime features (e.g., GPT-4o/Realtime) run on the same infra. citeturn1search10  
- **Safety/quality controls:** System prompts, policy filters, eval gates, and post-training alignment described in model **System Cards** (e.g., GPT-4o). citeturn1search2turn1search6  

## TL;DR
**Transformer models** trained at massive scale (PyTorch + **Triton** kernels) on **Azure** supercomputers (NVIDIA GPUs), increasingly augmented by **TPUs**; served with heavy **batching/KV cache** and **speculative decoding**; wrapped in an API/app with **alignment & safety** layers documented in **system cards**. citeturn0search4turn0search3turn0search2turn1search2

If you want a deeper dive on any one layer (kernels, serving patterns, or Azure topology), say which and I’ll zoom in.

---

## User

What is the actual frontend

---

## Assistant

Mr. White — short and straight:

## ChatGPT’s **frontend**
- **Web app:** Built with **TypeScript + React**. (OpenAI’s own frontend roles require React/TypeScript; their marketing/front-site roles explicitly call out **Next.js**.) citeturn0search0turn0search4turn0search11  
  *Anecdotal but telling:* engineers have spotted React error signatures in the live app (minified React errors). citeturn0search9
- **Voice / Realtime UI (web):** Uses **WebRTC** (and WebSockets) for low-latency audio in/out, plus Web Audio/MediaDevices in the browser. OpenAI/Azure docs and independent deep dives show the exact flows. citeturn0search2turn0search16turn0search10
- **Mobile apps:** **Native**—industry consensus and dev discussions point to **iOS (Swift/SwiftUI)** and **Android (Kotlin/Jetpack Compose)** rather than cross-platform frameworks. (Not formally documented by OpenAI, but consistent with app behavior and community technical threads.) citeturn1search18turn1search11turn1search9

If you want, I can sketch the exact client architecture (React app shell + API client, streaming handlers, Realtime WebRTC graph) for your Jovie stack in a diagram.


**Topic:** [[chatgpt-clusters/coding_ai]]
