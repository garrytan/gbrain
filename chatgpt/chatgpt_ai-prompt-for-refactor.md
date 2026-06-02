---
title: "AI prompt for refactor"
type: note
created: 2025-08-29
updated: 2025-08-29
source: chatgpt-export
conversation_id: 68b101c8-cd90-8327-9b34-9b3916c053e1
message_count: 6
tags: [chatgpt, import]
---
# AI prompt for refactor

> Conversation ID: 68b101c8-cd90-8327-9b34-9b3916c053e1
> Created: 2025-08-29T01:26:51Z
> Updated: 2025-08-29T01:28:21Z
> Messages: 6

---

## User

Give me an ai prompt for this

Do a comprehensive refactor of the dashboard for atomic design

But don’t specify any specifics just general principles 

---

## Assistant

Here’s a clean, general-purpose AI prompt you can use:  

---

**Prompt:**  
Refactor the entire dashboard following atomic design principles. Break down the interface into atoms, molecules, organisms, templates, and pages, ensuring maximum reusability, scalability, and consistency. Focus on clarity, hierarchy, and modularity without prescribing specific UI elements. Optimize for maintainability, easy iteration, and future expansion. Ensure the system feels cohesive and polished, while staying abstract enough that concrete design or implementation details are not assumed.  

---

Do you want me to also make a **developer-focused variant** (emphasizing code structure, componentization, and naming conventions) alongside this design-focused one?

---

## User

Focus on no duplicate code and leveraging next JS best practices 

---

## Assistant

Got it. Here’s a version tuned to your request:  

---

**Prompt:**  
Refactor the entire dashboard using atomic design principles while strictly eliminating duplicate code. Structure components into atoms, molecules, organisms, templates, and pages to maximize reusability and maintainability. Leverage Next.js best practices for performance, scalability, and clean architecture (e.g., clear separation of server and client components, optimal routing, and data fetching patterns). Focus on modularity, consistency, and future-proofing, ensuring the system is easy to extend and adapt without repeating logic or styles. Keep the guidance general and principle-driven rather than prescribing specific UI details.  

---  

Do you want me to also make a **technical checklist variant** (like bullet points a dev could follow step-by-step in Next.js), or keep it at this high-level principle format?

---

## User

Tell it to respect our Claude.md file rules

---

## Assistant

Here’s the updated version with that baked in:  

---

**Prompt:**  
Refactor the entire dashboard using atomic design principles while strictly eliminating duplicate code. Structure components into atoms, molecules, organisms, templates, and pages to maximize reusability and maintainability. Leverage Next.js best practices for performance, scalability, and clean architecture (e.g., clear separation of server and client components, optimal routing, and data fetching patterns). Ensure the refactor respects all rules and conventions defined in the `claude.md` file, including PR processes, test expectations, and coding standards. Focus on modularity, consistency, and future-proofing, keeping the guidance general and principle-driven rather than prescribing specific UI details.  

---  

Want me to compress this into a **one-liner command-style prompt** (so you can drop it straight into your Claude/agent workflow), or keep it descriptive?


**Topic:** [[chatgpt-clusters/code_review]]
