---
title: "Biome vs ESLint Next.js"
type: note
created: 2025-12-22
updated: 2025-12-22
source: chatgpt-export
conversation_id: 6948dbf0-39e8-8331-ba30-6d938697b973
message_count: 2
tags: [chatgpt, import, code]
---
# Biome vs ESLint Next.js

> Conversation ID: 6948dbf0-39e8-8331-ba30-6d938697b973
> Created: 2025-12-22T05:49:36Z
> Updated: 2025-12-22T15:24:01Z
> Messages: 2

---

## User

biome for lint or eslint in next js

---

## Assistant

Mr. White,

**Short answer:** **Use Biome** for most new Next.js projects. Keep **ESLint** only if you rely on niche rules or plugins Biome doesn’t cover yet.

---

### Biome vs ESLint in **entity["organization","Next.js","react framework"]**

#### **entity["organization","Biome","javascript tooling"]**
**Pros**
- Extremely fast (Rust-based)
- Single tool: formatter + linter
- Zero/low config
- Opinionated rules = less bikeshedding
- Actively positioning as ESLint + Prettier replacement

**Cons**
- Smaller ecosystem
- Fewer framework-specific or niche rules

**Best for**
- Performance-focused teams  
- Clean, modern setups  
- Greenfield projects

---

#### **entity["organization","ESLint","javascript linter"]**
**Pros**
- Massive plugin ecosystem
- Deep Next.js + React coverage
- Battle-tested

**Cons**
- Slower
- Config-heavy
- Often paired with Prettier (extra complexity)

**Best for**
- Legacy projects  
- Heavy custom rules
- Teams dependent on specific plugins

---

### Practical Recommendation
- **New Next.js app:** Biome only  
- **Existing Next.js app:** Keep ESLint unless you’re ready to migrate rules  
- **Hybrid:** Biome for formatting + ESLint for edge-case linting (acceptable but not ideal)

---

### Minimal Biome Setup (Next.js)
```bash
npm install --save-dev @biomejs/biome
npx biome init
```

Then add:
```json
{
  "lint": {
    "rules": {
      "recommended": true
    }
  }
}
```

Run:
```bash
npx biome check .
```

---

**Bottom line:**  
If you value speed, simplicity, and modern defaults → **Biome wins**.  
If you need maximum rule coverage → **ESLint still has a place**.

If you want, I can give you a **migration checklist from ESLint → Biome** or a **side-by-side config tuned for Next.js App Router**.


**Topic:** [[chatgpt-clusters/coding_web_dev]]
