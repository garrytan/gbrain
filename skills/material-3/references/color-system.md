# MD3 Color System

Complete reference for Material Design 3's color system: roles, tonal palettes, dynamic color, and scheme generation.

## Color Roles

MD3 defines 29+ color roles organized into groups. **Jetpack Compose:** map to `MaterialTheme.colorScheme` (e.g. `primary`, `onPrimary`). **Web:** each role exists as a CSS custom property `--md-sys-color-{role-name}`.

### Accent Colors

Three accent groups (primary, secondary, tertiary) each have 4 roles:

| Role | CSS Token | Purpose |
|------|-----------|---------|
| Primary | `--md-sys-color-primary` | High-emphasis fills, text, icons against surface |
| On Primary | `--md-sys-color-on-primary` | Text and icons on primary |
| Primary Container | `--md-sys-color-primary-container` | Standout fill for key components (FAB, etc.) |
| On Primary Container | `--md-sys-color-on-primary-container` | Text and icons on primary-container |
| Secondary | `--md-sys-color-secondary` | Less prominent fills, text, icons |
| On Secondary | `--md-sys-color-on-secondary` | Text and icons on secondary |
| Secondary Container | `--md-sys-color-secondary-container` | Recessive components (tonal buttons) |
| On Secondary Container | `--md-sys-color-on-secondary-container` | Text and icons on secondary-container |
| Tertiary | `--md-sys-color-tertiary` | Complementary fills, text, icons |
| On Tertiary | `--md-sys-color-on-tertiary` | Text and icons on tertiary |
| Tertiary Container | `--md-sys-color-tertiary-container` | Complementary container fill |
| On Tertiary Container | `--md-sys-color-on-tertiary-container` | Text and icons on tertiary-container |

**Usage guidance:**
- **Primary**: Most prominent components — FABs, high-emphasis buttons, active states
- **Secondary**: Less prominent components — filter chips, tonal buttons, selection states
- **Tertiary**: Contrasting accents that balance primary/secondary — input fields, badges

### Error Colors

Static colors that don't change with dynamic color schemes:

| Role | CSS Token | Purpose |
|------|-----------|---------|
| Error | `--md-sys-color-error` | Attention-grabbing color for urgent elements |
| On Error | `--md-sys-color-on-error` | Text and icons on error |
| Error Container | `--md-sys-color-error-container` | Error container fill |
| On Error Container | `--md-sys-color-on-error-container` | Text and icons on error-container |

### Surface Colors

| Role | CSS Token | Purpose |
|------|-----------|---------|
| Surface | `--md-sys-color-surface` | Default background color |
| On Surface | `--md-sys-color-on-surface` | Text and icons on any surface |
| On Surface Variant | `--md-sys-color-on-surface-variant` | Lower-emphasis text/icons on surface |
| Surface Container Lowest | `--md-sys-color-surface-container-lowest` | Lowest-emphasis container |
| Surface Container Low | `--md-sys-color-surface-container-low` | Low-emphasis container |
| Surface Container | `--md-sys-color-surface-container` | Default container (navigation areas) |
| Surface Container High | `--md-sys-color-surface-container-high` | High-emphasis container |
| Surface Container Highest | `--md-sys-color-surface-container-highest` | Highest-emphasis container |
| Surface Dim | `--md-sys-color-surface-dim` | Dimmest surface in both themes |
| Surface Bright | `--md-sys-color-surface-bright` | Brightest surface in both themes |

**Surface container hierarchy**: Use `surface` for background, `surface-container` for navigation. The 5 container levels create visual hierarchy and nesting depth, especially useful for expanded layouts with multiple panes.

**Surface dim/bright**: Unlike regular surface (which flips from light to dark), dim and bright maintain their relative brightness in both themes. Use bright for areas that should always be the lightest, dim for areas that should always be the dimmest.

### Inverse Colors

For elements that contrast against the surrounding UI (e.g., snackbars):

| Role | CSS Token | Purpose |
|------|-----------|---------|
| Inverse Surface | `--md-sys-color-inverse-surface` | Background for contrasting elements |
| Inverse On Surface | `--md-sys-color-inverse-on-surface` | Text on inverse-surface |
| Inverse Primary | `--md-sys-color-inverse-primary` | Actionable text on inverse-surface |

### Outline Colors

| Role | CSS Token | Purpose |
|------|-----------|---------|
| Outline | `--md-sys-color-outline` | Important boundaries (text field borders, 3:1 contrast) |
| Outline Variant | `--md-sys-color-outline-variant` | Decorative elements (dividers, card borders) |

