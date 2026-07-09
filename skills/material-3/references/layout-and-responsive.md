# MD3 Layout and Responsive Design

Reference for Material Design 3's layout system: breakpoints, canonical layouts, and responsive implementation.

## Jetpack Compose and Android

The **breakpoint table** below is a **design** reference. In **Jetpack Compose**, prefer **`calculateWindowSizeClass`** (`androidx.compose.material3:material3-window-size-class`) and/or **`androidx.compose.material3.adaptive`** APIs (e.g. `currentWindowAdaptiveInfo`, list-detail scaffolds) instead of hand-rolling raw `BoxWithConstraints` width checks everywhere.

**Edge-to-edge:** Use **`enableEdgeToEdge()`** on your `Activity` (AndroidX) when you draw behind the system bars. Apply **`WindowInsets`** (`Modifier.statusBarsPadding()`, `navigationBarsPadding()`, **`imePadding()`**, `displayCutoutPadding()`, etc.) and **`Scaffold`** `contentWindowInsets` so content and **IME** behave correctly.

**Foldables:** Use **`WindowInfoTracker`**, **`FoldingFeature`**, or Jetpack WindowManager APIs — see the foldable section below; verify APIs against your dependency versions.

---

## Google I/O 2026: Expressive Layout

Material's [I/O 2026 update](https://m3.material.io/blog/whats-new-at-io26) introduced broader expressive/adaptive layout guidance:

- **Expressive layout scaffold**: Design screens to adapt across mobile, desktop, foldables, watches, XR, and other spatial form factors. In Compose, prefer Material3 adaptive scaffolds and window size classes over hard-coded phone/tablet branches.
- **8dp spacing system**: Treat spacing as tokens. Use an 8dp scale for margins, padding, gaps, and component spacing so density and device-class changes can be applied consistently.
- **Watch guidance**: Use physics-based motion, arc text styles, and edge-hugging containers. Avoid shrinking phone layouts onto a round or compact wearable screen.
- **XR guidance**: Use spatial panels and depth-based elevation. Avoid treating XR as only a larger desktop canvas; account for depth, comfort, and panel placement.

### Spacing Token Pattern

Define spacing once, then map it to context:

```kotlin
object MdSpacing {
    val xxs = 4.dp
    val xs = 8.dp
    val sm = 16.dp
    val md = 24.dp
    val lg = 32.dp
    val xl = 48.dp
}
```

Use spacing tokens for:
- Screen margins
- Pane gaps
- List item spacing
- Card internal padding
- Component groups and toolbars

Do not scatter raw `Dp` literals throughout reusable UI. Keep one-off values local only when they are truly component-specific.

---

## Window Size Classes

MD3 defines 5 breakpoint classes:

| Class | Width Range | Typical Devices | Columns |
|-------|-----------|----------------|---------|
| Compact | < 600dp | Phone portrait | 4 |
| Medium | 600–839dp | Tablet portrait, foldable | 8 |
| Expanded | 840–1199dp | Tablet landscape, small desktop | 12 |
| Large | 1200–1599dp | Desktop | 12 |
| Extra-large | 1600dp+ | Ultra-wide, large desktop | 12 |

### CSS Media Queries (web)

Use these for **CSS layouts**. **Compose** apps should use window size classes / adaptive APIs rather than duplicating this logic only in CSS.

```css
/* Compact (default — mobile-first) */
/* No media query needed, this is the base */

/* Medium */
@media (min-width: 600px) { }

/* Expanded */
@media (min-width: 840px) { }

/* Large */
@media (min-width: 1200px) { }

/* Extra-large */
@media (min-width: 1600px) { }
```

### dp to px Conversion
On the web, 1dp ≈ 1px at standard density. The breakpoint values translate directly to CSS pixels.

## Layout Anatomy

### Key Terms

- **Window**: The visible area of the app
- **Pane**: A layout container within the window. A pane is fixed, flexible, floating, or semi-permanent
- **Column**: A vertical content block within a pane
- **Margin**: Space between screen edge and content
- **Gutter**: Space between columns
- **Spacer**: Space between panes (in multi-pane layouts)

### Margin and Gutter Values

| Window Size | Margins | Gutters |
|-------------|---------|---------|
| Compact | 16dp | 8dp |
| Medium | 24dp | 16dp |
| Expanded | 24dp | 16dp |
| Large | 24dp | 24dp |
| Extra-large | 24dp | 24dp |

## Canonical Layouts

MD3 defines 3 canonical layouts as starting points. Always begin from one of these rather than from a raw grid.

