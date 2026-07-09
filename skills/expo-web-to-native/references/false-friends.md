# False Friends: web idioms → native

Disclosed reference for [`expo-web-to-native`](../SKILL.md). A *false friend* is a web idiom that looks portable but isn't - it compiles in your head, then breaks (or silently no-ops) on native. Each row is `web idiom → native equivalent → the gotcha`. Reach for this in steps 3–5 of a migration, and whenever you're learning native after the web.

This is the single source of truth for the mapping; the SKILL.md steps name a few high-traffic swaps but defer the full list here.

## Elements & text

| Web | Native | Gotcha |
|---|---|---|
| `<div>`, `<section>`, `<span>` | `<View>` | `View` is the only generic container; no semantic element variants. |
| `<p>`, `<h1>`, raw text in JSX | `<Text>` | **All** text must sit inside `<Text>`. Bare strings in a `View` throw. |
| `<img src>` | `<Image>` / `expo-image` | `expo-image` adds caching, blurhash, transitions. Remote images need an explicit `width`/`height` or a flex parent. |
| `<button>`, `<a>` | `<Pressable>` (or `TouchableOpacity`) | No default styling, no hover. Wrap label text in `<Text>`. |
| `<input>` | `<TextInput>` | Controlled via `value` + `onChangeText` (not `onChange`/`e.target.value`). |
| `<ul>/<li>` rendered with `.map()` | `<FlatList>` / `<FlashList>` | `.map()` over a long list mounts every row at once → jank. Use a virtualized list with `data` + `renderItem`. |

## Events & interaction

| Web | Native | Gotcha |
|---|---|---|
| `onClick` | `onPress` | Also `onLongPress`, `onPressIn/Out`. There is no click. |
| `onChange={e => e.target.value}` | `onChangeText={text => ...}` | The handler receives the string directly, not an event. |
| `onSubmit` (form) | `onPress` / `onSubmitEditing` | No `<form>` element and no submit event; wire the button/keyboard return key. |
| `:hover`, `:focus` | press/focus state | No hover on touch. Track state and style from it, or use `Pressable`'s state callback. |
| `e.preventDefault()` | — | No default actions to prevent; remove it. |

## Styling & layout

| Web | Native | Gotcha |
|---|---|---|
| `className` / CSS files | `StyleSheet.create` or NativeWind | Plain RN has no className. For Tailwind muscle memory use NativeWind (`expo-tailwind-setup`). |
| CSS cascade & inheritance | none | Styles don't inherit (except a few `Text` props like `color`/`fontSize` to nested `Text`). Style each node. |
| `display: flex` opt-in, default `row` | flex always on, default **`column`** | Biggest layout surprise: flex is the only layout model and the main axis is vertical by default. |
| `px`, `rem`, `%` | unitless numbers (dp) | `padding: 16` = density-independent pixels. `%` works in some props; no `rem`/`em`/`vh`. |
| `@media` queries | `useWindowDimensions()` / `Platform` | No media queries. Branch on dimensions or platform at runtime. |
| `position: fixed` | `position: absolute` + safe area | No `fixed`. Pin with `absolute` and respect insets (`react-native-safe-area-context`). |
| `z-index` | `zIndex` (+ `elevation` on Android) | Works mostly, but Android shadow/stacking also needs `elevation`. |
| CSS transitions / `@keyframes` | `Animated` / Reanimated | No CSS animation. Reanimated is the standard; gestures via `react-native-gesture-handler`. |
| `gap`, flexbox | `gap`, flexbox | These largely transfer — flexbox is the one big win for web devs. |

## Navigation & URLs

| Web | Native | Gotcha |
|---|---|---|
| React Router / Next.js routes | Expo Router (file-based) | File-based like Next App Router; `react-router` concepts map but the API differs. |
| `<a href>` / `<Link>` | `expo-router` `<Link href>` | Works in DOM components too. |
| `useNavigate()` / `router.push` | `useRouter()` from `expo-router` | `router.push/replace/back`. |
| `useParams` / `useSearchParams` | `useLocalSearchParams()` | Note: doesn't work *inside* a DOM component - read in the native parent, pass as props (see `expo-dom`). |
| `window.location` | `usePathname()` / router | No `location` object. |
| Deep links / `myapp://` | URL scheme + universal links | Configure `scheme` in app config; native gives you real deep linking and (with AASA) app links - see `expo-app-clip` for the AASA file. |

## React architecture & data (Next.js / SSR apps)

