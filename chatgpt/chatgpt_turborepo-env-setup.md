---
title: "Turborepo env setup"
type: note
created: 2025-12-24
updated: 2025-12-24
source: chatgpt-export
conversation_id: 694b44b1-8524-8331-a26f-5ce5a31e6495
message_count: 2
tags: [chatgpt, import, code]
---
# Turborepo env setup

> Conversation ID: 694b44b1-8524-8331-a26f-5ce5a31e6495
> Created: 2025-12-24T01:41:06Z
> Updated: 2025-12-24T01:41:52Z
> Messages: 2

---

## User

turbo repo env

---

## Assistant

Here’s a **practical summary of how environment variables work in a Turborepo** and how to set them up:

---

## 📌 1. **Turborepo Doesn’t Auto-Load .env Files**

- Turborepo itself **does not automatically load `.env` files** into tasks’ runtimes — your framework or a tool like `dotenv` must do it.  
- Environment files (like `.env`, `.env.local`) are handled by the app framework (Next.js, Vite, etc.) or by a loader like `dotenv-cli`. citeturn0search0

---

## 📌 2. **Inform Turborepo About Env Vars for Caching**

Turborepo needs to know which environment variables affect build outputs so it can **correctly hash and cache tasks**.

**In `turbo.json`:**

```jsonc
{
  "globalEnv": ["IMPORTANT_GLOBAL_VARIABLE"],
  "tasks": {
    "build": {
      "env": ["MY_API_URL", "MY_API_KEY"],
      "passThroughEnv": ["AWS_SECRET_KEY"]
    }
  }
}
```

- `globalEnv`: Vars that affect *all* tasks (changes bust *global* cache).  
- `tasks.<name>.env`: Vars that affect just that task’s hashing.  
- `passThroughEnv`: Make vars available at runtime **without affecting hashing**.  
- You can use wildcards (e.g., `"MY_API_*"`) to match many vars at once. citeturn0search0turn0search9

Strict mode (default) will filter environment variables so only ones specified above are available to tasks. You can run with `--env-mode=loose` to disable filtering. citeturn0search0

---

## 📌 3. **Root `.env` File Use**

Even though Turborepo doesn’t load `.env` itself:

- You *can* create a `.env` file in your repo root to centralize variables.
- Use a tool like **dotenv-cli** to load them when running tasks.

Example:

```bash
npm install -D dotenv-cli
```

In `package.json`:

```json
{
  "scripts": {
    "dev": "dotenv -- turbo run dev"
  }
}
```

Then your tasks will have access to the root `.env` variables. citeturn0search5

**Best practice:**  
Prefer `.env` files scoped inside each package/app (e.g., `apps/web/.env`) so each app handles its own environment at runtime. citeturn0search0

---

## 📌 4. **Framework-Specific Notes**

If you’re using a framework (Next.js, Vite, etc.):

- Turborepo infers common prefixes (like `NEXT_PUBLIC_*`, `VITE_*`) so you *don’t need to list them* in `env` for caching. citeturn0search0
- For front-end exposure, prefix accordingly (e.g., `NEXT_PUBLIC_` for Next.js or `VITE_` for Vite). citeturn0search17

---

## 📌 5. **System Environment Variables for Turborepo Internals**

Turborepo itself respects some system-level vars for its own behavior (not app config), e.g.:

| Variable | Purpose |
|----------|---------|
| `TURBO_CACHE_DIR` | Custom cache directory |
| `TURBO_FORCE` | Run tasks without caching |
| `FORCE_COLOR` | Force colored output |

These change how Turborepo runs, not how your app reads env vars. citeturn0search4

---

## 🔑 Summary

- **Your code accesses env vars through normal process.env or framework loader.**
- **Turbo needs env vars listed in `turbo.json` to correctly hash/cache tasks.**  
- **Use tools like `dotenv-cli` to load `.env` at runtime if needed.**  
- **Keep `.env` files scoped per package where possible.** citeturn0search0turn0search5

---

If you want, I can give you a **concrete example `turbo.json`** and `.env` setup for a specific stack (Next.js, Vite, etc.).


## See Also
- [[chatgpt/chatgpt_electron-app-turborepo-setup]]
- [[chatgpt/chatgpt_explain-turborepo]]
- [[chatgpt/chatgpt_test-turborepo-locally]]
- [[chatgpt/chatgpt_turborepo-changelog]]
- [[chatgpt/chatgpt_turborepo-in-github-actions]]
