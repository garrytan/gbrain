# MD3 Component Catalog

Complete reference for Material Design 3 components. **Primary mappings:** Jetpack Compose (`androidx.compose.material3`) where most users ship UIs today; **web** uses `@material/web` element names and imports — [Material Web is maintenance-only](https://m3.material.io/develop/web).

## Google I/O 2026 Component Updates

Material's [I/O 2026 update](https://m3.material.io/blog/whats-new-at-io26) highlights refreshed expressive guidance for **lists**, **menus**, **search**, and **search app bars**, with Jetpack Compose as the primary implementation path. When implementing these in Android:

- Prefer current `androidx.compose.material3` components and verify expressive APIs against the active Material3 BOM.
- Expect expressive variants to include richer visual style, motion, and flexible configuration.
- Treat web implementations as spec-aligned approximations unless Material Web exposes an equivalent component; Material Web remains maintenance-only.

## Actions

### Buttons

MD3 has 5 button types ordered by emphasis: Filled > Filled Tonal > Elevated > Outlined > Text.

**General attributes** (shared by all button types):

| Attribute | Type | Description |
|-----------|------|-------------|
| `disabled` | boolean | Disables the button |
| `href` | string | Turns button into a link |
| `target` | string | Link target (`_blank`, etc.) |
| `trailing-icon` | boolean | Moves icon to trailing position |
| `type` | string | Form type: `button`, `submit`, `reset` |

#### Filled Button
**Element**: `md-filled-button` | **Import**: `@material/web/button/filled-button.js`
**Use when**: Primary action, highest emphasis.

```html
<md-filled-button>Get started</md-filled-button>
<md-filled-button href="/signup">
  <md-icon slot="icon">arrow_forward</md-icon>
  Sign up
</md-filled-button>
```

**Customize**: `--md-filled-button-container-color`, `--md-filled-button-label-text-color`, `--md-filled-button-container-shape`, `--md-filled-button-container-height`

#### Filled Tonal Button
**Element**: `md-filled-tonal-button` | **Import**: `@material/web/button/filled-tonal-button.js`
**Use when**: Medium emphasis, softer than filled. Secondary actions alongside a filled button.

```html
<md-filled-tonal-button>Save draft</md-filled-tonal-button>
```

**Customize**: `--md-filled-tonal-button-container-color`, `--md-filled-tonal-button-label-text-color`

#### Elevated Button
**Element**: `md-elevated-button` | **Import**: `@material/web/button/elevated-button.js`
**Use when**: Medium emphasis with shadow. Use on colored backgrounds where tonal button blends in.

```html
<md-elevated-button>Add to cart</md-elevated-button>
```

#### Outlined Button
**Element**: `md-outlined-button` | **Import**: `@material/web/button/outlined-button.js`
**Use when**: Medium emphasis, neutral. Good for secondary actions.

```html
<md-outlined-button>Cancel</md-outlined-button>
```

**Customize**: `--md-outlined-button-outline-color`, `--md-outlined-button-outline-width`

#### Text Button
**Element**: `md-text-button` | **Import**: `@material/web/button/text-button.js`
**Use when**: Lowest emphasis. Inline actions, dialog actions, less important options.

```html
<md-text-button>Learn more</md-text-button>
```

#### Button Sizes (Expressive)
Buttons now support 5 sizes: extra-small, small (default), medium, large, extra-large. Set via CSS:
```css
md-filled-button { --md-filled-button-container-height: 32px; } /* XS */
md-filled-button { --md-filled-button-container-height: 40px; } /* S (default) */
md-filled-button { --md-filled-button-container-height: 48px; } /* M */
md-filled-button { --md-filled-button-container-height: 56px; } /* L */
md-filled-button { --md-filled-button-container-height: 64px; } /* XL */
```

**A11y**: Buttons have built-in button role. Use `aria-label` when using icon-only buttons. Minimum touch target 48x48dp.

### Button Group
**Element**: `md-button-group` | **Import**: `@material/web/button/button-group.js`
**Use when**: Grouping related actions together with connected visual treatment.

```html
<md-button-group>
  <md-outlined-button>Day</md-outlined-button>
  <md-outlined-button>Week</md-outlined-button>
  <md-outlined-button>Month</md-outlined-button>
</md-button-group>
```

### FAB (Floating Action Button)
**Element**: `md-fab` | **Import**: `@material/web/fab/fab.js`
**Use when**: The single most important action on a screen.

| Attribute | Type | Description |
|-----------|------|-------------|
| `size` | string | `small`, `medium` (default), `large` |
| `variant` | string | `surface`, `primary`, `secondary`, `tertiary` |
| `label` | string | Text label (for extended FAB) |

```html
<md-fab aria-label="Create new">
  <md-icon slot="icon">add</md-icon>
</md-fab>

<md-fab size="small" variant="tertiary" aria-label="Edit">
  <md-icon slot="icon">edit</md-icon>
</md-fab>
```

**Customize**: `--md-fab-container-color`, `--md-fab-container-shape`, `--md-fab-icon-color`
**A11y**: Always provide `aria-label` since FABs are icon-only.

### Extended FAB
**Element**: `md-extended-fab` | **Import**: `@material/web/fab/extended-fab.js`
**Use when**: Primary action with explanatory text.

```html
<md-extended-fab label="New message">
  <md-icon slot="icon">edit</md-icon>
</md-extended-fab>
```

### Icon Button
**Element**: `md-icon-button` | **Import**: `@material/web/iconbutton/icon-button.js`

4 variants with separate elements:

| Variant | Element | Import |
|---------|---------|--------|
| Standard | `md-icon-button` | `@material/web/iconbutton/icon-button.js` |
| Filled | `md-filled-icon-button` | `@material/web/iconbutton/filled-icon-button.js` |
| Filled Tonal | `md-filled-tonal-icon-button` | `@material/web/iconbutton/filled-tonal-icon-button.js` |
| Outlined | `md-outlined-icon-button` | `@material/web/iconbutton/outlined-icon-button.js` |

| Attribute | Type | Description |
|-----------|------|-------------|
| `toggle` | boolean | Enables toggle behavior |
| `selected` | boolean | Selected state (when toggle) |

```html
<md-icon-button aria-label="Settings">
  <md-icon>settings</md-icon>
</md-icon-button>

<!-- Toggle icon button (like/unlike) -->
<md-icon-button toggle aria-label="Favorite">
  <md-icon>favorite_border</md-icon>
  <md-icon slot="selected">favorite</md-icon>
</md-icon-button>
```

**A11y**: Always provide `aria-label`. Toggle buttons should have descriptive labels for both states.

### Segmented Buttons
**No @material/web element yet.** Implement with standard HTML + MD3 tokens:

```html
<div class="md3-segmented-buttons" role="group" aria-label="View options">
  <button class="md3-segmented-button md3-segmented-button--selected" aria-pressed="true">
    <md-icon>view_list</md-icon> List
  </button>
  <button class="md3-segmented-button" aria-pressed="false">
    <md-icon>grid_view</md-icon> Grid
  </button>
</div>
```

```css
.md3-segmented-buttons {
  display: flex;
  border: 1px solid var(--md-sys-color-outline);
  border-radius: var(--md-sys-shape-corner-full);
  overflow: hidden;
}
.md3-segmented-button {
  flex: 1;
  padding: 10px 16px;
  border: none;
  background: transparent;
  color: var(--md-sys-color-on-surface);
  cursor: pointer;
  font: var(--md-sys-typescale-label-large);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}
.md3-segmented-button--selected {
  background: var(--md-sys-color-secondary-container);
  color: var(--md-sys-color-on-secondary-container);
}
```

## Communication

### Badge
**No @material/web element yet.** Implement with CSS:

```html
<div class="md3-badge-container">
  <md-icon>notifications</md-icon>
  <span class="md3-badge md3-badge--large">3</span>
</div>
```

```css
.md3-badge-container { position: relative; display: inline-flex; }
.md3-badge {
  position: absolute;
  top: -4px;
  right: -4px;
  background: var(--md-sys-color-error);
  color: var(--md-sys-color-on-error);
  border-radius: var(--md-sys-shape-corner-full);
  font: var(--md-sys-typescale-label-small);
}
.md3-badge--small { width: 6px; height: 6px; padding: 0; } /* dot only */
.md3-badge--large { min-width: 16px; height: 16px; padding: 0 4px; text-align: center; }
```

### Progress Indicator
**Elements**: `md-linear-progress`, `md-circular-progress`
**Import**: `@material/web/progress/linear-progress.js`, `@material/web/progress/circular-progress.js`

| Attribute | Type | Description |
|-----------|------|-------------|
| `value` | number | Current progress (0–1) |
| `max` | number | Maximum value (default 1) |
| `indeterminate` | boolean | Shows indeterminate animation |
| `four-color` | boolean | Four-color indeterminate variant |

```html
<!-- Determinate -->
<md-linear-progress value="0.6"></md-linear-progress>
<md-circular-progress value="0.75"></md-circular-progress>

<!-- Indeterminate -->
<md-linear-progress indeterminate></md-linear-progress>
<md-circular-progress indeterminate></md-circular-progress>
```

**Customize**: `--md-linear-progress-active-indicator-color`, `--md-circular-progress-active-indicator-color`
**A11y**: Has built-in `progressbar` role. Add `aria-label` for context (e.g., "Loading messages").

### Snackbar
**No @material/web element yet.** Implement with standard HTML:

```html
<div class="md3-snackbar" role="status" aria-live="polite">
  <span class="md3-snackbar__text">Message sent</span>
  <md-text-button class="md3-snackbar__action">Undo</md-text-button>
  <md-icon-button class="md3-snackbar__close" aria-label="Dismiss">
    <md-icon>close</md-icon>
  </md-icon-button>
</div>
```

```css
.md3-snackbar {
  background: var(--md-sys-color-inverse-surface);
  color: var(--md-sys-color-inverse-on-surface);
  border-radius: var(--md-sys-shape-corner-extra-small);
  padding: 12px 16px;
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 48px;
  max-width: 560px;
}
```

### Tooltip
**No @material/web element yet.**

Two types:
- **Plain**: Short text label, appears on hover/focus. Use for icon buttons and truncated text.
- **Rich**: Multi-line with optional actions. Use for complex explanations.

## Containment

### Card
**No @material/web element yet.** Three variants:

| Variant | Appearance | Elevation |
|---------|-----------|-----------|
| Filled | Surface-container-highest fill, no border | Level 0 |
| Outlined | Surface fill, outline-variant border | Level 0 |
| Elevated | Surface-container-low fill, shadow | Level 1 |

```html
<!-- Outlined card -->
<div class="md3-card md3-card--outlined">
  <div class="md3-card__content">
    <h3 style="font: var(--md-sys-typescale-title-medium)">Title</h3>
    <p style="font: var(--md-sys-typescale-body-medium); color: var(--md-sys-color-on-surface-variant)">
      Supporting text
    </p>
  </div>
  <div class="md3-card__actions">
    <md-filled-tonal-button>Action</md-filled-tonal-button>
  </div>
</div>

<!-- Filled card -->
<div class="md3-card md3-card--filled">...</div>

<!-- Elevated card -->
<div class="md3-card md3-card--elevated">...</div>
```

```css
.md3-card {
  border-radius: var(--md-sys-shape-corner-medium, 12px);
  overflow: hidden;
}
.md3-card--outlined {
  background: var(--md-sys-color-surface);
  border: 1px solid var(--md-sys-color-outline-variant);
}
.md3-card--filled {
  background: var(--md-sys-color-surface-container-highest);
}
.md3-card--elevated {
  background: var(--md-sys-color-surface-container-low);
  box-shadow: 0 1px 2px rgba(0,0,0,0.3), 0 1px 3px 1px rgba(0,0,0,0.15);
}
.md3-card__content { padding: 16px; }
.md3-card__actions { padding: 16px; display: flex; gap: 8px; justify-content: flex-end; }
```

### Dialog
**Element**: `md-dialog` | **Import**: `@material/web/dialog/dialog.js`

| Attribute | Type | Description |
|-----------|------|-------------|
| `open` | boolean | Shows the dialog |
| `type` | string | `alert` (default) |

```html
<md-dialog id="confirm-dialog">
  <div slot="headline">Confirm action</div>
  <form slot="content" method="dialog">
    Are you sure you want to proceed?
  </form>
  <div slot="actions">
    <md-text-button form="confirm-dialog" value="cancel">Cancel</md-text-button>
    <md-filled-tonal-button form="confirm-dialog" value="confirm">Confirm</md-filled-tonal-button>
  </div>
</md-dialog>
```

**A11y**: Dialog traps focus automatically. Use `slot="headline"` for accessible title.

### Bottom Sheet
**No @material/web element yet.** Two variants: Standard (persistent, coexists with content) and Modal (blocks interaction, has scrim).

### Side Sheet
**No @material/web element yet.** Two variants: Standard (docked alongside content) and Modal (overlays content with scrim).

### Divider
**Element**: `md-divider` | **Import**: `@material/web/divider/divider.js`

| Attribute | Type | Description |
|-----------|------|-------------|
| `inset` | boolean | Adds inset on both sides |
| `inset-start` | boolean | Adds inset on start side |
| `inset-end` | boolean | Adds inset on end side |

```html
<md-divider></md-divider>
<md-divider inset></md-divider>
```

### Carousel
**No @material/web element yet.** Three configurations:
- **Multi-browse**: Multiple items visible, scrollable
- **Uncontained**: Items extend beyond viewport edges
- **Hero**: One large featured item with smaller previews

## Input

### Checkbox
**Element**: `md-checkbox` | **Import**: `@material/web/checkbox/checkbox.js`

| Attribute | Type | Description |
|-----------|------|-------------|
| `checked` | boolean | Checked state |
| `indeterminate` | boolean | Indeterminate state |
| `disabled` | boolean | Disabled state |
| `required` | boolean | Required for form validation |

```html
<label>
  <md-checkbox></md-checkbox>
  Accept terms
</label>

<label>
  <md-checkbox checked></md-checkbox>
  Remember me
</label>
```

**A11y**: Wrap in `<label>` or use `aria-label`. Checkbox has built-in checkbox role.

### Chips
**Elements**: `md-chip-set`, `md-assist-chip`, `md-filter-chip`, `md-input-chip`, `md-suggestion-chip`
**Import**: `@material/web/chips/*.js`

| Variant | Element | Use |
|---------|---------|-----|
| Assist | `md-assist-chip` | Smart suggestions, shortcuts |
| Filter | `md-filter-chip` | Filtering content, multi-select |
| Input | `md-input-chip` | User input tokens (email recipients) |
| Suggestion | `md-suggestion-chip` | Suggested responses, queries |

```html
<md-chip-set>
  <md-filter-chip label="Vegetarian" selected></md-filter-chip>
  <md-filter-chip label="Vegan"></md-filter-chip>
  <md-filter-chip label="Gluten-free"></md-filter-chip>
</md-chip-set>

<md-chip-set>
  <md-input-chip label="user@example.com" removable></md-input-chip>
</md-chip-set>
```

### Menu
**Elements**: `md-menu`, `md-menu-item`, `md-sub-menu`
**Import**: `@material/web/menu/menu.js`, `@material/web/menu/menu-item.js`

**I/O 2026 note:** Expressive menus have updated Material guidance for more flexible, vibrant configurations. In Jetpack Compose, prefer current Material3 menu APIs and expressive variants when available in your BOM. On web, use `md-menu` / `md-menu-item` for token-backed menus, or build custom spec-aligned variants when expressive behavior is required.

| Attribute (menu) | Type | Description |
|-----------------|------|-------------|
| `anchor` | string | ID of the anchor element |
| `open` | boolean | Shows the menu |
| `positioning` | string | `absolute`, `fixed`, `popover` |

```html
<span style="position: relative;">
  <md-filled-button id="menu-trigger">Options</md-filled-button>
  <md-menu id="options-menu" anchor="menu-trigger">
    <md-menu-item>
      <div slot="headline">Edit</div>
      <md-icon slot="start">edit</md-icon>
    </md-menu-item>
    <md-menu-item>
      <div slot="headline">Delete</div>
      <md-icon slot="start">delete</md-icon>
    </md-menu-item>
  </md-menu>
</span>

<script>
  document.getElementById('menu-trigger').addEventListener('click', () => {
    document.getElementById('options-menu').open = !document.getElementById('options-menu').open;
  });
</script>
```

### Radio Button
**Element**: `md-radio` | **Import**: `@material/web/radio/radio.js`

```html
<div role="radiogroup" aria-label="Size">
  <label><md-radio name="size" value="s"></md-radio> Small</label>
  <label><md-radio name="size" value="m" checked></md-radio> Medium</label>
  <label><md-radio name="size" value="l"></md-radio> Large</label>
</div>
```

**A11y**: Group radios in a container with `role="radiogroup"` and `aria-label`.

### Slider
**Element**: `md-slider` | **Import**: `@material/web/slider/slider.js`

| Attribute | Type | Description |
|-----------|------|-------------|
| `value` | number | Current value |
| `min` | number | Minimum value |
| `max` | number | Maximum value |
| `step` | number | Step increment (makes discrete) |
| `labeled` | boolean | Shows value label |
| `range` | boolean | Enables range selection |
| `value-start` | number | Start value (range mode) |
| `value-end` | number | End value (range mode) |

```html
<!-- Continuous -->
<md-slider value="50" min="0" max="100" aria-label="Volume"></md-slider>

<!-- Discrete with label -->
<md-slider value="3" min="1" max="10" step="1" labeled aria-label="Rating"></md-slider>

<!-- Range -->
<md-slider range value-start="20" value-end="80" min="0" max="100" aria-label="Price range"></md-slider>
```

### Switch
**Element**: `md-switch` | **Import**: `@material/web/switch/switch.js`

| Attribute | Type | Description |
|-----------|------|-------------|
| `selected` | boolean | On state |
| `icons` | boolean | Show on/off icons |
| `disabled` | boolean | Disabled state |

```html
<label>
  <md-switch></md-switch>
  Dark mode
</label>

<label>
  <md-switch selected icons></md-switch>
  Notifications
</label>
```

**Customize**: `--md-switch-selected-handle-color`, `--md-switch-selected-track-color`

### Text Field
**Elements**: `md-filled-text-field`, `md-outlined-text-field`
**Import**: `@material/web/textfield/filled-text-field.js`, `@material/web/textfield/outlined-text-field.js`

| Attribute | Type | Description |
|-----------|------|-------------|
| `label` | string | Label text |
| `value` | string | Current value |
| `type` | string | Input type (text, email, password, number, textarea, etc.) |
| `placeholder` | string | Placeholder text |
| `required` | boolean | Required validation |
| `disabled` | boolean | Disabled state |
| `error` | boolean | Error state |
| `error-text` | string | Error message |
| `supporting-text` | string | Helper text |
| `prefix-text` | string | Prefix text |
| `suffix-text` | string | Suffix text |
| `max-length` | number | Character limit (shows counter) |
| `rows` | number | Rows (for textarea) |

```html
<!-- Outlined (recommended for most uses) -->
<md-outlined-text-field
  label="Email"
  type="email"
  required
  supporting-text="We'll never share your email">
</md-outlined-text-field>

<!-- Filled -->
<md-filled-text-field
  label="Search"
  type="text"
  placeholder="Type to search...">
  <md-icon slot="leading-icon">search</md-icon>
</md-filled-text-field>

<!-- With error -->
<md-outlined-text-field
  label="Password"
  type="password"
  error
  error-text="Password must be at least 8 characters"
  min-length="8">
</md-outlined-text-field>

<!-- Textarea -->
<md-outlined-text-field
  label="Message"
  type="textarea"
  rows="4"
  max-length="500">
</md-outlined-text-field>
```

**Customize**: `--md-outlined-text-field-container-shape`, `--md-outlined-text-field-focus-outline-color`, `--md-filled-text-field-container-color`

#### Jetpack Compose

Use **`OutlinedTextField`** / **`TextField`** from **`androidx.compose.material3`**. Prefer **state-based** APIs (`TextFieldState`, `rememberTextFieldState()`) when targeting current Material3 releases — see the [package overview](https://developer.android.com/reference/kotlin/androidx/compose/material3/package-summary). Map labels, supporting text, and error state to MD3 roles (`MaterialTheme.colorScheme`, `TextFieldDefaults`).

```kotlin
// Illustrative — API names vary slightly by Material3 version
val state = rememberTextFieldState("")

OutlinedTextField(
    state = state,
    label = { Text("Email") },
    supportingText = { if (isError) Text("Invalid email") },
    isError = isError,
    modifier = Modifier.fillMaxWidth()
)
```

### Date Picker
**No @material/web element yet.** Three configurations:
- **Docked**: Inline calendar attached to input
- **Modal**: Full dialog for date selection
- **Range**: Select a date range

### Time Picker
**No @material/web element yet.** Two configurations:
- **Docked**: Inline time input
- **Modal**: Clock dial in dialog

## Navigation

### App Bar (Top)
**No @material/web element yet.** Four variants:

| Variant | Height | Title position | Scroll behavior |
|---------|--------|---------------|----------------|
| Center-aligned | 64dp | Center | Elevate on scroll |
| Small | 64dp | Left | Elevate on scroll |
| Medium | 112dp | Left, bottom | Collapse to small on scroll |
| Large | 152dp | Left, bottom | Collapse to small on scroll |

**Jetpack Compose:** `TopAppBar`, `CenterAlignedTopAppBar`, `MediumTopAppBar`, `LargeTopAppBar`, and expressive variants (e.g. large flexible) may require **`@OptIn(ExperimentalMaterial3ExpressiveApi::class)`** depending on BOM — check your `material3` version.

```html
<header class="md3-top-app-bar md3-top-app-bar--small">
  <md-icon-button aria-label="Menu"><md-icon>menu</md-icon></md-icon-button>
  <span class="md3-top-app-bar__title" style="font: var(--md-sys-typescale-title-large)">
    Page Title
  </span>
  <md-icon-button aria-label="Search"><md-icon>search</md-icon></md-icon-button>
  <md-icon-button aria-label="More"><md-icon>more_vert</md-icon></md-icon-button>
</header>
```

```css
.md3-top-app-bar {
  height: 64px;
  padding: 0 4px;
  display: flex;
  align-items: center;
  gap: 4px;
  background: var(--md-sys-color-surface);
  color: var(--md-sys-color-on-surface);
}
.md3-top-app-bar__title { flex: 1; padding: 0 12px; }
/* Scrolled state */
.md3-top-app-bar--scrolled { background: var(--md-sys-color-surface-container); }
```

### Navigation Bar
**Element**: `md-navigation-bar` | **Import**: `@material/web/navigation/navigation-bar.js`
**Use when**: 3–5 primary destinations, mobile/compact screens, persistent.

```html
<md-navigation-bar>
  <md-navigation-tab label="Home" active>
    <md-icon slot="active-icon">home</md-icon>
    <md-icon slot="inactive-icon">home</md-icon>
  </md-navigation-tab>
  <md-navigation-tab label="Explore">
    <md-icon slot="active-icon">explore</md-icon>
    <md-icon slot="inactive-icon">explore</md-icon>
  </md-navigation-tab>
  <md-navigation-tab label="Profile">
    <md-icon slot="active-icon">person</md-icon>
    <md-icon slot="inactive-icon">person</md-icon>
  </md-navigation-tab>
</md-navigation-bar>
```

### Navigation Drawer
**Element**: `md-navigation-drawer` | **Import**: `@material/web/navigation/navigation-drawer.js`
**Use when**: Many destinations, larger screens, can be modal or persistent.

| Attribute | Type | Description |
|-----------|------|-------------|
| `opened` | boolean | Open state |
| `type` | string | `standard` or `modal` |

```html
<md-navigation-drawer opened>
  <div slot="headline">Mail</div>
  <md-list>
    <md-list-item type="button" active>
      <md-icon slot="start">inbox</md-icon>
      Inbox
    </md-list-item>
    <md-list-item type="button">
      <md-icon slot="start">send</md-icon>
      Sent
    </md-list-item>
  </md-list>
</md-navigation-drawer>
```

### Navigation Rail
**No @material/web element yet.** Use when: 3–7 destinations, medium screens (600–839dp), persistent side navigation.

```html
<nav class="md3-nav-rail" aria-label="Main">
  <md-fab size="small" variant="tertiary" aria-label="Compose">
    <md-icon slot="icon">edit</md-icon>
  </md-fab>
  <div class="md3-nav-rail__items">
    <a href="/" class="md3-nav-rail__item md3-nav-rail__item--active" aria-current="page">
      <md-icon>home</md-icon>
      <span>Home</span>
    </a>
    <a href="/search" class="md3-nav-rail__item">
      <md-icon>search</md-icon>
      <span>Search</span>
    </a>
  </div>
</nav>
```

```css
.md3-nav-rail {
  width: 80px;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 12px 0;
  gap: 12px;
  background: var(--md-sys-color-surface);
}
.md3-nav-rail__items { display: flex; flex-direction: column; gap: 12px; }
.md3-nav-rail__item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 4px 0;
  text-decoration: none;
  color: var(--md-sys-color-on-surface-variant);
  font: var(--md-sys-typescale-label-medium);
}
.md3-nav-rail__item--active { color: var(--md-sys-color-on-surface); }
```

### Search
**No @material/web element yet.** Two patterns:
- **Search bar**: Persistent search field in top app bar area
- **Search view**: Expandable search overlay with suggestions

**I/O 2026 note:** Expressive search and search app bar guidance adds a refreshed visual style, motion, and more flexible trailing icon behavior. In Jetpack Compose, use the current Material3 search APIs and expressive app bar variants where available. On web, implement search as a custom component using MD3 shape, color, spacing, and motion tokens.

### Tabs
**Elements**: `md-tabs`, `md-primary-tab`, `md-secondary-tab`
**Import**: `@material/web/tabs/tabs.js`, `@material/web/tabs/primary-tab.js`, `@material/web/tabs/secondary-tab.js`

| Variant | Element | Use |
|---------|---------|-----|
| Primary | `md-primary-tab` | Top-level navigation within a page |
| Secondary | `md-secondary-tab` | Sub-sections within primary tabs |

```html
<md-tabs>
  <md-primary-tab active>
    <md-icon slot="icon">flight</md-icon>
    Flights
  </md-primary-tab>
  <md-primary-tab>
    <md-icon slot="icon">hotel</md-icon>
    Hotels
  </md-primary-tab>
  <md-primary-tab>
    <md-icon slot="icon">explore</md-icon>
    Explore
  </md-primary-tab>
</md-tabs>
```

**A11y**: Tab set has built-in tablist role. Connect tabs to panels with `aria-controls`.

### Toolbar
**No @material/web element yet.** Displays frequently used actions relevant to current page context. Typically placed below top app bar or in contextual positions.

## Data Display

### List
**Elements**: `md-list`, `md-list-item`
**Import**: `@material/web/list/list.js`, `@material/web/list/list-item.js`

**I/O 2026 note:** Expressive lists add more vibrant styles and flexible item configurations. In Compose, prefer Material3 list patterns and keep spacing, leading/trailing content, supporting text, and dividers token-driven. On web, `md-list` is useful for standard lists; custom CSS may be needed for expressive list treatments.

| Attribute (list-item) | Type | Description |
|----------------------|------|-------------|
| `type` | string | `text` (default), `button`, `link` |
| `href` | string | URL (when type="link") |
| `disabled` | boolean | Disabled state |

```html
<md-list>
  <!-- One-line -->
  <md-list-item>Single line item</md-list-item>

  <!-- Two-line with icon -->
  <md-list-item>
    <md-icon slot="start">person</md-icon>
    <div slot="headline">Jane Smith</div>
    <div slot="supporting-text">Senior Developer</div>
  </md-list-item>

  <!-- Three-line -->
  <md-list-item>
    <md-icon slot="start">mail</md-icon>
    <div slot="headline">Meeting notes</div>
    <div slot="supporting-text">Please review the attached notes from today's standup meeting and provide feedback.</div>
    <div slot="trailing-supporting-text">3 min ago</div>
  </md-list-item>

  <md-divider></md-divider>

  <!-- Clickable item -->
  <md-list-item type="button" onclick="handleClick()">
    <md-icon slot="start">settings</md-icon>
    <div slot="headline">Settings</div>
    <md-icon slot="end">chevron_right</md-icon>
  </md-list-item>
</md-list>
```

**Slots**: `start` (leading element), `end` (trailing element), `headline` (primary text), `supporting-text` (secondary text), `trailing-supporting-text` (trailing metadata), `overline` (above headline)