### Feed Layout

**Use when**: Displaying a large collection of browsable items (social feed, news, product grid).

```
Compact:    Single column of cards
Medium:     2-column grid
Expanded:   3-column grid
Large:      4-column grid + optional side panel
```

```html
<div class="md3-feed">
  <div class="md3-feed__item">
    <!-- Card content -->
  </div>
  <div class="md3-feed__item">
    <!-- Card content -->
  </div>
  <!-- More items -->
</div>
```

```css
.md3-feed {
  display: grid;
  gap: 8px;
  padding: 16px;
  grid-template-columns: 1fr; /* Compact: 1 column */
}

@media (min-width: 600px) {
  .md3-feed {
    grid-template-columns: repeat(2, 1fr);
    gap: 16px;
    padding: 24px;
  }
}

@media (min-width: 840px) {
  .md3-feed {
    grid-template-columns: repeat(3, 1fr);
  }
}

@media (min-width: 1200px) {
  .md3-feed {
    grid-template-columns: repeat(4, 1fr);
    gap: 24px;
  }
}
```

### List-Detail Layout

**Use when**: Browsing a list of items where each has detailed content (email, file browser, contacts).

```
Compact:    List view OR detail view (navigate between them)
Medium:     Side-by-side list (1/3) + detail (2/3)
Expanded:   Side-by-side with wider detail pane
```

```html
<div class="md3-list-detail">
  <aside class="md3-list-detail__list">
    <md-list>
      <md-list-item type="button" class="active">
        <div slot="headline">Item 1</div>
        <div slot="supporting-text">Description</div>
      </md-list-item>
      <md-list-item type="button">
        <div slot="headline">Item 2</div>
        <div slot="supporting-text">Description</div>
      </md-list-item>
    </md-list>
  </aside>
  <main class="md3-list-detail__detail">
    <h2>Item 1 Detail</h2>
    <p>Full content here...</p>
  </main>
</div>
```

```css
.md3-list-detail {
  display: flex;
  flex-direction: column;
  min-height: 100%;
}

.md3-list-detail__list {
  background: var(--md-sys-color-surface-container);
  border-radius: var(--md-sys-shape-corner-large);
  overflow: auto;
}

.md3-list-detail__detail {
  flex: 1;
  padding: 24px;
}

/* Compact: show one at a time */
@media (max-width: 599px) {
  .md3-list-detail__detail { display: none; }
  .md3-list-detail--detail-active .md3-list-detail__list { display: none; }
  .md3-list-detail--detail-active .md3-list-detail__detail { display: block; }
}

/* Medium+: side by side */
@media (min-width: 600px) {
  .md3-list-detail {
    flex-direction: row;
    gap: 24px;
    padding: 24px;
  }
  .md3-list-detail__list {
    width: 360px;
    flex-shrink: 0;
  }
}

/* Expanded: wider detail */
@media (min-width: 840px) {
  .md3-list-detail__list {
    width: 400px;
  }
}
```

### Drag Handle for Resizable Panes

In list-detail and supporting pane layouts, users can resize panes with a drag handle:

```html
<div class="md3-list-detail">
  <aside class="md3-list-detail__list">...</aside>
  <div class="md3-drag-handle" role="separator" aria-orientation="vertical" tabindex="0"></div>
  <main class="md3-list-detail__detail">...</main>
</div>
```

```css
.md3-drag-handle {
  width: 4px;
  cursor: col-resize;
  background: transparent;
  position: relative;
}
.md3-drag-handle::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 4px;
  height: 24px;
  background: var(--md-sys-color-outline);
  border-radius: 2px;
}
```

### Supporting Pane Layout

**Use when**: Primary content needs supplementary information (document + properties panel, video + comments).

```
Compact:    Stacked — primary on top, supporting below (or bottom sheet)
Medium:     Side-by-side (2/3 primary + 1/3 supporting)
Expanded:   Same but with more space
```

```html
<div class="md3-supporting-pane">
  <main class="md3-supporting-pane__primary">
    <!-- Primary content (2/3) -->
  </main>
  <aside class="md3-supporting-pane__secondary">
    <!-- Supporting content (1/3) -->
  </aside>
</div>
```

```css
.md3-supporting-pane {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 16px;
}

/* Medium+: side by side */
@media (min-width: 600px) {
  .md3-supporting-pane {
    flex-direction: row;
    gap: 24px;
    padding: 24px;
  }
  .md3-supporting-pane__primary { flex: 2; }
  .md3-supporting-pane__secondary { flex: 1; }
}
```

