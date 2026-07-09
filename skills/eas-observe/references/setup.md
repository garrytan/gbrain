# Set up EAS Observe in an existing project

EAS Observe collects app-startup performance metrics (cold launch, warm launch, bundle load, TTR, TTI) from production Expo apps. This reference summarizes the steps to add `expo-observe` to an existing project.

> Source: https://docs.expo.dev/eas/observe/get-started/ — consult this page for the latest guidance.

## SDK 55 vs SDK 56+ at a glance

The library exports differ between SDK versions. Pick the right one for the project's SDK before copying any snippet below.

| Concern | SDK 55 | SDK 56 and later |
|---|---|---|
| Root layout HOC | `AppMetricsRoot.wrap(...)` | `ObserveRoot.wrap(...)` |
| `markInteractive()` API | Global: `AppMetrics.markInteractive()` | Hook: `const { markInteractive } = useObserve()` |
| Import source | `expo-observe` | `expo-observe` (same package) |

Everything else — package name, build process, dashboard, debug-mode behavior — is the same across versions.

## Prerequisites

Before installing, confirm all of the following:

1. **An Expo account.** Sign up at [expo.dev/signup](https://expo.dev/signup) if needed.
2. **Expo SDK 55 or later.** Run `npx expo-doctor` to check, and `npx expo install --fix` to update dependencies. SDK 56+ unlocks the newer `ObserveRoot` / `useObserve` API.
3. **An EAS project.** The app must have `extra.eas.projectId` set in its app config. If not, run `eas init` to create one.

## Step 1 — Install the library

From the project root:

```sh
npx expo install --fix
npx expo install expo-observe
```

## Step 2 — Wrap the root layout

The HOC automatically measures **Time to First Render (TTR)**. Apply it to the file that exports the app's root component. The HOC name depends on the SDK version.

**SDK 55** — use `AppMetricsRoot`:

```tsx
// app/_layout.tsx
import { Stack } from 'expo-router';
import { AppMetricsRoot } from 'expo-observe';

function RootLayout() {
  return <Stack />;
}

export default AppMetricsRoot.wrap(RootLayout);
```

**SDK 56 and later** — use `ObserveRoot`:

```tsx
// app/_layout.tsx
import { Stack } from 'expo-router';
import { ObserveRoot } from 'expo-observe';

function RootLayout() {
  return <Stack />;
}

export default ObserveRoot.wrap(RootLayout);
```

**Without Expo Router** (`App.tsx`): wrap the default-exported `App` component the same way — `export default AppMetricsRoot.wrap(App);` on SDK 55, or `export default ObserveRoot.wrap(App);` on SDK 56+.

## Step 3 — Mark the app as interactive

TTI is **not** collected automatically. Signal it once the screen is genuinely ready for the user — i.e. after splash-screen-blocking work like update checks, authentication, initial data fetching, or splash animations finishes. Place the call in a `useEffect` that runs once that work resolves.

**SDK 55** — call the global `AppMetrics.markInteractive()`:

```tsx
// app/_layout.tsx
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { AppMetrics, AppMetricsRoot } from 'expo-observe';
import { useEffect, useState } from 'react';

SplashScreen.preventAutoHideAsync();

function RootLayout() {
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    async function prepare() {
      try {
        await authenticateUser();
        await fetchInitialData();
      } catch (e) {
        console.warn(e);
      } finally {
        setIsReady(true);
      }
    }
    prepare();
  }, []);

  useEffect(() => {
    if (isReady) {
      SplashScreen.hide();
      AppMetrics.markInteractive();
    }
  }, [isReady]);

  if (!isReady) return null;
  return <Stack />;
}

export default AppMetricsRoot.wrap(RootLayout);
```

**SDK 56 and later** — use the `useObserve()` hook to get a bound `markInteractive`:

```tsx
// app/_layout.tsx
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { ObserveRoot, useObserve } from 'expo-observe';
import { useEffect, useState } from 'react';

SplashScreen.preventAutoHideAsync();

function RootLayout() {
  const [isReady, setIsReady] = useState(false);
  const { markInteractive } = useObserve();

  useEffect(() => {
    async function prepare() {
      try {
        await authenticateUser();
        await fetchInitialData();
      } catch (e) {
        console.warn(e);
      } finally {
        setIsReady(true);
      }
    }
    prepare();
  }, []);

  useEffect(() => {
    if (isReady) {
      SplashScreen.hide();
      markInteractive();
    }
  }, [isReady, markInteractive]);

  if (!isReady) return null;
  return <Stack />;
}

export default ObserveRoot.wrap(RootLayout);
```

**Without Expo Router:** the structure is the same in `App.tsx`. Use `SplashScreen.hideAsync()` instead of `SplashScreen.hide()` and replace `<Stack />` with the app's root tree.

### Multiple entry screens

`markInteractive()` is safe to call repeatedly — only the **first** call per session is recorded. If the app has more than one entry screen (onboarding, login, deep-link targets), call `markInteractive()` on **each one**. Otherwise TTI will be missing for sessions that open via a deep link to a screen without the call.

## Step 4 — Build the app

Metrics are collected from real builds, not from `expo start`:

```sh
eas build
```

> By default, metrics collected from **debug builds** are not dispatched. A build is treated as a debug build when either the native app is a debug build or the JS bundle is a development bundle (`__DEV__` is `true`). To dispatch anyway while testing the integration, set `dispatchInDebug: true` when calling `configure()` — see [Enable metrics in development](https://docs.expo.dev/eas/observe/configuration/#enable-metrics-in-development). This has no effect on release builds.

## Step 5 — View the metrics

Open the **Observe** tab in the EAS dashboard at `https://expo.dev/accounts/[account]/projects/[project]/observe` to view metrics from the app.

To query metrics from the terminal with the EAS CLI, see [`./queries.md`](./queries.md). For interpreting the metrics themselves, see [`./metrics.md`](./metrics.md).

## Optional — per-route navigation metrics (SDK 56+)

By default `expo-observe` records app-wide startup metrics only. To additionally get **per-route / per-screen** navigation metrics (`cold_ttr`, `warm_ttr`, and a per-navigation `tti`, each tagged with the route/screen), enable one of the navigation integrations. These require **SDK 56 or later**; on earlier SDKs they are silent no-ops. Query the resulting data with `eas observe:routes` (see [`./queries.md`](./queries.md)).

Pick the integration that matches the app's router:

### Expo Router

Docs: https://docs.expo.dev/eas/observe/integrations/expo-router/

1. Enable the integration at module scope, **before any screen mounts** (it cannot be toggled at runtime — calling `configure()` after mount throws):

   ```tsx
   // app/_layout.tsx
   import { Observe } from 'expo-observe';

   Observe.configure({
     integrations: { 'expo-router': true },
   });
   ```

2. Call `useObserve()` inside each screen to get a `markInteractive` scoped to the current route, and call it from a `useEffect` once the screen is interactive:

   ```tsx
   import { useObserve } from 'expo-observe';
   import { useEffect } from 'react';

   export default function Home() {
     const { markInteractive } = useObserve();
     useEffect(() => {
       markInteractive();
     }, [markInteractive]);
     return (/* screen content */);
   }
   ```

Events are tagged with the route **pattern** (e.g. `/(tabs)/sessions/[sessionId]`) so the dashboard buckets distinct param values together; the resolved `url` and `routeParams` are also included. Requires `expo-router` installed at runtime, or the integration no-ops.

### React Navigation

Docs: https://docs.expo.dev/eas/observe/integrations/react-navigation/

Requires `@react-navigation/native` 7.0.0 or later. Same `useObserve()` screen usage as above, plus **two** extra changes:

1. Enable the integration at module scope, before mount:

   ```tsx
   // App.tsx
   import { Observe } from 'expo-observe';

   Observe.configure({
     integrations: { 'react-navigation': true },
   });
   ```

2. Replace the top-level `<NavigationContainer>` with `<ObserveNavigationContainer>` — a drop-in replacement that accepts the same props and forwards the same ref. If you pass a `linking` config it is used to resolve a human-readable screen path; otherwise the metric falls back to `route.name`.

   ```tsx
   import { ObserveNavigationContainer } from 'expo-observe/integrations/react-navigation';

   export default function App() {
     return <ObserveNavigationContainer>{/* navigators */}</ObserveNavigationContainer>;
   }
   ```

In both integrations, `useObserve()` is safe to leave in place even when the integration is disabled or the router package is absent — it falls back to the global `markInteractive`.

## Optional — user-defined events (SDK 56+)

Beyond the automatic startup and navigation metrics, you can record your own named events from anywhere in the app to track product moments — a completed onboarding, an exported report, a selected item. Use `Observe.logEvent(name, options?)`.

> Source: https://docs.expo.dev/eas/observe/events/ — consult this page for the latest guidance.

```tsx
import { Observe } from 'expo-observe';

function handleOnboardingComplete() {
  Observe.logEvent('onboarding.completed');
}
```

`logEvent` is a plain function call — it is **not** a hook and needs no `useObserve()`. Call it from event handlers, effects, or any non-render code. The event is persisted on-device and dispatched on the next flush (see dispatch notes below); the call returns immediately and never blocks the UI.

### Parameters

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `name` | `string` | yes | Stable, dot-separated identifier, e.g. `'report.exported'`. |
| `options.attributes` | `Record<string, string \| number \| boolean \| array \| nested object>` | no | Structured context attached to the event. |
| `options.body` | `string` | no | Free-form message complementing the structured attributes. |
| `options.severity` | `'trace' \| 'debug' \| 'info' \| 'warn' \| 'error' \| 'fatal'` | no | Defaults to `'info'`. |

**Attributes** are the primary way to make an event queryable — attach the identifiers and measurements you'll want to filter or break down by:

```tsx
Observe.logEvent('report.exported', {
  attributes: {
    format: 'csv',
    rowCount: 1248,
    durationMs: 532,
    filters: ['status:active', 'region:us-west'],
  },
});
```

**Severity and body** may be used for operational events you may want to triage by level:

```tsx
Observe.logEvent('cache.evicted', {
  body: 'Cache evicted because disk pressure exceeded the configured threshold.',
  severity: 'warn',
  attributes: { evictedItemCount: 42, freedBytes: 1048576 },
});
```

### Naming and privacy

- **Use lowercase, dot-separated names** (`task.completed`, `onboarding.skipped`). Keep them stable — `report_exported` and `report.exported` bucket as two separate events in the dashboard.
- **Never put PII in event names, attribute keys, or attribute values.** Everything is transmitted off-device and visible in the dashboard.

### Dispatch

User-defined events are persisted on-device, batched, and dispatched on the next flush as **OpenTelemetry log records** — the same delivery path and timing as other metrics. The debug-build caveat from [Step 4](#step-4--build-the-app) applies unchanged: debug builds don't dispatch unless `configure({ dispatchInDebug: true })` is set.

### Viewing events

User-defined events appear under the **Events** tab in the Observe dashboard, and are queryable from the terminal with `eas observe:events` — see [`./queries.md`](./queries.md).

## Quick checklist

- [ ] SDK ≥ 55, EAS project linked.
- [ ] `expo-observe` installed via `npx expo install`.
- [ ] Root component exported through `AppMetricsRoot.wrap(...)` (SDK 55) or `ObserveRoot.wrap(...)` (SDK 56+).
- [ ] `markInteractive()` called from every entry screen once it is genuinely interactive — global `AppMetrics.markInteractive()` on SDK 55, or `useObserve()` hook on SDK 56+.
- [ ] (Optional, SDK 56+) Per-route metrics enabled via `Observe.configure({ integrations: { ... } })`, plus `<ObserveNavigationContainer>` for React Navigation.
- [ ] (Optional, SDK 56+) User-defined events emitted via `Observe.logEvent(name, { attributes })` with stable, lowercase, dot-separated names and no PII.
- [ ] New build produced with `eas build` and metrics visible in the Observe dashboard.
