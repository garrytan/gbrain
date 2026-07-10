When you introduce Compose in an existing app, you need to migrate your Material
XML themes to use `MaterialTheme` for Compose components. This means your app's
theming will have two sources of truth: the View-based theme and the Compose
theme. Any changes to your styling need to be made in multiple places. Once
your app is fully migrated to Compose, remove your XML theming.

You can use the [Material Theme Builder](https://m3.material.io/theme-builder)
tool for migrating colors.

When you start the migration from XML to Compose, migrate the theming to
Material 3 Compose theming.

## Glossary

| Term | Definition |
|---|---|
| `MaterialTheme` | The composable function that provides theming (colors, typography, shapes) to Compose UI components. |
| `Shapes` | A Compose object used to define custom component shapes for a `MaterialTheme`. |
| `Typography` | A Compose object used to define custom text styles (font families, sizes, weights) for a `MaterialTheme`. |
| `ColorScheme` | A Compose object used to define custom color schemes for `MaterialTheme`. |
| XML Theme | The Android theming system defined in XML files, used by the View system. |

## Limitations

Before migrating, be aware of the following limitations:

- This guide focuses on migrating to Material 3 only. For migrating from alternative design systems, see [Material 2](https://developer.android.com/develop/ui/compose/designsystems/material) or [Custom design systems in Compose](https://developer.android.com/develop/ui/compose/designsystems/custom).
- The ultimate goal is a complete migration to Compose, which allows for the removal of XML theming. This guide explains how to migrate, but it doesn't explain how to finally remove XML theming.

## Step 1: Evaluate the design system

Identify which design system is used in the XML View project.
Analyze the migration path and necessary steps to migrate the existing design
system to Material 3 in Compose.

## Step 2: Identify theme source files

In XML you write `?attr/colorPrimary`. In Compose, you access theme values
with `MaterialTheme.*`:

Identify and locate all XML resources and files necessary for theming:
light and dark color schemes and qualifiers, themes, shapes, dimensions,
typography, styles and other relevant files.

Resources such as strings can be reused as is and don't need to be migrated.

## Step 3: Migrate colors

**Key principle:** XML uses named hex colors.
Material 3 uses *semantic roles* (e.g., `primary`, `onPrimary`, `surface`).
Stop naming colors by their hex; name them by their role.

Examples:

| XML color name | Material 3 role |
|---|---|
| `colorPrimary` | `primary` |
| `colorPrimaryDark` / `colorPrimaryVariant` | `primaryContainer` or `secondary` |
| `colorAccent` | `secondary` or `tertiary` |
| `colorOnPrimary` | `onPrimary` |
| `android:colorBackground` | `background` |
| `colorSurface` | `surface` |
| `colorOnSurface` | `onSurface` |
| `colorError` | `error` |
| `colorOnError` | `onError` |
| `colorOutline` | `outline` |
| `colorSurfaceVariant` | `surfaceVariant` |
| `colorOnSurfaceVariant` | `onSurfaceVariant` |

*** ** * ** ***

Migrate the dark and light color schemes from XML to their equivalents in
Material 3 Compose.

> [!NOTE]
> **Note:** Material 3 naming differs from Material 2 color naming.

## Step 4: Migrate custom shapes and typography

- If your app uses custom shapes:

  1. In your Compose code, define a `Shapes` object to replicate your XML shape definitions.
  2. Provide this `Shapes` object to your `MaterialTheme`.

     For more details, see [shapes](https://developer.android.com/develop/ui/compose/designsystems/material3#shapes).
- If your app uses custom typography:

  1. In your Compose code, define a `Typography` object in your Compose code to replicate your XML text styles and font definitions.
  2. Provide this `Typography` object to your `MaterialTheme`.

     For more details, see [typography](https://developer.android.com/develop/ui/compose/designsystems/material3#typography).

| Compose role | XML name |
|---|---|
| `displayLarge` | `TextAppearance.Material3.DisplayLarge` |
| `displayMedium` | `TextAppearance.Material3.DisplayMedium` |
| `displaySmall` | `TextAppearance.Material3.DisplaySmall` |
| `headlineLarge` | `TextAppearance.Material3.HeadlineLarge` |
| `headlineMedium` | `TextAppearance.Material3.HeadlineMedium` |
| `headlineSmall` | `TextAppearance.Material3.HeadlineSmall` |
| `titleLarge` | `TextAppearance.Material3.TitleLarge` |
| `titleMedium` | `TextAppearance.Material3.TitleMedium` |
| `titleSmall` | `TextAppearance.Material3.TitleSmall` |
| `bodyLarge` | `TextAppearance.Material3.BodyLarge` |
| `bodyMedium` | `TextAppearance.Material3.BodyMedium` |
| `bodySmall` | `TextAppearance.Material3.BodySmall` |
| `labelLarge` | `TextAppearance.Material3.LabelLarge` |
| `labelMedium` | `TextAppearance.Material3.LabelMedium` |
| `labelSmall` | `TextAppearance.Material3.LabelSmall` |

## Step 5: Migrate styles (styles.xml)

XML styles (styles.xml) system defines styles and appearance of:

1. Widgets, components, themes for windows and dialogs
2. Typography
3. Themes and overlays
4. Shapes

XML Views and components combine multiple attributes to create a style.
They set their styles from styles.xml in two different ways:

1. Setting "style="@style/..." directly and explicitly in the XML View
2. Setting the style indirectly and implicitly for a component as part of a larger Theme (theme.xml)

Styles have no **direct** equivalent in Compose - instead styles are passed as:
parameters or modifiers to composables, using the
[new, experimental Styles API](https://developer.android.com/develop/ui/compose/styles) defined in the AppTheme, or by creating
layered, reusable composable variations with the defined style.

Provide separate @Composable functions named according to the style and the
base component, to signify the difference in styling and use cases for those
components.

- **Pattern:** If an XML element uses a custom style (e.g., `style="@style/MyPrimaryButton"`), don't try to replicate the style inline. Instead, suggest creating a specific composable.
- **Example:**
  - *XML:* `<Button style="@style/MyPrimaryButton" ... />`
  - *Compose:* `MyPrimaryButton(onClick = { ... })`
- **Common Attribute Groups:** If a style sets common modifiers (like padding + height), extract them into a readable extension property or a shared Modifier variable.

### Common examples

| XML | Compose |
|---|---|
| `Theme.Material3.*` | `MaterialTheme(colorScheme, typography, shapes) { }` |
| `TextAppearance.Material3.BodyMedium` | `TextStyle(...)` defined in `Typography(bodyMedium = ...)` |
| `ShapeAppearance.*.SmallComponent` | `Shapes(small = RoundedCornerShape(X.dp))` |
| `Widget.Material3.Button` | `Button(colors = ButtonDefaults.buttonColors(...))` |
| `Widget.Material3.CardView` | `Card(shape=..., elevation=..., colors=...)` |
| `Widget.*.TextInputLayout.OutlinedBox` | `OutlinedTextField(colors = OutlinedTextFieldDefaults.colors(...))` |
| `Widget.*.Chip.Filter` | `FilterChip(colors = FilterChipDefaults.filterChipColors(...))` |
| `Widget.*.Toolbar.Primary` | `TopAppBar(colors = TopAppBarDefaults.topAppBarColors(...))` |
| `Widget.*.FloatingActionButton` | `FloatingActionButton(containerColor = ...)` |
| `backgroundTint` | `containerColor` in `ComponentDefaults.ComponentColors()` |
| `android:textColor` | `contentColor` in `ComponentDefaults.ComponentColors()` |
| `cornerRadius` | `shape = RoundedCornerShape(X.dp)` |
| `android:elevation` | `elevation = ComponentDefaults.elevation(defaultElevation = X.dp)` |
| `android:padding` | `contentPadding = PaddingValues(...)` or `Modifier.padding()` |
| `android:minHeight` | `Modifier.heightIn(min = X.dp)` |
| `strokeColor` + `strokeWidth` | `border = BorderStroke(width, color)` |
| `android:textSize` | `fontSize = X.sp` in `TextStyle` |

## Step 6: Validate the theme migration

Always use the existing theme values from the original XML theme as the source
of truth for the new Material Theme in Compose.
Never invent new theme values during migration, to maintain brand consistency
and avoid visual regressions.

Verify all new Compose theme values match the existing XML values.
Don't hardcode any migrated values.