## CSS Container Queries

For component-level responsive behavior (independent of viewport), use container queries:

```css
/* Define a container */
.md3-card-container {
  container-type: inline-size;
  container-name: card;
}

/* Respond to container width */
@container card (min-width: 400px) {
  .md3-card {
    flex-direction: row; /* Horizontal layout when container is wide */
  }
}

@container card (max-width: 399px) {
  .md3-card {
    flex-direction: column; /* Vertical layout when narrow */
  }
}
```

## Adaptive Component Behavior

Components transform across breakpoints:

| Component | Compact | Medium (incl. foldable unfolded) | Expanded+ / Large screen |
|-----------|---------|--------|-----------|
| Navigation | Bottom bar | Side rail | Side drawer |
| App bar | Small (64dp) | Small (64dp) | Small or Medium (112dp) |
| Dialog | Full-screen | Centered dialog | Centered dialog (max 560dp wide) |
| Bottom sheet | Full height | Partial height | Side sheet |
| Search | Full-screen search view | Persistent search bar | Persistent search bar |
| Cards | Full-width single column | Multi-column grid | Multi-column grid (max 4 cols) |
| Content panes | Single pane | Optional second pane | Two or three panes |
| Input method | Touch only | Touch + stylus | Touch + mouse/trackpad + keyboard |

## Complete App Layout Example

```html
<div class="md3-app-layout">
  <!-- Navigation (responsive — see navigation-patterns.md) -->
  <nav class="md3-nav" aria-label="Main navigation">
    <!-- Nav content varies by breakpoint -->
  </nav>

  <!-- Main area -->
  <div class="md3-main-area">
    <!-- Top app bar -->
    <header class="md3-top-app-bar">
      <h1 class="md3-top-app-bar__title">Dashboard</h1>
    </header>

    <!-- Content area with canonical layout -->
    <main class="md3-content-area">
      <!-- Use feed, list-detail, or supporting pane here -->
    </main>
  </div>
</div>
```

```css
.md3-app-layout {
  display: flex;
  min-height: 100vh;
  background: var(--md-sys-color-surface);
  color: var(--md-sys-color-on-surface);
}

.md3-main-area {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0; /* Prevent flex overflow */
}

.md3-content-area {
  flex: 1;
  overflow-y: auto;
}

/* Compact: stack vertically */
@media (max-width: 599px) {
  .md3-app-layout { flex-direction: column; }
  .md3-content-area { padding: 16px; }
}

/* Medium */
@media (min-width: 600px) and (max-width: 839px) {
  .md3-content-area { padding: 24px; }
}

/* Expanded+ */
@media (min-width: 840px) {
  .md3-content-area { padding: 24px; }
}

/* Large+: constrain max content width */
@media (min-width: 1200px) {
  .md3-content-area {
    max-width: 1040px;
    margin: 0 auto;
    padding: 24px;
  }
}
```

## Foldables and Large Screens

MD3 provides specific guidance for foldable devices, tablets, and large-screen form factors. These are first-class targets in Material Design 3 — not afterthoughts.

### Foldable Postures

Foldable devices introduce postures that don't exist on traditional phones:

| Posture | Description | Layout behavior |
|---------|-------------|----------------|
| **Flat (unfolded)** | Device fully open, single large screen | Treat as Medium or Expanded window class based on width |
| **Half-opened (tabletop)** | Folded ~90° horizontally, bottom half on table | Split content at the hinge — video/image on top half, controls/info on bottom half |
| **Half-opened (book)** | Folded ~90° vertically, held like a book | Split content at the hinge — list on one side, detail on the other |
| **Folded** | Device closed, outer/cover screen | Treat as Compact — show essential content only |

### Hinge-Aware Layouts

The fold/hinge is a physical divider. Never place interactive content or critical information across the hinge area.

**Web — CSS Viewport Segments API:**

```css
/* Detect a dual-screen / foldable device with two horizontal segments */
@media (horizontal-viewport-segments: 2) {
  .md3-list-detail {
    flex-direction: row;
  }
  .md3-list-detail__list {
    /* Span the left segment */
    width: env(viewport-segment-width 0 0);
    margin-right: env(viewport-segment-left 1 0, 0px) - env(viewport-segment-right 0 0, 0px);
  }
  .md3-list-detail__detail {
    flex: 1;
  }
}

/* Detect tabletop posture (two vertical segments) */
@media (vertical-viewport-segments: 2) {
  .md3-media-player {
    display: flex;
    flex-direction: column;
  }
  .md3-media-player__video {
    height: env(viewport-segment-height 0 0);
  }
  .md3-media-player__controls {
    flex: 1;
  }
}
```

