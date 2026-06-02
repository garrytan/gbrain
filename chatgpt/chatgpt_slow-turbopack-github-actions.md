---
title: "Slow Turbopack GitHub Actions"
type: guide
created: 2026-03-03
updated: 2026-03-03
source: chatgpt-export
conversation_id: 69a732d5-0aa0-832a-bb64-8e3d53d3c35b
message_count: 4
tags: [chatgpt, import, code]
---
# Slow Turbopack GitHub Actions

> Conversation ID: 69a732d5-0aa0-832a-bb64-8e3d53d3c35b
> Created: 2026-03-03T19:13:32Z
> Updated: 2026-03-03T19:15:22Z
> Messages: 4

---

## User

slow turbo pack compilation in github actions

---

## Assistant

Slow **Turbopack** compilation in **GitHub Actions** is usually caused by cold caches, limited CI resources, or misconfigured incremental builds. The fixes are mostly deterministic.

---

## 1. Enable Proper Caching (Critical)

Cache both Next.js and package manager artifacts.

### For Next.js / Turbopack cache
```yaml
- name: Cache Next.js build cache
  uses: actions/cache@v4
  with:
    path: |
      .next/cache
    key: ${{ runner.os }}-nextjs-${{ hashFiles('**/package-lock.json') }}
    restore-keys: |
      ${{ runner.os }}-nextjs-
```

### For Node modules (if not using pnpm store cache)
```yaml
- name: Cache node_modules
  uses: actions/cache@v4
  with:
    path: node_modules
    key: ${{ runner.os }}-modules-${{ hashFiles('**/package-lock.json') }}
    restore-keys: |
      ${{ runner.os }}-modules-
```

If using pnpm:
```yaml
- uses: pnpm/action-setup@v4
  with:
    version: 8

- name: Get pnpm store directory
  run: echo "STORE_PATH=$(pnpm store path --silent)" >> $GITHUB_ENV

- uses: actions/cache@v4
  with:
    path: ${{ env.STORE_PATH }}
    key: ${{ runner.os }}-pnpm-${{ hashFiles('**/pnpm-lock.yaml') }}
```

Without caching `.next/cache`, Turbopack recompiles everything every run.

---

## 2. Ensure You’re Actually Using Turbopack

In CI:

```bash
next build --turbo
```

Or in `package.json`:
```json
"build": "next build --turbo"
```

Confirm you're on a recent version of entity["organization","Vercel","cloud platform"]'s entity["software","Next.js","react framework"] (13.5+ or 14+ recommended).

---

## 3. Increase CI Resources

GitHub default runners are 2-core VMs.

Heavy monorepos compile much slower there.

Options:

- Use larger runners (paid)
- Reduce parallel jobs
- Disable unnecessary type-check/lint in build:
  ```bash
  NEXT_DISABLE_ESLINT=1 NEXT_DISABLE_TYPECHECK=1 next build --turbo
  ```

Or in `next.config.js`:
```js
eslint: { ignoreDuringBuilds: true },
typescript: { ignoreBuildErrors: true },
```

---

## 4. If in a Monorepo (TurboRepo)

If using entity["software","Turborepo","build system"]:

Enable remote caching:

```bash
npx turbo login
npx turbo link
```

Then in CI:
```yaml
- run: npx turbo run build --cache-dir=.turbo
```

Cache:
```yaml
- uses: actions/cache@v4
  with:
    path: .turbo
    key: ${{ runner.os }}-turbo-${{ hashFiles('**/pnpm-lock.yaml') }}
```

Remote caching provides the largest speedup.

---

## 5. Disable Source Maps in CI

Source maps dramatically slow builds.

```js
productionBrowserSourceMaps: false
```

---

## 6. Reduce Transpilation Scope

If using `transpilePackages`, ensure you're not transpiling large deps unnecessarily.

Avoid:

```js
transpilePackages: ['*']
```

---

## 7. Measure Where Time Is Spent

Add timing:

```yaml
- name: Build
  run: time npm run build
```

If most time is:
- **Installing deps** → fix caching
- **Compiling JS** → fix Turbopack cache
- **Type-checking** → disable in CI
- **Image optimization** → disable during build

---

## 8. Known CI-Specific Bottleneck

Turbopack benefits heavily from filesystem speed.  
GitHub runners have slower I/O than local machines.

You can mitigate by:

- Avoiding unnecessary file writes
- Reducing large static directories
- Excluding test files from production build

---

## Expected CI Performance (Baseline)

Small app: 20–40s  
Medium monorepo: 1–3m  
Large monorepo without caching: 4–8m  

If you’re seeing >5m with caching enabled, the issue is almost always:

- Cache miss
- Wrong cache key
- Lockfile changing every run
- No `.next/cache` persistence

---

If you share:
- Build time
- Monorepo or single app
- Package manager
- Current GitHub Actions YAML

I can pinpoint the bottleneck.

---

## User

give me this list as a bullet oint check list to work through

---

## Assistant

### Turbopack Slow Build — CI Optimization Checklist

- [ ] Confirm `next build --turbo` is used in CI  
- [ ] Verify project is on a recent version of entity["software","Next.js","react framework"]  
- [ ] Cache `.next/cache` in GitHub Actions  
- [ ] Cache `node_modules` or pnpm store  
- [ ] Ensure lockfile is stable (not changing every run)  
- [ ] Confirm cache keys are restoring properly (check Actions logs)  
- [ ] Disable ESLint during CI build (`NEXT_DISABLE_ESLINT=1`)  
- [ ] Disable TypeScript type checking during CI (`NEXT_DISABLE_TYPECHECK=1`)  
- [ ] Disable production source maps (`productionBrowserSourceMaps: false`)  
- [ ] Review `transpilePackages` and remove unnecessary entries  
- [ ] If using entity["software","Turborepo","build system"], enable remote caching  
- [ ] Cache `.turbo` directory if using Turborepo  
- [ ] Measure build time with `time npm run build`  
- [ ] Identify whether slowdown is dependency install vs compile vs type-check  
- [ ] Reduce large static assets included in build  
- [ ] Exclude tests and unnecessary files from production build  
- [ ] Consider larger GitHub runners if builds exceed 3–5 minutes  

Work through top to bottom. Caching and type-check disabling usually provide the largest immediate gains.
