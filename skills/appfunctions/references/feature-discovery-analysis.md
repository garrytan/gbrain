Analyzes Android codebases to identify and recommend high-value AppFunctions.

## Instructions

### Workflow: Feature Discovery

1. **Analyze Manifest \& Entry Points** : Scan `AndroidManifest.xml` and Activity, Fragment, Service classes to identify core user journeys (e.g., Search, Create, Share).
2. **Identify Atomic Tasks**: Look for methods or logic that represent distinct, self-contained user outcomes.
3. **Evaluate AI Value**: Prioritize tasks that are frequently used or difficult to navigate using touch UI, but instead be expressed using voice or text (e.g., "Remind me to call Alice when I get home").
4. **Recommend \& Justify**: List recommendations with a "Rationale" focusing on how an AI assistant adds value (efficiency, hands-free use, or multi-step automation).

## Critical Constraints

### Tool-First Thinking

Avoid recommending functions that are purely informational or redundant with
existing system actions. Focus on "mutations" (writing data) or "rich queries"
(finding specific entities).

### Security \& Privacy

Don't recommend exposing functions that handle raw credentials, financial
secrets, or irreversible destructive actions without explicit user confirmation
steps.

## Examples

### Example 1: Media App Discovery

**Recommended AppFunction:** `playArtistRadio`

**Rationale:** Allows users to start a personalized music stream using a
voice command, bypassing several layers of navigation in the "Search" and
"Artist" menus.

**Input Required:** Artist Name (String).