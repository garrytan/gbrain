---
title: "Storybook server slow"
type: note
created: 2026-02-02
updated: 2026-02-02
source: chatgpt-export
conversation_id: 69810924-e800-832d-bf62-e8060062636f
message_count: 2
tags: [chatgpt, import]
---
# Storybook server slow

> Conversation ID: 69810924-e800-832d-bf62-e8060062636f
> Created: 2026-02-02T20:29:25Z
> Updated: 2026-02-02T20:30:05Z
> Messages: 2

---

## User

storybooks erver slow

---

## Assistant

Storybook’s development server *is often slow* (especially on large projects) because of how it bundles and rebuilds your stories — it’s essentially rebuilding a webpack/Vite project every time you start or change code. The main causes and practical ways to fix it are well-documented by the community and the Storybook team: citeturn0search1turn0search2turn0search15

### 📉 Why Storybook feels slow

**1. Bundler overhead**  
Storybook uses a bundler (Webpack by default) to compile all your stories and dependencies. That initial *cold start* can be tens of seconds — and each save triggers a rebuild. citeturn0search2

**2. Large story sets or assets**  
If your `stories` glob pattern loads hundreds of files, Storybook compiles them all, which increases load times. Filtering or narrowing this can help. citeturn0search7

**3. Addons & documentation generation**  
Addons like `addon-docs`, TS docgen, and others add static analysis work and slow builds. citeturn0search1

**4. Heavy dependencies**  
Importing large libs (e.g., FontAwesome with thousands of files) can make webpack crawl a huge tree, drastically slowing builds. citeturn0search4

**5. Vite builder nuances**  
Using the Vite builder can still be slow for the *initial page load* due to many HTTP requests for unbundled modules — but HMR is faster overall. citeturn0search2

### 🚀 How to speed it up

Here are effective fixes you can apply in your project:

**✔ Use a faster bundler / compiler**  
- Swap Webpack for Vite (`@storybook/builder-vite`) for much faster hot reloads. citeturn0search2  
- Use SWC instead of Babel/TS for ~2x faster compile times. citeturn0search15

**✔ Reduce what it bundles**  
- Narrow your `stories` glob so Storybook only loads what you need. citeturn0search7  
- Exclude heavy dependencies from stories or mock them where possible. citeturn0search4

**✔ Trim addons & docgen**  
- Disable `addon-docs` and other non-essentials in dev. citeturn0search1  
- Turn off TS docgen or set it to a simpler parser in `.storybook/main.js`. citeturn0search1

**✔ Enable build optimizations**  
- Turn on Webpack lazy compilation and filesystem caching. citeturn0search15

**✔ Run only specific stories in dev**  
- Add scripts to load a single component’s stories instead of all. citeturn0search7

### 🧠 Bonus

Latest Storybook versions (9+) focus on trimming internal bloat and improving performance, so upgrading may help even without config changes. citeturn0search3

---

If you want concrete config tweaks (e.g., a tailored `.storybook/main.js` example) for your framework, tell me which bundler (Webpack vs Vite) your project uses.


**Topic:** [[chatgpt-clusters/coding_devops]]


## See Also
- [[chatgpt/chatgpt_slow-turbopack-dev-server]]
- [[chatgpt/chatgpt_accessing-localhost-server]]
- [[chatgpt/chatgpt_bartender-server-cover-letter]]
- [[chatgpt/chatgpt_clerk-mcp-server]]
- [[chatgpt/chatgpt_dev-server-testing-optimization]]
