## 1. Project health \& build validation

Before performing any analysis, you must confirm the project is in a functional state.
\* **Integrity check:** Verify the project syncs (Gradle) and builds successfully.
\* **Error resolution:** If there are pre-existing build errors or sync failures, you must report these immediately and attempt to fix. **Do not proceed** with migration until a stable baseline is established.

## 2. Compose pattern \& consistency analysis

If Jetpack Compose is already present, you must align with the established implementation style.
\* **Pattern identification:** Scan the codebase for `@Composable` functions. Identify the project's "Best Practices" regarding state hoisting, composable construction and naming conventions, and file organization.
\* **Theming review:** Determine how `MaterialTheme` or custom theme systems are implemented.
\* Identify if the project uses a custom design system theme.
\* Map how attributes, styles, and other theme components are accessed in Compose.

## 3. Design system \& infrastructure audit

Understand the design system classification (e.g. Material 2, Material 3, or custom design system).
\* **Resource mapping:** Locate central XML definitions:
\* `colors.xml` (Light/Dark variants)
\* `dimens.xml`
\* `styles.xml` / `themes.xml`
\* **Hybrid analysis:** Determine if the project is **XML-only** , **Compose-only** , or **Hybrid** .
\* **Reuse constraint:** If a Compose theming layer (e.g., `AppTheme.kt`) already exists, **DO NOT** generate a new one. You must reuse the existing infrastructure and contribute to it by following its existing implementation pattern.

## 4. Candidate layout decomposition

Analyze the specific XML layout targeted for migration. You must extract and document the following requirements for the new composable:
\* **Inputs:** UI State objects, primitive parameters, and click listeners.
\* **Styling:** Specific color constants, typography styles, and shape definitions referenced in the XML.
\* **Resources:** Identifying string resources, drawables, and dimensions.
\* **Layout logic:** Modifiers required to replicate the XML constraints (padding, alignment, weight).

## 5. Architectural \& non-UI analysis

Understand the environment in which the UI resides to ensure proper integration.
\* **State management:** Identify the usage of `ViewModel`, `Flow`, or `LiveData`.
\* **Dependency Injection:** Check for Hilt, Koin, or manual DI to understand how dependencies are provided to the UI layer.
\* **Testing \& architecture:** Note the architectural pattern (MVI, MVVM, or custom architecture setup.) and existing UI testing frameworks to ensure the migrated code remains testable. Unless the user explicitly requests, **DO NOT** make any changes to any non-UI code that aren't strictly required for the migration of the XML View.

*** ** * ** ***

> **Pro-tip:** Always prioritize the "Existing infrastructure" over "Default templates." If the project has a custom way of handling spacing or colors, composable code, or any other project layer, your generated Compose code must reflect that specific implementation.