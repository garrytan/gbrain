# MD3 Typography, Shape, Elevation, and Motion

Reference for Material Design 3's visual token systems beyond color.

## Typography

### Type Scale

MD3 uses 15 baseline styles + 15 emphasized styles organized in 5 categories (Display, Headline, Title, Body, Label) with 3 sizes each (Large, Medium, Small).

#### Baseline Type Scale (Default Values)

| Style | Font | Weight | Size (sp) | Size (rem) | Line Height | Tracking |
|-------|------|--------|-----------|------------|-------------|----------|
| Display Large | Roboto | 400 | 57 | 3.5625 | 64sp / 4rem | -0.25px |
| Display Medium | Roboto | 400 | 45 | 2.8125 | 52sp / 3.25rem | 0 |
| Display Small | Roboto | 400 | 36 | 2.25 | 44sp / 2.75rem | 0 |
| Headline Large | Roboto | 400 | 32 | 2 | 40sp / 2.5rem | 0 |
| Headline Medium | Roboto | 400 | 28 | 1.75 | 36sp / 2.25rem | 0 |
| Headline Small | Roboto | 400 | 24 | 1.5 | 32sp / 2rem | 0 |
| Title Large | Roboto | 400 | 22 | 1.375 | 28sp / 1.75rem | 0 |
| Title Medium | Roboto | 500 | 16 | 1 | 24sp / 1.5rem | 0.15px |
| Title Small | Roboto | 500 | 14 | 0.875 | 20sp / 1.25rem | 0.1px |
| Body Large | Roboto | 400 | 16 | 1 | 24sp / 1.5rem | 0.5px |
| Body Medium | Roboto | 400 | 14 | 0.875 | 20sp / 1.25rem | 0.25px |
| Body Small | Roboto | 400 | 12 | 0.75 | 16sp / 1rem | 0.4px |
| Label Large | Roboto | 500 | 14 | 0.875 | 20sp / 1.25rem | 0.1px |
| Label Medium | Roboto | 500 | 12 | 0.75 | 16sp / 1rem | 0.5px |
| Label Small | Roboto | 500 | 11 | 0.6875 | 16sp / 1rem | 0.5px |

#### Emphasized Type Styles (Expressive Update)

The 15 emphasized styles mirror the baseline scale but with **higher weight** and minor adjustments. Use for:
- Selected/active states in components
- Primary action buttons
- Headlines needing emphasis
- Unread/important content

To use: swap the baseline token for the emphasized version:
- Baseline: `md.sys.typescale.display-large`
- Emphasized: `md.sys.typescale.emphasized.display-large`

### CSS Custom Properties

Each type style maps to individual axis tokens:

```css
/* Example: Body Large */
--md-sys-typescale-body-large-font: 'Roboto', sans-serif;
--md-sys-typescale-body-large-weight: 400;
--md-sys-typescale-body-large-size: 1rem;        /* 16sp */
--md-sys-typescale-body-large-line-height: 1.5rem; /* 24sp */
--md-sys-typescale-body-large-tracking: 0.03125rem; /* 0.5px */

/* Example: Title Medium */
--md-sys-typescale-title-medium-font: 'Roboto', sans-serif;
--md-sys-typescale-title-medium-weight: 500;
--md-sys-typescale-title-medium-size: 1rem;
--md-sys-typescale-title-medium-line-height: 1.5rem;
--md-sys-typescale-title-medium-tracking: 0.009375rem;

/* Example: Label Large (used for buttons) */
--md-sys-typescale-label-large-font: 'Roboto', sans-serif;
--md-sys-typescale-label-large-weight: 500;
--md-sys-typescale-label-large-size: 0.875rem;
--md-sys-typescale-label-large-line-height: 1.25rem;
--md-sys-typescale-label-large-tracking: 0.00625rem;
```

### Using Type Styles in CSS

Apply using individual properties:

```css
.headline {
  font-family: var(--md-sys-typescale-headline-large-font);
  font-weight: var(--md-sys-typescale-headline-large-weight);
  font-size: var(--md-sys-typescale-headline-large-size);
  line-height: var(--md-sys-typescale-headline-large-line-height);
  letter-spacing: var(--md-sys-typescale-headline-large-tracking);
}
```

Or use the shorthand font property for convenience (note: requires defining the shorthand token):

