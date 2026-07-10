## 1. Structural analysis \& mapping

**Identify the precise mapping** between XML elements and Compose equivalents.
You must determine:

- The exact `@Composable` functions (e.g., `ConstraintLayout`, `Column`, `LazyColumn`) that replace the XML tag hierarchy.
- The specific parameters and `Modifier` extensions required to replicate XML attributes (e.g., `layout_width`, `padding`, `elevation`).
- The appropriate state management strategy for interactive elements.

## 2. Migration execution

**Convert the XML layout code to Jetpack Compose**, ensuring the visual
hierarchy and layout logic are preserved while leveraging Compose's declarative
nature.

## 3. Theming \& design system integrity

**Do not use hard-coded values.** Follow these rules for styling:

- **Token Alignment:** Cross-reference XML dimensions, colors, and style attributes with the existing Compose `Theme` (e.g., `MaterialTheme.colorScheme` or custom design system tokens).
- **Reuse over Creation:** If matching values exist in the current Compose theme, reuse them. If a value is missing but required for the design, define it within the theme structure rather than hard-coding it in the Composable.
- **Project Consistency:** You **MUST** strictly adhere to existing code conventions, naming standards, and implementation patterns found in the project. **Prioritize** project-specific reusable components over generic Material defaults.

## 4. Component layering \& reusability

Evaluate if the XML layout serves as a foundation-level design system component
(reused across the app with a distinct role). If it is:

- **Create a reusable composable:** Do not just inline the code. Define a new standalone `@Composable`.
- **Parameterization:** Expose specific parameters for variable data (text, colors, styles) and use `Modifier` for layout-specific customizations.
- **Feature parity \& restriction:** Ensure the new composable enforces the same UI constraints as the original XML component, preventing unauthorized style overrides while maintaining the intended flexibility.

Example before migration:

    <style
        name="Widget.Rounded.Button"
        parent="Widget.Button.Borderless">
        <item name="android:fontFamily">sans-serif-medium</item>
        <item name="android:minWidth">@dimen/min_width</item>
        <item name="android:paddingStart">@dimen/padding_2</item>
        <item name="android:paddingEnd">@dimen/padding_2</item>
        <item name="cornerRadius">8dp</item>
    </style>

Example after migration:


```kotlin
@Composable
fun RoundedBorderlessButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true
) {
    TextButton(
        onClick, modifier
            .defaultMinSize(minWidth = dimensionResource(R.dimen.min_width))
            .padding(
                start = dimensionResource(R.dimen.padding_2),
                end = dimensionResource(R.dimen.padding_2)
            ), enabled, shape = RoundedCornerShape(8.dp),
        colors = ButtonDefaults.textButtonColors(
            contentColor = MaterialTheme.colorScheme.primary
        )
    ) {
        Text(
            text = text,
            style = MaterialTheme.typography.bodyMedium.copy(
                fontFamily = FontFamily.SansSerif,
                fontWeight = FontWeight.Medium
            )
        )
    }
}
```

<br />

*** ** * ** ***

## 5. Output requirements

- Provide the full Kotlin file content.
- Include necessary imports.
- Add documentation comments (`/** ... */`) explaining the mapping logic for complex transformations.