**Flutter — `MediaQuery` and display features:**

```dart
Widget build(BuildContext context) {
  final displayFeatures = MediaQuery.of(context).displayFeatures;
  final hinge = displayFeatures.whereType<DisplayFeature>().where(
    (f) => f.type == DisplayFeatureType.hinge || f.type == DisplayFeatureType.fold,
  ).firstOrNull;

  if (hinge != null) {
    // Foldable device — split at the hinge
    return TwoPane(
      startPane: ListPane(),
      endPane: DetailPane(),
      paneProportion: 0.5,
      panePriority: isPortrait ? TwoPanePriority.start : TwoPanePriority.both,
    );
  }

  // Single screen — use window size class
  final width = MediaQuery.sizeOf(context).width;
  if (width < 600) return CompactLayout();
  if (width < 840) return MediumLayout();
  return ExpandedLayout();
}
```

**Jetpack Compose — `WindowInfoTracker` and `FoldingFeature`:**

```kotlin
@Composable
fun AdaptiveLayout() {
    val windowInfo = WindowInfoTracker.getOrCreate(LocalContext.current)
        .windowLayoutInfo(LocalContext.current as Activity)
        .collectAsState(initial = WindowLayoutInfo(emptyList()))

    val foldingFeature = windowInfo.value.displayFeatures
        .filterIsInstance<FoldingFeature>()
        .firstOrNull()

    when {
        foldingFeature != null && foldingFeature.state == FoldingFeature.State.HALF_OPENED -> {
            // Tabletop or book posture
            if (foldingFeature.orientation == FoldingFeature.Orientation.HORIZONTAL) {
                TabletopLayout(foldingFeature)  // top: content, bottom: controls
            } else {
                BookLayout(foldingFeature)  // left: list, right: detail
            }
        }
        else -> {
            // Standard adaptive layout based on window size class
            val windowSizeClass = calculateWindowSizeClass(LocalContext.current as Activity)
            StandardAdaptiveLayout(windowSizeClass)
        }
    }
}
```

### Tabletop Posture Pattern

When the device is in tabletop posture (horizontal fold, bottom half resting on a surface), the content naturally divides into two halves:

```
┌─────────────────────┐
│                     │  ← Top half: visual content
│   Video / Image /   │     (camera viewfinder, video player,
│   Primary content   │      image gallery, map)
│                     │
├─ ─ ─ hinge ─ ─ ─ ─ ┤
│                     │  ← Bottom half: controls & info
│  Controls / Text /  │     (playback controls, chat input,
│  Supporting info    │      product details, toolbar)
│                     │
└─────────────────────┘
```

### Book Posture Pattern

When the device is in book posture (vertical fold, held like a book), it naturally maps to list-detail:

```
┌──────────┬──────────┐
│          │          │
│  List /  │  Detail  │
│  Nav /   │  Content │
│  Browse  │  / Edit  │
│          │          │
└──────────┴──────────┘
         hinge
```

### Large Screen Layout Guidance

For tablets, Chromebooks, desktop, and large foldables (Expanded, Large, Extra-large):

**Content width constraints:**
- Don't stretch content to fill ultra-wide screens — reading lines longer than ~80 characters become hard to scan
- Constrain body content to a max width (typically 840–1040dp) and center it
- Use the extra space for multi-pane layouts, not wider single columns

```css
/* Constrain content on large screens */
@media (min-width: 1200px) {
  .md3-content-area {
    max-width: 1040px;
    margin-inline: auto;
  }
}
```

**Multi-pane strategies by window class:**

| Window class | Columns | Recommended layout |
|-------------|---------|-------------------|
| Compact (<600dp) | 4 | Single pane. Full-screen navigation between views. |
| Medium (600–839dp) | 8 | Optional second pane. List-detail with narrow list. Rail navigation. |
| Expanded (840–1199dp) | 12 | Two panes standard. List-detail or supporting pane. Drawer navigation. |
| Large (1200–1599dp) | 12 | Two or three panes. Feed with side panel. Persistent supporting pane. |
| Extra-large (1600dp+) | 12 | Three panes or constrained two-pane with generous margins. |

**Input and interaction differences:**
- Large screens often have mouse/trackpad input — hover states and right-click menus matter
- Touch targets remain 48dp minimum but can be supplemented with hover tooltips
- Keyboard shortcuts become expected on desktop-class devices
- Drag-and-drop is more natural on large screens