```css
.headline {
  font: var(--md-sys-typescale-headline-large-weight)
        var(--md-sys-typescale-headline-large-size) /
        var(--md-sys-typescale-headline-large-line-height)
        var(--md-sys-typescale-headline-large-font);
  letter-spacing: var(--md-sys-typescale-headline-large-tracking);
}
```

### Typeface Customization

MD3 uses two typeface roles:
- **Brand**: Used for Display and Headline styles (expression-focused)
- **Plain**: Used for Title, Body, and Label styles (readability-focused)

Both default to Roboto. To customize:

```css
:root {
  /* Brand typeface for display/headline */
  --md-ref-typeface-brand: 'Your Display Font', sans-serif;
  /* Plain typeface for body/label/title */
  --md-ref-typeface-plain: 'Your Body Font', sans-serif;
}
```

### Roboto Flex

Roboto Flex is a variable font supporting multiple axes:
- **Weight** (wght): 100–1000
- **Width** (wdth): 25–151
- **Optical size** (opsz): 8–144

```css
@font-face {
  font-family: 'Roboto Flex';
  src: url('RobotoFlex-VariableFont.woff2') format('woff2');
  font-weight: 100 1000;
  font-stretch: 25% 151%;
}
```

### Font Size Units

| Platform | Unit | Conversion |
|----------|------|------------|
| Android | sp | 1:1 |
| Web | rem | sp / 16 = rem (assuming 16px root) |

Examples: 10sp = 0.625rem, 12sp = 0.75rem, 14sp = 0.875rem, 16sp = 1rem, 24sp = 1.5rem

### Component Type Usage

| Component | Type Style |
|-----------|-----------|
| Button label | Label Large |
| Card title | Title Medium |
| Card body | Body Medium |
| Top app bar title | Title Large |
| Navigation label | Label Medium |
| Dialog headline | Headline Small |
| Dialog body | Body Medium |
| Chip label | Label Large |
| Text field input | Body Large |
| Text field label | Body Small (floating) / Body Large (resting) |
| List headline | Body Large |
| List supporting text | Body Medium |
| Snackbar text | Body Medium |
| Tooltip text | Body Small |
| Tab label | Title Small |
| Badge count | Label Small |

## Shape

### Corner Radius Scale

| Token | Value (dp) | Value (px/CSS) | Default components |
|-------|-----------|----------------|-------------------|
| `none` | 0 | 0px | — |
| `extra-small` | 4 | 4px | Snackbar |
| `small` | 8 | 8px | Text fields, menus, chips |
| `medium` | 12 | 12px | Cards |
| `large` | 16 | 16px | FAB, extended FAB, nav drawer |
| `large-increased` | 20 | 20px | (Expressive update) |
| `extra-large` | 28 | 28px | Dialogs, bottom sheets, side sheets |
| `extra-large-increased` | 32 | 32px | (Expressive update) |
| `extra-extra-large` | 48 | 48px | (Expressive update) |
| `full` | — | 9999px | Buttons, badges, pills, sliders |

### CSS Custom Properties

```css
:root {
  --md-sys-shape-corner-none: 0px;
  --md-sys-shape-corner-extra-small: 4px;
  --md-sys-shape-corner-small: 8px;
  --md-sys-shape-corner-medium: 12px;
  --md-sys-shape-corner-large: 16px;
  --md-sys-shape-corner-large-increased: 20px;
  --md-sys-shape-corner-extra-large: 28px;
  --md-sys-shape-corner-extra-large-increased: 32px;
  --md-sys-shape-corner-extra-extra-large: 48px;
  --md-sys-shape-corner-full: 9999px;
}
```

### Component Shape Mapping

| Component | Default Shape Token |
|-----------|-------------------|
| Buttons (all types) | `full` |
| FAB | `large` |
| Extended FAB | `large` |
| Icon button | `full` |
| Chips | `small` |
| Cards | `medium` |
| Dialogs | `extra-large` |
| Text fields | `small` (top corners) |
| Menus | `small` |
| Navigation drawer | `large` (end corners) |
| Bottom sheets | `extra-large` (top corners) |
| Snackbar | `extra-small` |
| Badges | `full` |
| Sliders (handle) | `full` |
| Switch (track) | `full` |
| Tabs (indicator) | `full` (top corners) |
| Search bar | `full` |