**Important**: Don't use `outline` for dividers — use `outline-variant`. Don't use `outline-variant` for interactive boundaries that need 3:1 contrast — use `outline`.

### Fixed Accent Colors (Add-on)

These maintain the same color in both light and dark themes (unlike regular container colors which change tone):

| Role | CSS Token |
|------|-----------|
| Primary Fixed | `--md-sys-color-primary-fixed` |
| Primary Fixed Dim | `--md-sys-color-primary-fixed-dim` |
| On Primary Fixed | `--md-sys-color-on-primary-fixed` |
| On Primary Fixed Variant | `--md-sys-color-on-primary-fixed-variant` |
| Secondary Fixed | `--md-sys-color-secondary-fixed` |
| Secondary Fixed Dim | `--md-sys-color-secondary-fixed-dim` |
| On Secondary Fixed | `--md-sys-color-on-secondary-fixed` |
| On Secondary Fixed Variant | `--md-sys-color-on-secondary-fixed-variant` |
| Tertiary Fixed | `--md-sys-color-tertiary-fixed` |
| Tertiary Fixed Dim | `--md-sys-color-tertiary-fixed-dim` |
| On Tertiary Fixed | `--md-sys-color-on-tertiary-fixed` |
| On Tertiary Fixed Variant | `--md-sys-color-on-tertiary-fixed-variant` |

**Caution**: Fixed colors don't adapt to theme, so they may cause contrast issues. Use regular accent roles for elements where contrast is critical.

## Tonal Palette System

MD3 generates colors from a **seed color** through the tonal palette system:

### How It Works

1. A **seed color** (hex value) is chosen
2. The seed generates **5 tonal palettes**: Primary, Secondary, Tertiary, Neutral, Neutral-Variant
3. Each palette uses tonal stops along **0–100** (commonly 16 key stops: 0, 10, 20, 25, 30, 35, 40, 50, 60, 70, 80, 90, 95, 98, 99, 100)
4. Color roles are mapped to specific tonal values depending on light or dark scheme

### Tonal Value Mapping (Light Scheme)

| Role | Tonal Palette | Tone |
|------|--------------|------|
| Primary | Primary | 40 |
| On Primary | Primary | 100 |
| Primary Container | Primary | 90 |
| On Primary Container | Primary | 10 |
| Surface | Neutral | 98 |
| On Surface | Neutral | 10 |
| Surface Container | Neutral | 94 |
| Surface Container Low | Neutral | 96 |
| Surface Container Lowest | Neutral | 100 |
| Surface Container High | Neutral | 92 |
| Surface Container Highest | Neutral | 90 |
| Outline | Neutral-Variant | 50 |
| Outline Variant | Neutral-Variant | 80 |

### Tonal Value Mapping (Dark Scheme)

| Role | Tonal Palette | Tone |
|------|--------------|------|
| Primary | Primary | 80 |
| On Primary | Primary | 20 |
| Primary Container | Primary | 30 |
| On Primary Container | Primary | 90 |
| Surface | Neutral | 6 |
| On Surface | Neutral | 90 |
| Surface Container | Neutral | 12 |
| Surface Container Low | Neutral | 10 |
| Surface Container Lowest | Neutral | 4 |
| Surface Container High | Neutral | 17 |
| Surface Container Highest | Neutral | 22 |
| Outline | Neutral-Variant | 60 |
| Outline Variant | Neutral-Variant | 30 |

## Color Pairing Rules

Colors must only be used in their intended pairs to ensure accessible contrast:

| Container/Fill | Text/Icon Color |
|---------------|----------------|
| `primary` | `on-primary` |
| `primary-container` | `on-primary-container` |
| `secondary` | `on-secondary` |
| `secondary-container` | `on-secondary-container` |
| `tertiary` | `on-tertiary` |
| `tertiary-container` | `on-tertiary-container` |
| `error` | `on-error` |
| `error-container` | `on-error-container` |
| `surface` | `on-surface` or `on-surface-variant` |
| `surface-container-*` | `on-surface` or `on-surface-variant` |
| `inverse-surface` | `inverse-on-surface` or `inverse-primary` |

**Never pair colors outside their intended pairs** — this breaks contrast guarantees, especially under dynamic color and high contrast modes.

## Dynamic Color

Dynamic color creates personalized color schemes from external sources:

### User-Generated (Wallpaper)
The OS extracts a seed color from the user's wallpaper and generates a scheme. **Android:** `dynamicLightColorScheme` / `dynamicDarkColorScheme` on **Android 12+ (API 31+)**. **Web:** there is **no** browser wallpaper dynamic-color API equivalent; you can derive a seed from **content** (e.g. images) with libraries, but that is app-specific, not system wallpaper theming.

### Content-Based
A seed color is extracted from in-app content (album art, book cover, etc.) to create a contextual scheme.

### Generating a Scheme with JavaScript

```javascript
import {
  argbFromHex,
  themeFromSourceColor,
  applyTheme,
} from '@material/material-color-utilities';

// Generate a theme from a seed color
const theme = themeFromSourceColor(argbFromHex('#6750A4'));

// Apply to the document
applyTheme(theme, { target: document.body, dark: false });
```

### Manual CSS Generation from Seed

```javascript
import {
  argbFromHex,
  hexFromArgb,
  SchemeContent,
  Hct,
} from '@material/material-color-utilities';

function generateScheme(seedHex, isDark = false) {
  const hct = Hct.fromInt(argbFromHex(seedHex));
  const scheme = new SchemeContent(hct, isDark, 0.0); // 0.0 = standard contrast

  return {
    '--md-sys-color-primary': hexFromArgb(scheme.primary),
    '--md-sys-color-on-primary': hexFromArgb(scheme.onPrimary),
    '--md-sys-color-primary-container': hexFromArgb(scheme.primaryContainer),
    '--md-sys-color-on-primary-container': hexFromArgb(scheme.onPrimaryContainer),
    '--md-sys-color-secondary': hexFromArgb(scheme.secondary),
    '--md-sys-color-on-secondary': hexFromArgb(scheme.onSecondary),
    '--md-sys-color-secondary-container': hexFromArgb(scheme.secondaryContainer),
    '--md-sys-color-on-secondary-container': hexFromArgb(scheme.onSecondaryContainer),
    '--md-sys-color-tertiary': hexFromArgb(scheme.tertiary),
    '--md-sys-color-on-tertiary': hexFromArgb(scheme.onTertiary),
    '--md-sys-color-tertiary-container': hexFromArgb(scheme.tertiaryContainer),
    '--md-sys-color-on-tertiary-container': hexFromArgb(scheme.onTertiaryContainer),
    '--md-sys-color-error': hexFromArgb(scheme.error),
    '--md-sys-color-on-error': hexFromArgb(scheme.onError),
    '--md-sys-color-error-container': hexFromArgb(scheme.errorContainer),
    '--md-sys-color-on-error-container': hexFromArgb(scheme.onErrorContainer),
    '--md-sys-color-surface': hexFromArgb(scheme.surface),
    '--md-sys-color-on-surface': hexFromArgb(scheme.onSurface),
    '--md-sys-color-on-surface-variant': hexFromArgb(scheme.onSurfaceVariant),
    '--md-sys-color-surface-container': hexFromArgb(scheme.surfaceContainer),
    '--md-sys-color-surface-container-low': hexFromArgb(scheme.surfaceContainerLow),
    '--md-sys-color-surface-container-lowest': hexFromArgb(scheme.surfaceContainerLowest),
    '--md-sys-color-surface-container-high': hexFromArgb(scheme.surfaceContainerHigh),
    '--md-sys-color-surface-container-highest': hexFromArgb(scheme.surfaceContainerHighest),
    '--md-sys-color-outline': hexFromArgb(scheme.outline),
    '--md-sys-color-outline-variant': hexFromArgb(scheme.outlineVariant),
    '--md-sys-color-inverse-surface': hexFromArgb(scheme.inverseSurface),
    '--md-sys-color-inverse-on-surface': hexFromArgb(scheme.inverseOnSurface),
    '--md-sys-color-inverse-primary': hexFromArgb(scheme.inversePrimary),
  };
}

// Apply to document
function applyScheme(seedHex, isDark = false) {
  const tokens = generateScheme(seedHex, isDark);
  const root = document.documentElement;
  for (const [property, value] of Object.entries(tokens)) {
    root.style.setProperty(property, value);
  }
}
```

## Color Harmonization

When integrating custom brand colors that don't come from the seed, use harmonization to blend them into the tonal system:

```javascript
import { Blend } from '@material/material-color-utilities';

// Harmonize a custom color with the primary color
const harmonized = Blend.harmonize(customColorArgb, primaryColorArgb);
```