```css
/* Add hover states for pointer devices */
@media (hover: hover) {
  .md3-card:hover {
    background: color-mix(
      in srgb,
      var(--md-sys-color-on-surface) 8%,
      var(--md-sys-color-surface)
    );
  }

  .md3-list-item:hover {
    background: color-mix(
      in srgb,
      var(--md-sys-color-on-surface) 8%,
      transparent
    );
  }
}

/* Ensure pointer-specific affordances */
@media (pointer: fine) {
  /* Scrollbars, resize handles, tighter spacing are acceptable */
  .md3-drag-handle { cursor: col-resize; }
}
```

**Flutter — adaptive input:**

```dart
Widget build(BuildContext context) {
  final width = MediaQuery.sizeOf(context).width;
  final isLargeScreen = width >= 840;

  return Scaffold(
    body: Row(
      children: [
        // Navigation adapts
        if (isLargeScreen)
          NavigationRail(
            destinations: destinations,
            selectedIndex: selectedIndex,
            onDestinationSelected: onSelected,
            labelType: NavigationRailLabelType.all,
            leading: FloatingActionButton(
              onPressed: onCompose,
              child: const Icon(Icons.edit),
            ),
          ),
        // Content fills remaining space
        Expanded(
          child: isLargeScreen
              ? Row(
                  children: [
                    SizedBox(width: 360, child: ListPane()),
                    const VerticalDivider(width: 1),
                    Expanded(child: DetailPane()),
                  ],
                )
              : selectedItem == null
                  ? ListPane()
                  : DetailPane(),
        ),
      ],
    ),
    bottomNavigationBar: isLargeScreen
        ? null
        : NavigationBar(
            destinations: destinations.map((d) =>
              NavigationDestination(icon: d.icon, label: d.label)).toList(),
            selectedIndex: selectedIndex,
            onDestinationSelected: onSelected,
          ),
  );
}
```

### Foldable-Aware Canonical Layouts

The three canonical layouts adapt naturally to foldables:

| Layout | Foldable behavior |
|--------|------------------|
| **Feed** | Unfolded: multi-column grid fills both halves. Tabletop: grid on top, selected item preview on bottom. |
| **List-detail** | Book posture: list on left half, detail on right half — a perfect natural fit. Tabletop: list on top, detail on bottom. |
| **Supporting pane** | Book posture: primary on left, supporting on right. Tabletop: primary on top, supporting controls on bottom. |

### Testing Large Screens and Foldables

**Web:**
- Use Chrome DevTools responsive mode to test at 600, 840, 1200, and 1600px breakpoints
- Test with pointer: coarse (touch) and pointer: fine (mouse) media queries
- Verify content doesn't stretch beyond readable line lengths at 1600px+

**Flutter:**
- Use `DevicePreview` package to simulate foldables and tablets
- Test with `MediaQuery` overrides for `displayFeatures`
- Run on Android emulators: Pixel Fold, 7.6" foldable, 10" tablet, Chromebook

**Compose:**
- Use Android Studio foldable emulators (Pixel Fold, 7.6" Foldable)
- Test posture changes: flat → half-opened → folded
- Use `WindowInfoTracker` to verify fold-aware layout switching

### Audit Checklist for Foldable/Large Screen Support

When auditing, check these specific items:

- [ ] App uses `MediaQuery.sizeOf(context).width` or equivalent to determine window size class
- [ ] Layout switches from single-pane to multi-pane at 600dp
- [ ] Navigation transforms: bottom bar → rail → drawer across breakpoints
- [ ] Content has max-width constraint on large screens (not stretching to fill)
- [ ] No critical content or interactive elements placed across a fold/hinge
- [ ] Foldable postures handled (if targeting foldable devices): tabletop and book modes
- [ ] Hover states exist for pointer devices (`@media (hover: hover)`)
- [ ] Touch targets remain 48dp minimum even on large screens
- [ ] Dialogs are centered (not full-screen) on medium+ screens
- [ ] Bottom sheets convert to side sheets on expanded+ screens

## Spacing System

MD3 uses a 4dp base grid for spacing:

| Use | Values |
|-----|--------|
| Component internal padding | 4, 8, 12, 16, 24dp |
| Between components | 8, 12, 16, 24dp |
| Section spacing | 24, 32, 48dp |
| Layout margins | 16dp (compact), 24dp (medium+) |
| Grid gutters | 8dp (compact), 16dp (medium), 24dp (large+) |

Always use multiples of 4dp for consistent spatial rhythm.