### Shape Morphing (Expressive)

In the M3 Expressive update, components can morph between shapes on interaction:
- Button shapes morph when pressed
- Selected states can change shape
- Loading indicators use shape morphing to show progress

**Platform notes**: Shape morphing is **not** in `@material/web` ([Material Web is maintenance-only; Expressive not on Web](https://m3.material.io/develop/web)). **Jetpack Compose** is where Google documents expressive shape/motion behavior for Android. **Flutter:** check current Material 3 / expressive docs for your SDK. **Web:** approximate with CSS transitions on `border-radius`.

## Elevation

### Elevation Levels

| Level | DP Height | Use |
|-------|-----------|-----|
| 0 | 0dp | Most resting components |
| 1 | 1dp | Elevated variants (cards, sheets) |
| 2 | 3dp | Menus, nav bar, scrolled app bar |
| 3 | 6dp | FAB, dialogs, search, date/time pickers |
| 4 | 8dp | Hover/focus increase only |
| 5 | 12dp | Hover/focus increase only |

### Tonal Elevation (Not Shadows)

MD3 uses **tonal surface color** to communicate elevation, not shadows. Higher elevation = lighter surface tone (in light theme) or lighter surface tone (in dark theme).

The surface container roles map to this concept:
- Level 0: `surface` (flattest)
- Level 1: `surface-container-low`
- Level 2: `surface-container`
- Level 3: `surface-container-high`
- Level 4-5: `surface-container-highest`

### When to Use Shadows

Shadows are only appropriate when:
- A component floats over content that may be visually busy (e.g., FAB over images)
- Additional depth cue is needed beyond color (e.g., overlapping elements)
- The platform convention expects shadows (some Android components)

### CSS Shadow Values

When shadows are needed:

```css
/* Level 1 */
box-shadow: 0 1px 2px rgba(0,0,0,0.3), 0 1px 3px 1px rgba(0,0,0,0.15);

/* Level 2 */
box-shadow: 0 1px 2px rgba(0,0,0,0.3), 0 2px 6px 2px rgba(0,0,0,0.15);

/* Level 3 */
box-shadow: 0 4px 8px 3px rgba(0,0,0,0.15), 0 1px 3px rgba(0,0,0,0.3);

/* Level 4 */
box-shadow: 0 6px 10px 4px rgba(0,0,0,0.15), 0 2px 3px rgba(0,0,0,0.3);

/* Level 5 */
box-shadow: 0 8px 12px 6px rgba(0,0,0,0.15), 0 4px 4px rgba(0,0,0,0.3);
```

### Component Elevation Mapping

| Level | Components at Rest |
|-------|--------------------|
| 0 | App bar (flat), filled/tonal/outlined buttons, button groups, filled/outlined cards, carousel, chips, full-screen dialogs, icon buttons, lists, nav rail, segmented buttons, sliders, split buttons, tabs |
| 1 | Banners, modal bottom sheet, elevated button, elevated card, elevated chips, modal nav drawer, modal side sheet |
| 2 | App bar (scrolled), menus, nav bar, rich tooltips, toolbar |
| 3 | Date pickers, modal dialogs, extended FAB, FAB, FAB menu close button, search, time pickers |

**Hover/focus**: Most interactive components increase by 1 level on hover/focus (e.g., FAB goes from level 3 to level 4).

## Motion

### Spring-Based Motion (Expressive Update)

MD3 Expressive (May 2025) introduced spring-based motion physics for component animations. Springs create more natural, responsive motion:

- Springs have no fixed duration — they respond dynamically to input
- Two schemes: **standard** (utilitarian) and **expressive** (bouncy)
- **Jetpack Compose** exposes motion schemes / spring-oriented APIs in current Material3 (see `MotionScheme` and your BOM). **MDC-Android** may differ by version. **Web:** Material Web does not implement Expressive motion physics — use easing/duration or custom CSS/JS. **Flutter:** check your Flutter/Material version for parity.

### Easing and Duration (Transitions)

The easing/duration system is used for **transitions** (entering, exiting, shared-axis) and as a web fallback:

#### Easing Sets

**Emphasized** (recommended for most transitions — captures the MD3 style):
| Type | CSS Cubic-bezier | Use |
|------|-----------------|-----|
| Emphasized | `cubic-bezier(0.2, 0, 0, 1)` | Begin and end on screen |
| Emphasized Decelerate | `cubic-bezier(0.05, 0.7, 0.1, 1)` | Enter the screen |
| Emphasized Accelerate | `cubic-bezier(0.3, 0, 0.8, 0.15)` | Exit the screen |

**Standard** (for utility transitions, web fallback):
| Type | CSS Cubic-bezier | Use |
|------|-----------------|-----|
| Standard | `cubic-bezier(0.2, 0, 0, 1)` | Begin and end on screen |
| Standard Decelerate | `cubic-bezier(0, 0, 0, 1)` | Enter the screen |
| Standard Accelerate | `cubic-bezier(0.3, 0, 1, 1)` | Exit the screen |

#### Duration Scale

| Token | Value | Use |
|-------|-------|-----|
| Short 1 | 50ms | Micro-interactions |
| Short 2 | 100ms | Small transitions |
| Short 3 | 150ms | Small transitions |
| Short 4 | 200ms | Exit transitions |
| Medium 1 | 250ms | Medium transitions |
| Medium 2 | 300ms | Standard transitions |
| Medium 3 | 350ms | Medium transitions |
| Medium 4 | 400ms | Enter transitions |
| Long 1 | 450ms | Large transitions |
| Long 2 | 500ms | Large, emphasized transitions |
| Long 3 | 550ms | Complex transitions |
| Long 4 | 600ms | Complex transitions |
| Extra Long 1 | 700ms | Page transitions |
| Extra Long 2 | 800ms | Page transitions |
| Extra Long 3 | 900ms | Complex page transitions |
| Extra Long 4 | 1000ms | Complex page transitions |

#### Suggested Pairings

| Transition | Easing | Duration |
|-----------|--------|----------|
| Element stays on screen | Emphasized | 500ms |
| Element enters screen | Emphasized Decelerate | 400ms |
| Element exits permanently | Emphasized Accelerate | 200ms |
| Element exits temporarily | Emphasized | 300ms |
| Small utility transition | Standard | 300ms |

### CSS Implementation

```css
:root {
  /* Easing */
  --md-sys-motion-easing-emphasized: cubic-bezier(0.2, 0, 0, 1);
  --md-sys-motion-easing-emphasized-decelerate: cubic-bezier(0.05, 0.7, 0.1, 1);
  --md-sys-motion-easing-emphasized-accelerate: cubic-bezier(0.3, 0, 0.8, 0.15);
  --md-sys-motion-easing-standard: cubic-bezier(0.2, 0, 0, 1);
  --md-sys-motion-easing-standard-decelerate: cubic-bezier(0, 0, 0, 1);
  --md-sys-motion-easing-standard-accelerate: cubic-bezier(0.3, 0, 1, 1);

  /* Duration */
  --md-sys-motion-duration-short1: 50ms;
  --md-sys-motion-duration-short2: 100ms;
  --md-sys-motion-duration-short3: 150ms;
  --md-sys-motion-duration-short4: 200ms;
  --md-sys-motion-duration-medium1: 250ms;
  --md-sys-motion-duration-medium2: 300ms;
  --md-sys-motion-duration-medium3: 350ms;
  --md-sys-motion-duration-medium4: 400ms;
  --md-sys-motion-duration-long1: 450ms;
  --md-sys-motion-duration-long2: 500ms;
  --md-sys-motion-duration-long3: 550ms;
  --md-sys-motion-duration-long4: 600ms;
  --md-sys-motion-duration-extra-long1: 700ms;
  --md-sys-motion-duration-extra-long2: 800ms;
  --md-sys-motion-duration-extra-long3: 900ms;
  --md-sys-motion-duration-extra-long4: 1000ms;
}

/* Example: dialog enter */
.md3-dialog-enter {
  animation: dialog-enter var(--md-sys-motion-duration-medium4)
             var(--md-sys-motion-easing-emphasized-decelerate);
}

@keyframes dialog-enter {
  from { opacity: 0; transform: scale(0.8); }
  to { opacity: 1; transform: scale(1); }
}

/* Example: fade out */
.md3-fade-out {
  animation: fade-out var(--md-sys-motion-duration-short4)
             var(--md-sys-motion-easing-emphasized-accelerate);
}

@keyframes fade-out {
  from { opacity: 1; }
  to { opacity: 0; }
}
```
