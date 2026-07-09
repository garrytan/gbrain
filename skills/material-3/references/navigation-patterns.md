# MD3 Navigation Patterns

Guide for choosing and implementing Material Design 3 navigation components.

## Jetpack Compose (primary)

Use **`androidx.compose.material3`**: `NavigationBar`, `NavigationRail`, `NavigationDrawerItem`, `ModalNavigationDrawer`, `DismissibleNavigationDrawer`, `PermanentNavigationDrawer`, `NavigationBarItem`, `NavigationRailItem`, top app bars (`TopAppBar`, `CenterAlignedTopAppBar`, `LargeTopAppBar`, expressive variants per BOM), and **`Scaffold`** (`bottomBar`, `floatingActionButton`, `snackbarHost`).

Wire destinations with **Navigation Compose** (`NavHost`, `composable`, `rememberNavController`). For **adaptive** UIs, use **`calculateWindowSizeClass`**, **`androidx.compose.material3.adaptive`**, or **`currentWindowAdaptiveInfo`** / **`NavigableListDetailPaneScaffold`** (names and packages depend on your BOM — check [Android Developers](https://developer.android.com/jetpack/androidx/releases/compose-material3)).

Material's [I/O 2026 update](https://m3.material.io/blog/whats-new-at-io26) adds expressive/adaptive emphasis:

- Prefer expressive/adaptive scaffolds for mobile, desktop, foldables, watches, and XR rather than scaling one phone navigation model upward.
- Expressive search and search app bars have refreshed visual style, motion, and more flexible trailing icon behavior. Use current Compose Material3 APIs where available; use web/CSS approximations only when targeting web.
- Keep navigation spacing on the 8dp spacing system so rail/drawer/app-bar gaps can adapt by device class and density.

```kotlin
// Conceptual — adapt routes and selection to your app
Scaffold(
    bottomBar = {
        NavigationBar {
            destinations.forEach { dest ->
                NavigationBarItem(
                    selected = currentRoute == dest.route,
                    onClick = { navController.navigate(dest.route) },
                    icon = { Icon(dest.icon, contentDescription = dest.label) },
                    label = { Text(dest.label) }
                )
            }
        }
    }
) { innerPadding ->
    NavHost(
        navController = navController,
        startDestination = "home",
        modifier = Modifier.padding(innerPadding)
    ) { /* composable routes */ }
}
```

**Web (limited):** The HTML/`@material/web` sections below remain useful for token-backed sites; [Material Web is maintenance-only](https://m3.material.io/develop/web).

---

## Navigation Component Selection

### Decision Tree

```
How many primary destinations?
├── 2 destinations → Tabs (primary)
├── 3–5 destinations
│   ├── Compact screen (<600dp) → Navigation Bar (bottom)
│   ├── Medium screen (600–839dp) → Navigation Rail (side)
│   └── Expanded+ screen (840dp+) → Navigation Drawer (side) or Rail
├── 6+ destinations
│   ├── Compact → Navigation Drawer (modal)
│   ├── Medium → Navigation Drawer (standard) or Rail + overflow menu
│   └── Expanded+ → Navigation Drawer (standard)
└── Hierarchical (nested sections)
    └── Navigation Drawer with sections
```

### Quick Reference

| Component | Destinations | Screen Size | Persistence | Position |
|-----------|-------------|-------------|-------------|----------|
| Navigation Bar | 3–5 | Compact | Persistent | Bottom |
| Navigation Rail | 3–7 | Medium | Persistent | Side (start) |
| Navigation Drawer | Unlimited | Expanded+ | Standard or Modal | Side (start) |
| Tabs | 2+ related views | Any | Persistent | Top (below app bar) |
| Bottom App Bar | — (contextual actions) | Compact | Persistent | Bottom |

## Navigation Bar

**Use when**: 3–5 primary destinations on compact (mobile) screens.
**Position**: Bottom of screen, always visible.

### Anatomy
- Fixed at bottom, full width
- 3–5 navigation items with icon + label
- Active item shows filled icon + indicator pill
- Height: 80dp

### Implementation

```html
<md-navigation-bar active-index="0">
  <md-navigation-tab label="Home" active-icon="home" inactive-icon="home">
    <md-icon slot="active-icon">home</md-icon>
    <md-icon slot="inactive-icon">home</md-icon>
  </md-navigation-tab>
  <md-navigation-tab label="Search">
    <md-icon slot="active-icon">search</md-icon>
    <md-icon slot="inactive-icon">search</md-icon>
  </md-navigation-tab>
  <md-navigation-tab label="Notifications">
    <md-icon slot="active-icon">notifications</md-icon>
    <md-icon slot="inactive-icon">notifications</md-icon>
  </md-navigation-tab>
  <md-navigation-tab label="Profile">
    <md-icon slot="active-icon">person</md-icon>
    <md-icon slot="inactive-icon">person</md-icon>
  </md-navigation-tab>
</md-navigation-bar>
```

### Styling

```css
md-navigation-bar {
  --md-navigation-bar-container-color: var(--md-sys-color-surface-container);
}
```

### Guidelines
- Always show labels (don't use icon-only)
- Use filled icons for active state, outlined for inactive
- Don't use for fewer than 3 or more than 5 destinations
- Hide on scroll down in content-heavy screens (optional)
- Elevation level 2 (3dp)

## Navigation Rail

**Use when**: 3–7 primary destinations on medium screens (tablets).
**Position**: Start edge (left in LTR), always visible.

### Anatomy
- Width: 80dp
- Optional FAB at top
- Navigation items vertically stacked
- Active item shows indicator pill

### Implementation

```html
<nav class="md3-nav-rail" aria-label="Main navigation">
  <!-- Optional FAB -->
  <md-fab size="small" variant="tertiary" aria-label="Compose">
    <md-icon slot="icon">edit</md-icon>
  </md-fab>

  <div class="md3-nav-rail__items" role="tablist">
    <a href="/" class="md3-nav-rail__item" role="tab" aria-selected="true" aria-current="page">
      <div class="md3-nav-rail__indicator">
        <md-icon>home</md-icon>
      </div>
      <span class="md3-nav-rail__label">Home</span>
    </a>
    <a href="/search" class="md3-nav-rail__item" role="tab" aria-selected="false">
      <div class="md3-nav-rail__indicator">
        <md-icon>search</md-icon>
      </div>
      <span class="md3-nav-rail__label">Search</span>
    </a>
    <a href="/settings" class="md3-nav-rail__item" role="tab" aria-selected="false">
      <div class="md3-nav-rail__indicator">
        <md-icon>settings</md-icon>
      </div>
      <span class="md3-nav-rail__label">Settings</span>
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
  border-right: 1px solid var(--md-sys-color-outline-variant);
}

.md3-nav-rail__items {
  display: flex;
  flex-direction: column;
  gap: 12px;
  align-items: center;
}

.md3-nav-rail__item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  text-decoration: none;
  color: var(--md-sys-color-on-surface-variant);
  font: var(--md-sys-typescale-label-medium);
  cursor: pointer;
  width: 56px;
}

.md3-nav-rail__indicator {
  width: 56px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--md-sys-shape-corner-full);
}

.md3-nav-rail__item[aria-selected="true"] .md3-nav-rail__indicator {
  background: var(--md-sys-color-secondary-container);
  color: var(--md-sys-color-on-secondary-container);
}

.md3-nav-rail__item[aria-selected="true"] {
  color: var(--md-sys-color-on-surface);
}
```

### Guidelines
- Align items to top (below optional FAB)
- Show labels always (optional to hide, but recommended to show)
- FAB at top is optional but common
- Elevation level 0

## Navigation Drawer

**Use when**: Many destinations, expanded screens, or deep hierarchies.
**Position**: Start edge, standard (persistent) or modal (overlay).

### Standard Drawer (Persistent)

Always visible alongside content. Width: 360dp.

```html
<div class="md3-layout">
  <md-navigation-drawer opened>
    <div slot="headline">App Name</div>
    <md-list>
      <md-list-item type="button" active>
        <md-icon slot="start">inbox</md-icon>
        <div slot="headline">Inbox</div>
        <div slot="trailing-supporting-text">24</div>
      </md-list-item>
      <md-list-item type="button">
        <md-icon slot="start">send</md-icon>
        <div slot="headline">Sent</div>
      </md-list-item>
      <md-divider></md-divider>
      <md-list-item type="button">
        <md-icon slot="start">drafts</md-icon>
        <div slot="headline">Drafts</div>
      </md-list-item>
    </md-list>
  </md-navigation-drawer>
  <main class="md3-content">
    <!-- Page content -->
  </main>
</div>
```

### Modal Drawer (Overlay)

Overlays content with a scrim. Used on smaller screens or when content space is limited.

```html
<md-navigation-drawer type="modal" id="nav-drawer">
  <!-- Same content as standard -->
</md-navigation-drawer>

<script>
  // Toggle drawer
  document.getElementById('menu-btn').addEventListener('click', () => {
    const drawer = document.getElementById('nav-drawer');
    drawer.opened = !drawer.opened;
  });
</script>
```

### Guidelines
- Standard drawer uses `surface-container` background
- Modal drawer has elevation level 1 and scrim overlay
- Group destinations with dividers and section headers
- Active item uses `secondary-container` background
- Shape: `large` on end corners (right edge in LTR)

## Top App Bar

**Use when**: Every screen needs a title and optional actions.

**I/O 2026 note:** Search app bars are part of the current expressive search guidance. In Compose, check your Material3 BOM for expressive app bar and search APIs before hand-rolling. For web, combine a token-backed top app bar with a custom search field/view because Material Web does not expose full expressive search parity.

### Variants

| Variant | Title | Height | Scroll Behavior |
|---------|-------|--------|----------------|
| Center-aligned | Center | 64dp | Elevates to level 2 on scroll |
| Small | Start-aligned | 64dp | Elevates to level 2 on scroll |
| Medium | Bottom, start-aligned | 112dp | Collapses to 64dp on scroll |
| Large | Bottom, start-aligned | 152dp | Collapses to 64dp on scroll |

### Implementation

```html
<!-- Small app bar -->
<header class="md3-top-app-bar">
  <md-icon-button aria-label="Open menu">
    <md-icon>menu</md-icon>
  </md-icon-button>
  <h1 class="md3-top-app-bar__title">Page Title</h1>
  <md-icon-button aria-label="Search">
    <md-icon>search</md-icon>
  </md-icon-button>
  <md-icon-button aria-label="More options">
    <md-icon>more_vert</md-icon>
  </md-icon-button>
</header>

<!-- Medium app bar (collapsed state shown; expand on scroll-to-top) -->
<header class="md3-top-app-bar md3-top-app-bar--medium">
  <div class="md3-top-app-bar__row">
    <md-icon-button aria-label="Back"><md-icon>arrow_back</md-icon></md-icon-button>
    <span class="md3-top-app-bar__title-collapsed"></span>
    <md-icon-button aria-label="More"><md-icon>more_vert</md-icon></md-icon-button>
  </div>
  <div class="md3-top-app-bar__expanded-title">
    <h1>Page Title</h1>
  </div>
</header>
```

```css
.md3-top-app-bar {
  display: flex;
  align-items: center;
  height: 64px;
  padding: 0 4px;
  background: var(--md-sys-color-surface);
  color: var(--md-sys-color-on-surface);
}

.md3-top-app-bar__title {
  flex: 1;
  padding: 0 12px;
  font: var(--md-sys-typescale-title-large);
  margin: 0;
}

/* Scrolled state: elevate */
.md3-top-app-bar--scrolled {
  background: var(--md-sys-color-surface-container);
}
```

### Scroll Behavior

```javascript
// Elevate app bar on scroll
const appBar = document.querySelector('.md3-top-app-bar');
window.addEventListener('scroll', () => {
  appBar.classList.toggle('md3-top-app-bar--scrolled', window.scrollY > 0);
});
```

## Tabs

**Use when**: Switching between related content at the same hierarchy level.

### Primary vs Secondary

- **Primary tabs**: Top-level content switching (Flights / Hotels / Explore)
- **Secondary tabs**: Sub-sections within primary content

```html
<!-- Primary tabs -->
<md-tabs>
  <md-primary-tab active>
    <md-icon slot="icon">flight</md-icon>
    Flights
  </md-primary-tab>
  <md-primary-tab>Hotels</md-primary-tab>
  <md-primary-tab>Car Rental</md-primary-tab>
</md-tabs>

<!-- Secondary tabs (nested under primary) -->
<md-tabs>
  <md-secondary-tab active>Overview</md-secondary-tab>
  <md-secondary-tab>Reviews</md-secondary-tab>
  <md-secondary-tab>Photos</md-secondary-tab>
</md-tabs>
```

### Tab + Panel Connection

```html
<md-tabs id="my-tabs">
  <md-primary-tab id="tab-1" aria-controls="panel-1" active>Tab 1</md-primary-tab>
  <md-primary-tab id="tab-2" aria-controls="panel-2">Tab 2</md-primary-tab>
</md-tabs>

<div id="panel-1" role="tabpanel" aria-labelledby="tab-1">
  Panel 1 content
</div>
<div id="panel-2" role="tabpanel" aria-labelledby="tab-2" hidden>
  Panel 2 content
</div>

<script>
  document.getElementById('my-tabs').addEventListener('change', (e) => {
    // Hide all panels
    document.querySelectorAll('[role="tabpanel"]').forEach(p => p.hidden = true);
    // Show selected panel
    const activeTab = e.target.querySelector('[active]');
    const panelId = activeTab.getAttribute('aria-controls');
    document.getElementById(panelId).hidden = false;
  });
</script>
```

## Responsive Navigation Pattern

The key MD3 pattern: navigation component transforms across breakpoints.

### Mobile → Tablet → Desktop

```
Compact (<600dp):   Navigation Bar (bottom)
Medium (600–839dp): Navigation Rail (side)
Expanded (840dp+):  Navigation Drawer (side, standard)
```

### CSS Implementation

```css
/* Hide all nav variants by default */
.md3-nav-bar,
.md3-nav-rail,
.md3-nav-drawer { display: none; }

/* Compact: show bottom navigation bar */
@media (max-width: 599px) {
  .md3-nav-bar { display: flex; }
  .md3-app { flex-direction: column; }
}

/* Medium: show navigation rail */
@media (min-width: 600px) and (max-width: 839px) {
  .md3-nav-rail { display: flex; }
  .md3-app { flex-direction: row; }
}

/* Expanded+: show navigation drawer */
@media (min-width: 840px) {
  .md3-nav-drawer { display: flex; }
  .md3-app { flex-direction: row; }
}
```

### Complete Responsive Shell

```html
<div class="md3-app">
  <!-- Navigation drawer (expanded+) -->
  <aside class="md3-nav-drawer">
    <md-navigation-drawer opened>
      <div slot="headline">My App</div>
      <md-list>
        <md-list-item type="button" active>
          <md-icon slot="start">home</md-icon>Home
        </md-list-item>
        <md-list-item type="button">
          <md-icon slot="start">search</md-icon>Search
        </md-list-item>
        <md-list-item type="button">
          <md-icon slot="start">settings</md-icon>Settings
        </md-list-item>
      </md-list>
    </md-navigation-drawer>
  </aside>

  <!-- Navigation rail (medium) -->
  <nav class="md3-nav-rail" aria-label="Main">
    <md-fab size="small" aria-label="New"><md-icon slot="icon">add</md-icon></md-fab>
    <a class="md3-nav-rail__item active"><md-icon>home</md-icon><span>Home</span></a>
    <a class="md3-nav-rail__item"><md-icon>search</md-icon><span>Search</span></a>
    <a class="md3-nav-rail__item"><md-icon>settings</md-icon><span>Settings</span></a>
  </nav>

  <!-- Main content -->
  <main class="md3-main">
    <header class="md3-top-app-bar">
      <md-icon-button class="md3-menu-btn" aria-label="Menu"><md-icon>menu</md-icon></md-icon-button>
      <h1 class="md3-top-app-bar__title">Home</h1>
    </header>
    <div class="md3-body">
      <!-- Page content -->
    </div>
  </main>

  <!-- Navigation bar (compact) -->
  <md-navigation-bar class="md3-nav-bar">
    <md-navigation-tab label="Home" active>
      <md-icon slot="active-icon">home</md-icon>
      <md-icon slot="inactive-icon">home</md-icon>
    </md-navigation-tab>
    <md-navigation-tab label="Search">
      <md-icon slot="active-icon">search</md-icon>
      <md-icon slot="inactive-icon">search</md-icon>
    </md-navigation-tab>
    <md-navigation-tab label="Settings">
      <md-icon slot="active-icon">settings</md-icon>
      <md-icon slot="inactive-icon">settings</md-icon>
    </md-navigation-tab>
  </md-navigation-bar>
</div>
```

```css
.md3-app {
  display: flex;
  min-height: 100vh;
  background: var(--md-sys-color-surface);
  color: var(--md-sys-color-on-surface);
}

.md3-main { flex: 1; display: flex; flex-direction: column; }
.md3-body { flex: 1; padding: 16px; }

/* Compact */
@media (max-width: 599px) {
  .md3-app { flex-direction: column; }
  .md3-nav-rail, .md3-nav-drawer { display: none; }
  .md3-nav-bar { display: flex; order: 1; }
  .md3-menu-btn { display: none; }
}

/* Medium */
@media (min-width: 600px) and (max-width: 839px) {
  .md3-nav-bar, .md3-nav-drawer { display: none; }
  .md3-nav-rail { display: flex; }
  .md3-menu-btn { display: none; }
}

/* Expanded+ */
@media (min-width: 840px) {
  .md3-nav-bar, .md3-nav-rail { display: none; }
  .md3-nav-drawer { display: flex; }
  .md3-menu-btn { display: none; }
}
```
