---
title: "AI prompt for dark mode"
type: guide
created: 2025-09-03
updated: 2025-09-03
source: chatgpt-export
conversation_id: 68b89a25-15b8-8331-a926-722556e7676e
message_count: 4
tags: [chatgpt, import, code]
---
# AI prompt for dark mode

> Conversation ID: 68b89a25-15b8-8331-a926-722556e7676e
> Created: 2025-09-03T19:42:44Z
> Updated: 2025-09-03T19:44:17Z
> Messages: 4

---

## User

Give me a clean and concise AI prompt for copilot to add dark mode to all the clerk UI components.

---

## Assistant

Here’s a clean and concise Copilot-ready prompt you can drop right into your editor:  

```plaintext
Update all Clerk UI components to fully support dark mode.  
- Detect system preference (`prefers-color-scheme`) and toggle styles accordingly.  
- Ensure consistent use of Tailwind `dark:` variants.  
- Apply dark-mode safe colors for text, backgrounds, borders, and hover states.  
- Keep visual hierarchy, contrast, and accessibility intact.  
- Refactor inline styles or hardcoded colors to theme tokens where possible.  
```

Do you want me to also give you a **ready-to-paste code snippet** for setting up Clerk with Tailwind’s `dark:` classes so Copilot has a reference implementation?

---

## User

Ensure it works with next theme and our current implementation and dark mode toggles

---

## Assistant

Mr. White — drop this into Copilot:

```plaintext
Goal: Make all Clerk UI components fully support dark mode using next-themes and our existing dark-mode toggles.

Requirements
- Use next-themes for theme state. Respect user toggle and system preference.
- Tailwind dark mode via `darkMode: "class"`.
- Pass the active theme into all Clerk components via `appearance` so styles swap instantly.
- No visual regressions; maintain AA contrast.

Edits
1) tailwind.config.{js,ts}
- Ensure: `darkMode: "class"`.

2) app/layout.(tsx|jsx)
- Wrap with next-themes <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
- Ensure `<html>` gets the theme class.

3) components/theme-toggle.(tsx|jsx)
- Use `useTheme()` from next-themes.
- Implement a button/menu to `setTheme("light" | "dark" | "system")`.
- Persist choice (next-themes does this automatically).

4) styles/globals.css
- Define CSS vars for bg/text/border at :root and `.dark` (e.g., `--bg`, `--fg`, `--muted`, `--border`) and map them to Tailwind via `@layer base`.
- Ensure focus/hover states have dark-safe colors.

5) Clerk components (SignIn, SignUp, UserButton, UserProfile, OrganizationSwitcher, etc.)
- Import themes from `@clerk/themes`: `import { dark, light } from "@clerk/themes"`.
- For each component usage, pass:
  ```tsx
  const { resolvedTheme } = useTheme();
  const baseTheme = resolvedTheme === "dark" ? dark : light;

  <SignIn
    appearance={{
      baseTheme,
      variables: {
        colorBackground: "hsl(var(--bg))",
        colorText: "hsl(var(--fg))",
        colorPrimary: "hsl(var(--primary))",
        colorInputBackground: "hsl(var(--muted))",
        colorInputText: "hsl(var(--fg))",
        colorShimmer: "hsl(var(--border))",
      },
      elements: {
        card: "bg-[hsl(var(--bg))] text-[hsl(var(--fg))] border border-[hsl(var(--border))]",
        headerTitle: "text-[hsl(var(--fg))]",
        formFieldInput:
          "bg-[hsl(var(--muted))] text-[hsl(var(--fg))] border-[hsl(var(--border))] placeholder:text-[hsl(var(--muted-fg))] focus:ring-2",
        footerActionLink: "hover:opacity-80",
        socialButtons: "bg-[hsl(var(--muted))]",
      },
    }}
  />
  ```
- Apply the same `appearance` to SignUp, UserButton, UserProfile, OrganizationProfile, OrganizationSwitcher.

6) Shared wrapper
- Create `components/ClerkAppearance.tsx` exporting a helper that returns the `appearance` object from the snippet above, and reuse it across all Clerk components.

7) SSR safety
- Use `suppressHydrationWarning` on `<html>` and guard any `useTheme()` color decisions behind a `mounted` check to avoid mismatches:
  ```tsx
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  ```

8) QA
- Verify: toggling light/dark updates Clerk instantly without page reload.
- Check all states (hover, focus, disabled, errors) for contrast in both themes.
- Ensure system theme changes are reflected when user selection is “system”.

Implement all of the above and update affected files with minimal diffs.
```


## See Also
- [[chatgpt/chatgpt_add-dark-mode]]
- [[chatgpt/chatgpt_dark-mode-change]]
- [[chatgpt/chatgpt_dark-mode-linear-colors]]
- [[chatgpt/chatgpt_mockup-request-dark-mode]]
- [[chatgpt/chatgpt_pass-color-prop-based-on-dark-mode]]