This shifts the custom color's hue slightly toward the scheme's primary, making it feel cohesive without losing its identity.

## User-Controlled Contrast (May 2025)

MD3 now supports 3 contrast levels:
- **Standard** (0.0): Default contrast
- **Medium** (0.5): Increased tonal distance between roles
- **High** (1.0): Maximum tonal distance for vision accessibility

```javascript
// Generate high contrast scheme
const scheme = new SchemeContent(hct, isDark, 1.0); // 1.0 = high contrast
```

The contrast parameter adjusts the tonal distance between paired roles, increasing legibility without changing the overall color feel.

## Baseline Color Scheme (Default Values)

The static baseline scheme for products not using dynamic color:

### Light Theme
```css
:root {
  --md-sys-color-primary: #6750A4;
  --md-sys-color-on-primary: #FFFFFF;
  --md-sys-color-primary-container: #EADDFF;
  --md-sys-color-on-primary-container: #21005D;
  --md-sys-color-secondary: #625B71;
  --md-sys-color-on-secondary: #FFFFFF;
  --md-sys-color-secondary-container: #E8DEF8;
  --md-sys-color-on-secondary-container: #1D192B;
  --md-sys-color-tertiary: #7D5260;
  --md-sys-color-on-tertiary: #FFFFFF;
  --md-sys-color-tertiary-container: #FFD8E4;
  --md-sys-color-on-tertiary-container: #31111D;
  --md-sys-color-error: #B3261E;
  --md-sys-color-on-error: #FFFFFF;
  --md-sys-color-error-container: #F9DEDC;
  --md-sys-color-on-error-container: #410E0B;
  --md-sys-color-surface: #FEF7FF;
  --md-sys-color-on-surface: #1D1B20;
  --md-sys-color-on-surface-variant: #49454F;
  --md-sys-color-surface-container-lowest: #FFFFFF;
  --md-sys-color-surface-container-low: #F7F2FA;
  --md-sys-color-surface-container: #F3EDF7;
  --md-sys-color-surface-container-high: #ECE6F0;
  --md-sys-color-surface-container-highest: #E6E0E9;
  --md-sys-color-surface-dim: #DED8E1;
  --md-sys-color-surface-bright: #FEF7FF;
  --md-sys-color-outline: #79747E;
  --md-sys-color-outline-variant: #CAC4D0;
  --md-sys-color-inverse-surface: #322F35;
  --md-sys-color-inverse-on-surface: #F5EFF7;
  --md-sys-color-inverse-primary: #D0BCFF;
}
```

### Dark Theme
```css
@media (prefers-color-scheme: dark) {
  :root {
    --md-sys-color-primary: #D0BCFF;
    --md-sys-color-on-primary: #381E72;
    --md-sys-color-primary-container: #4F378B;
    --md-sys-color-on-primary-container: #EADDFF;
    --md-sys-color-secondary: #CCC2DC;
    --md-sys-color-on-secondary: #332D41;
    --md-sys-color-secondary-container: #4A4458;
    --md-sys-color-on-secondary-container: #E8DEF8;
    --md-sys-color-tertiary: #EFB8C8;
    --md-sys-color-on-tertiary: #492532;
    --md-sys-color-tertiary-container: #633B48;
    --md-sys-color-on-tertiary-container: #FFD8E4;
    --md-sys-color-error: #F2B8B5;
    --md-sys-color-on-error: #601410;
    --md-sys-color-error-container: #8C1D18;
    --md-sys-color-on-error-container: #F9DEDC;
    --md-sys-color-surface: #141218;
    --md-sys-color-on-surface: #E6E0E9;
    --md-sys-color-on-surface-variant: #CAC4D0;
    --md-sys-color-surface-container-lowest: #0F0D13;
    --md-sys-color-surface-container-low: #1D1B20;
    --md-sys-color-surface-container: #211F26;
    --md-sys-color-surface-container-high: #2B2930;
    --md-sys-color-surface-container-highest: #36343B;
    --md-sys-color-surface-dim: #141218;
    --md-sys-color-surface-bright: #3B383E;
    --md-sys-color-outline: #938F99;
    --md-sys-color-outline-variant: #49454F;
    --md-sys-color-inverse-surface: #E6E0E9;
    --md-sys-color-inverse-on-surface: #322F35;
    --md-sys-color-inverse-primary: #6750A4;
  }
}
```
