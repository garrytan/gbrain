### 1. Analysis scope

**Action:** Use find files and examine all XML layout files within the project (typically located in `res`directories). For each file, parse the view hierarchy and metadata.

### 2. Selection criteria

Prioritize layouts that meet the following criteria:

- **Hierarchy depth:** Target **leaf nodes** or components at the bottom of the UI tree.
- **Complexity:** Select layouts with the **smallest number of nested children** and minimal logic.
- **State management:** Prioritize **stateless** components or those with the fewest UI state variables.
- **Dependency footprint:** Identify layouts with **zero to minimal external UI dependencies**.
- **Isolation:** Focus on **self-contained** components that do not rely heavily on parent context or complex data binding.

### 3. Risk assessment

Evaluate the migration risk based on:
\* **Reusability:** Find layouts with **minimum reuse** across the project to limit regression impact.
\* **Accessibility:** Ensure the layout has an **easily accessible entry point** (e.g., used in a simple Activity, Fragment, or as a standalone include).

*** ** * ** ***

## Output requirements

Provide a ranked list of the top 3-5 candidates. For each candidate, include:
1. **File path:** (e.g., `res/layout/item_user_profile.xml`)
2. **Rationale:** Why this is a good candidate based on the provided criteria.
3. **Complexity score:** A rating from 1-5 (1 being simplest).
4. **Dependency count:** List of custom/external views found within.

**Action:** If you support user interaction, ask the user to choose which XML to proceed with. Else proceed with the best option, based on the previous criteria.