| Web | Native | Gotcha |
|---|---|---|
| Async Server Component (`async function Page()`) | client component + data fetch | No RSC on native (Expo's is experimental and different). Split into a client component that fetches via the API + a presentational child *before* porting. |
| Server actions (`'use server'`) | API route + `fetch` | No server actions. Expose an endpoint and call it. |
| `cookies()` / `headers()` (server) | token in `expo-secure-store` | Server-only. Auth moves to a bearer token sent as a header. |
| ORM / DB client in a page (Drizzle, Prisma) | server only - call over HTTP | The device never talks to the DB. Keep the backend deployed, or move routes to EAS Hosting (`eas-hosting`); the app fetches. |
| `next/navigation` (`notFound`, `redirect`) | `expo-router` | `redirect()` → `router.replace`; `notFound()` → a native `+not-found` route. |
| `_layout` as a DOM component | always native | Layout routes can't be DOM components — they *are* the native shell. Rewrite web-only layout logic (theme scripts, providers) with native APIs. |

## Storage, state & sessions

| Web | Native | Gotcha |
|---|---|---|
| `localStorage` / `sessionStorage` | `expo-sqlite` (`globalThis.localStorage`) | `import 'expo-sqlite/localStorage/install';` polyfills the global `localStorage`, so existing code works as-is (or `expo-sqlite/kv-store`). **No `sessionStorage` equivalent** — native has no session concept. |
| Cookies / `document.cookie` | `expo-secure-store` + headers | No cookie jar by default. Store tokens in SecureStore; send as auth headers. |
| Auth via session cookie | token in SecureStore | Redesign auth around bearer tokens, not browser sessions. |
| In-memory React state | same | `useState`/`useReducer`/`useContext` transfer unchanged. |

## Browser & platform APIs

| Web | Native | Gotcha |
|---|---|---|
| `window`, `document` | none | Don't exist. Guard web-only libs, or keep them in a DOM component (`expo-dom`). |
| `window.matchMedia('(prefers-color-scheme: dark)')` | `useColorScheme()` | Hook from `react-native`, reactive to the system theme. Web theme bootstrap scripts in the layout don't run. |
| `window.innerWidth/Height` | `useWindowDimensions()` | Reactive hook; updates on rotation. |
| `navigator.*`, Web APIs | Expo SDK modules | e.g. camera → `expo-camera`, geolocation → `expo-location`, clipboard → `expo-clipboard`. |
| `alert()` / `confirm()` / `prompt()` | `alert()` works; `Alert.alert(...)` for the rest | RN provides a global `alert()`; `confirm()` / `prompt()` don't exist — use `Alert.alert` with a button array. |
| `process.env.X` | `process.env.EXPO_PUBLIC_X` | Only `EXPO_PUBLIC_`-prefixed vars are inlined into the client bundle. |
| `console.log` | `console.log` | Works — shows in the dev tools/terminal. |
| `dangerouslySetInnerHTML` | — | No DOM to inject into. Render data, or use a DOM component / WebView. |
| inline SVG | `react-native-svg` | No native `<svg>`; the library mirrors the element API. |

## Networking

| Web | Native | Gotcha |
|---|---|---|
| `fetch('/api/x')` (relative) | absolute URL | Native has no origin — relative paths fail. Use a configured base URL (`EXPO_PUBLIC_API_URL`). |
| CORS | n/a | No browser CORS, but you still need a reachable absolute host. |
| `fetch`, React Query, SWR | same | The libraries themselves work on native - see `expo-data-fetching`. |
| Next.js API routes | Expo Router API routes | Move server endpoints to Expo API routes on EAS Hosting - see `eas-hosting`. |
| Streaming responses (SSE, AI SDK `useChat`) | `expo/fetch` with `textStreaming` | RN's built-in `fetch` can't read a streaming response body. Use `expo/fetch` (streams, and works with the Vercel AI SDK) or an XHR-based polyfill. |

## Third-party services & SDKs

Browser SDKs don't run on native — each needs a native equivalent. The canonical, version-matched integrations live in the `expo-examples` skill (the `expo/examples` repo); reach for those instead of wiring from scratch.

| Web service | Native | Gotcha |
|---|---|---|
| **Stripe.js — digital goods / subscriptions** | store **In-App Purchase** via **RevenueCat** (`react-native-purchases`) | **Policy, not just an SDK swap.** Apple & Google *require* IAP for in-app digital goods and take ~15–30%; shipping Stripe for them gets the app rejected. Decide at assess time — it can change the business model. |
| **Stripe.js — physical goods / services** | `@stripe/stripe-react-native` (PaymentSheet, Apple/Google Pay) | Stripe's RN SDK is allowed for physical goods; see `expo-examples` `with-stripe`. |
| Google Maps JS | `react-native-maps` | A native map view, not an embedded iframe. |
| Web Push | `expo-notifications` (APNs / FCM) | Different delivery + permission model. |
| OAuth redirect flow | `expo-auth-session` (deep-link OAuth), or a native auth SDK (Clerk, Supabase…) | No browser redirect — an app deep link completes the flow. |
| GA / Segment.js analytics | native SDK (`posthog-react-native`, Segment RN) | The web JS snippet won't load; swap for the native SDK. |
| `<input type=file>` / `getUserMedia` | `expo-image-picker` / `expo-camera` / `expo-document-picker` | Native pickers + runtime permissions. |

## Scrolling, keyboard & safe area

| Web | Native | Gotcha |
|---|---|---|
| Body scrolls by default | `<ScrollView>` / `<FlatList>` | Nothing scrolls unless you make it. Wrap overflowing content explicitly. |
| `overflow: scroll` | `<ScrollView>` | Don't nest a `ScrollView` inside a `FlatList` of the same axis. |
| Keyboard overlaps inputs | `KeyboardAvoidingView` | The keyboard covers inputs by default; wrap forms to push content up. |
| Notch / status bar | `react-native-safe-area-context` | Content flows under the notch/home indicator unless you apply safe-area insets. |
| `:focus` ring, tab order | manual | No automatic focus management; wire `ref`/`focus()` and `returnKeyType`. |
