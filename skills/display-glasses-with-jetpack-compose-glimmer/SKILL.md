---
name: display-glasses-with-jetpack-compose-glimmer
description: Provides guidelines for developing projected Android XR apps for display
  glasses using the Jetpack Compose Glimmer UI toolkit. This skill covers foundational
  Glimmer design principles, workflows for implementing Jetpack Compose Glimmer, and
  interaction models for the glasses form factor. Use this skill to build an Android
  XR Augmented Experience app with Jetpack Compose Glimmer that adheres to the Glimmer
  design system for optimized glasses styling.
license: Complete terms in LICENSE.txt
metadata:
  author: Google LLC
  last-updated: '2026-07-02'
  keywords:
  - Jetpack Compose Glimmer
  - audio glasses
  - display glasses
  - Projected Activity
  - GlimmerTheme
  - Additive Display
  - Android XR - Augmented Experiences
triggers:
  - android
  - jetpack
  - compose
---

## Glossary

| Term | Definition |
|---|---|
| **Intelligent Eyewear** | All-day wear, hands-free devices that provide access to information. Equipped with speakers, a camera, and a microphone. Some are audio-only (audio glasses), and some also have a display (display glasses). |
| **Display Glasses** | Audio glasses with the addition of a small, private display for glanceable visuals that harmonize with audio output. |
| **Jetpack Compose Glimmer** | A Compose UI toolkit for building augmented Android XR experiences, optimized for display glasses. It provides components, theming, and behaviors for transparent displays. |
| **Projected Activity (Glasses Activity)** | An Android `Activity` that runs on a host device (phone) but its UI and interactions are projected to a connected, intelligent eyewear device (audio or display glasses). |
| **Projected Device** | An XR device connected to an Android-powered device (host). Host projects the application content to the Projected device and let users interact with it. |
| **GlimmerTheme** | The root provider for styling tokens, including GlimmerColors, GlimmerTypography, and GlimmerShapes. |
| **Additive Display** | A display technology where black (#000000) is rendered as 100% transparent. UI is built by adding light to the environment. Display glasses have an additive display. |
| **Augmented Experiences** | Android XR experiences that enhance a user's focus and presence in the real world. They are lightweight and additive, helping users while they are on-the-go |
| **Visual Angle** | A unit of measurement for perceived size in XR. The minimum readable text size is 0.6 degrees (approx. 18sp at 1 m). |

## Prerequisites

- Mobile project must target `compileSdk` 37 or higher. If the `compileSdk` is lower than 37, increase the `compileSdk` to 37.
- Ensure you are using the latest library dependencies from [Create your first
  activity for intelligent eyewear](https://developer.android.com/develop/xr/jetpack-xr-sdk/ai-glasses/first-activity).

## Core Constraints

- **Don't:** Use `MaterialTheme` or Material Components.
- **Do:** Use `GlimmerTheme` and Jetpack Compose Glimmer Components.
- **Do:** Use `createGoogleSansFlexTypography()` from `androidx.xr.glimmer:glimmer-google-fonts` as the `Typography` value for `GlimmerTheme` to ensure that consistent typography is applied throughout the components.

## Limitations

- Specific hardware device models or their unique capabilities are not detailed.
- **Elevation:** Standard Material 3 shadow or elevation modifiers are not supported. You must use `ShadowScope` or `Depth` tokens from Jetpack Compose Glimmer.
- **Minimum Size:** The absolute minimum size for readable text is 18sp (0.6°). Anything smaller will fail legibility checks.
- **Text Weight:** Avoid "Thin" or "Hairline" weights; they cause shimmering and aliasing on additive AR lenses.

## 1. Set up dependencies

- **Setup Projected Activity:** First, you need to create a new projected activity for your app. If the project doesn't already have one, see [Create
  your first activity for intelligent eyewear](https://developer.android.com/develop/xr/jetpack-xr-sdk/ai-glasses/first-activity). Use [references/projectedcontext-source.md](references/projectedcontext-source.md) to launch the Glasses Projected activity on the Projected Device. Ensure that you specify `xr_projected` for the `android:requiredDisplayCategory` attribute in app manifest to tell the system that this activity will use a projected context to access hardware from a connected device.
- **Mobile App Integration:** If the project contains an existing mobile app, you must create a new Glasses Activity dedicated to rendering Glimmer UI. For detailed configuration, heavily reference [Create your first activity
  for intelligent eyewear](https://developer.android.com/develop/xr/jetpack-xr-sdk/ai-glasses/first-activity). If there isn't already a method to launch the Glasses Activity, add a button to the existing mobile app UI labeled "Launch on Glasses" that uses `ProjectedContext` to launch the Glasses Activity on the glasses. Always keep this button in a highly visible location, such as an overlay Floating Action Button (FAB) or the top navigation bar, to ensure users discover the projection capability. If the glasses aren't connected, disable the button. Don't launch the Glasses Activity on the phone, only on the display glasses. If it makes sense to automatically launch the Glasses Activity without an explicit launch button, then do so.
- **UI Library:** Identify if the project has the `androidx.xr.glimmer:glimmer` library, if not it must be added to the project. See [Declaring Jetpack Compose Glimmer Dependencies](https://developer.android.com/jetpack/androidx/releases/xr-glimmer#declaring_dependencies) to fetch the latest dependency version.
- **Theming:** All Glimmer components must be wrapped within the `GlimmerTheme` composable to ensure correct token resolution.
- **Mandatory black background:** Display glasses use additive displays. Any non-black color in the background blocks the real world. **You must always** set a pure black background (`Modifier.background(Color.Black)`) on the root container of your Projected Activity.
- **Font:** The default font is Google Sans Flex. Use `androidx.xr.glimmer.googlefonts` library with the default type styles unless otherwise specified. Use `createGoogleSansFlexTypography` to create a `Typography` instance with the Google Sans Flex configuration. Provide this `Typography` instance as normal through `GlimmerTheme`. Use [references/glimmersansflextypography-source.md](references/glimmersansflextypography-source.md) for configuration.
- **Hardware Capabilities:** Different types of intelligent eyewear devices have different capabilities. To check for these at runtime, see the [Check
  device capabilities at runtime for intelligent eyewear](https://developer.android.com/develop/xr/jetpack-xr-sdk/ai-glasses/check-capabilities).
- **Hardware Permissions:** To request hardware permissions like the microphone and camera, see the [Request hardware permissions for
  intelligent eyewear](references/android/develop/xr/jetpack-xr-sdk/request-hardware-permissions.md).
- **Hardware Access:** To use the glasses camera, sensors, or access the phone's hardware, see the [Use a projected context to access hardware on
  intelligent eyewear](references/android/develop/xr/jetpack-xr-sdk/access-hardware-projected-context.md).

## 2. Minimize and translate the UI

- For display glasses, build UI using components from the Jetpack Compose Glimmer framework.
- Use depth to communicate element priority and hierarchy.
- Design from the bottom up, trying to minimize how much of the real world you cover. Always bottom align UI to the glasses display.
- **One Thing at a Time:** Prioritize the user's awareness of the real world. Show only one primary piece of information at a time (for example, using a `Stack`) to minimize obstruction of the user's field of view. Avoid multiple simultaneous cards.
- **Color Contrast:** Ensure at least a 70% tone difference between foreground and background using the HCT color space. For calculation metrics, use [references/material-hct-source.md](references/material-hct-source.md).

## 3. Map input controls

- Map app interactions, such as tap and swipe, to the available hardware controls on the glasses, such as the touchpad.
- Inputs are more 1-dimensional; users typically make one control input at a time.
- Avoid nesting scrolling controls.
- Jetpack Compose Glimmer components are designed to work with standard input methods, such as a tap or swipe on the glasses' touchpad.
- Use System Back to dismiss temporary states or detailed views.
- To add input, focus, tap, swipe to your Glasses UI, follow [Focus in Jetpack
  Compose Glimmer](references/android/develop/xr/jetpack-xr-sdk/jetpack-compose-glimmer/focus.md).
  - For a detailed breakdown of hardware inputs, see [Hardware Controls for
    display glasses](references/android/design/ui/ai-glasses/guides/interaction/inputs.md)

## 4. Build with Jetpack Compose Glimmer

Jetpack Compose Glimmer is the UI toolkit for building augmented experiences on
display glasses.

### Key Features

- **Glimmer Theming:** A simplified glasses-specific theme for optimal visibility.
- **Pre-compatible Input:** Supports tap and swipe by default.
- **Pre-built Components:** Provides optimized composables like `Card`, `ListItem`, `Button`, etc.

### Focus Management in Glimmer

- Jetpack Compose Glimmer uses a one-dimensional focus search.
- Focus movement is continuous for scrollable containers and discrete for elements like a row of buttons.
- To enable the system to automatically set initial focus, you must set the `isInitialFocusOnFocusableAvailable` flag to `true` in your activity's `onCreate` method. For more information on how to implement, see [Focus in
  Jetpack Compose Glimmer](references/android/develop/xr/jetpack-xr-sdk/jetpack-compose-glimmer/focus.md).

### Implementing Glimmer Styles

Glimmer styles are accessed through the `GlimmerTheme` object. Use
[references/glimmertheme-source.md](references/glimmertheme-source.md) for reference.

| Category | Token | Value / Role |
|---|---|---|
| **Color** | primary | #9BBFFF (Focal color) |
| **Color** | secondary | #4C88E9 (Focal color) |
| **Color** | surface | #262626 (Transparent base - renders as transparent) |
| **Color** | outline | #606460 (3.dp border color) |
| **Shape** | Standard | `RoundedCornerShape(36.dp)` |
| **Shape** | Small | `RoundedCornerShape(12.dp)` |

#### Typography Scale (Google Sans Flex)

**Strict default:** When creating Glimmer UI you must use Google Sans Flex
unless a custom brand typeface is explicitly specified.
**Variable Font Settings:** As Google Sans Flex is a variable font, you must
configure the following axes:

- **Roundness (`ROND`):** Always set to `100f` for the signature rounded appearance.
- **Width (`wdth`):** Set to `100f`.
- **Optical Size (`opsz`):** Set to `9f`.
- **Weight (`wght`):** Use specific values for different roles (Title: `725f`, Body: `520f`, Caption: `650f`).

| Style Name | Size / Line-Height | Weight Axis | Width | Roundness | Optical size |
|---|---|---|---|---|---|
| **Title Large** | 30.sp / 36.sp | 725 | 100 | 100 | 9 |
| **Title Medium** | 24.sp / 32.sp | 725 | 100 | 100 | 9 |
| **Title Small** | 20.sp / 28.sp | 725 | 100 | 100 | 9 |
| **Body Large** | 30.sp / 36.sp | 520 | 100 | 100 | 9 |
| **Body Medium** | 24.sp / 32.sp | 520 | 100 | 100 | 9 |
| **Body Small** | 20.sp / 28.sp | 520 | 100 | 100 | 9 |
| **Caption** | 18.sp / 28.sp | 650 | 100 | 100 | 9 |

#### Depth Levels

Simulate depth on display glasses using shadows to establish a sense of
hierarchy through varying levels of emphasis. The Jetpack Compose Glimmer
controls use `DepthEffect` with 5 preset `DepthEffectLevels`. Use
[references/deptheffect-source.md](references/deptheffect-source.md) and
[references/deptheffectlevels-source.md](references/deptheffectlevels-source.md) for reference.

Some examples:

| Level | Usage |
|---|---|
| **level1** | Standard rest state for cards and persistent background UI. |
| **level2** | Standard focus/pressed state for buttons and interactive cards. |
| **ExtraSmall** | 4.dp |

### Implementing Jetpack Compose Glimmer Components

#### Cards

Cards are a fundamental surface-based container in Glimmer used to group related
content, such as text, images, icons and actions into a single focal point. They
establish a clear depth plane (Z-axis) in the Glasses environment, providing a
stable background for text, images, and icons. Never embed a card within a List
Item.

##### Core Implementation Logic

- **Surface Hierarchy:** Cards are designed to sit on a base surface or within a list. They provide an automatic visual feedback when focused if an `onClick` lambda is provided.
- **Interactivity:**
  - **IF** the entire Card serves as a single trigger (e.g., a media item or a setting): **THEN** provide an `onClick` lambda to enable focus effects.
  - **ELSE:** Leave `onClick` as `null` if the Card contains multiple internal interactive elements (like separate buttons or switches) to avoid focus contention.

##### Technical Documentation Links

If you are creating a Glimmer Card component, read the:

- **Developer Guidance:** [Jetpack Compose Glimmer: Cards](references/android/develop/xr/jetpack-xr-sdk/jetpack-compose-glimmer/cards.md)
- **API Source Code:** Use [references/card-source.md](references/card-source.md).
- **Implementation Samples:** Use [references/card-samples-source.md](references/card-samples-source.md). (Basic and Interactive Card usage)

#### Buttons

Buttons are the primary triggers for discrete actions in Glimmer. They are
specifically optimized for the display glasses focus model, where a focus
highlight is added when focus is moved to the button using the touchpad or other
methods.

##### Core Implementation Logic

- There are two types of buttons to choose from in Glimmer:
  - **Standard buttons** (Required text label with optional leading or trailing icons). Use this when there is more space in the UI, or when the meaning of the button isn't clear without text.
  - **Icon buttons** (icon only). Only use icon buttons when the icon is clearly understandable.
- Both icon and standard buttons have default and toggle variants:
  - Default (use for single actions like "buy" or "navigate")
  - Toggle (use for things with selected states like mute buttons)

##### Technical Documentation Links

If you are creating a Glimmer Button component, read the:

- **Developer Guidance:** [Jetpack Compose Glimmer: Buttons](references/android/develop/xr/jetpack-xr-sdk/jetpack-compose-glimmer/buttons.md)
- **API Source Code:** Use [references/button-source.md](references/button-source.md).
- **Implementation Samples:** Use [references/button-samples-source.md](references/button-samples-source.md).

#### Title Chips

Chips are a pill-shaped, specialized labeling component designed to sit above a
`Card` or a group of content to provide a title. Use title chips to display
concise information like a short title, a name, or a status.

##### Guidelines and usage

- **Spatial Spacing:** When using a standalone `TitleChip` above content, you must use `TitleChipDefaults.AssociatedContentSpacing` (8.dp) to maintain the visual hierarchy.
- **Interactivity:** Title chips are purely for informational purposes, they cannot be targeted or activated for navigation.
- **Layout** Always center text in a title chip. Never let the title chip go to two lines, and truncate extra words. Keep the label to three words or less.

##### Technical Documentation Links

If you are creating a Glimmer Title Chip component, read the:

- **Developer Guidance:** [Jetpack Compose Glimmer: Title Chips](references/android/develop/xr/jetpack-xr-sdk/jetpack-compose-glimmer/title-chips.md)
- **API Source Code:** Use [references/titlechip-source.md](references/titlechip-source.md).
- **Implementation Samples:** Use [references/titlechip-samples-source.md](references/titlechip-samples-source.md). (Title Chips above group content)

#### Icons

Icons are visual symbols used to represent concepts, actions, or status in a
concise way. In Glimmer, icons and icon buttons are optimized for the XR
environment, providing clear visibility on additive displays and gaze-responsive
feedback for interactive elements.

##### Guidelines and usage

- **Sizing:** Use predefined `IconSizes` (e.g., Standard, Large) to ensure icons remain legible and meet the minimum touch target requirements for the XR environment.
- **Interactivity:**
  - **If** an icon serves as a trigger: **Then** you must use an `IconButton` to provide the automatic visual feedback and required tap-target padding.
  - **ELSE:** Use a standalone `Icon` for non-interactive indicators or status symbols.
- **Contrast:** **NEVER** use pure black (#000000) for icon tints; always use themed colors or standard Glimmer content colors to ensure the icon is visible against dark or real-world backgrounds.
- **Icon Library** The default icon library is [Material Symbols](https://fonts.google.com/icons?icon.style=Rounded) with 600 weight, Rounded, Unfilled, unless otherwise specified.

##### Technical Documentation Links

If you are creating a Glimmer Icon component, read the:

- **Developer Guidance:** [Jetpack Compose Glimmer: Icons](references/android/develop/xr/jetpack-xr-sdk/jetpack-compose-glimmer/icons.md)
- **API Source Code (Icon):** Use [references/icon-source.md](references/icon-source.md).
- **API Source Code (IconButton):** Use [references/iconbutton-source.md](references/iconbutton-source.md).
- **API Source Code (IconSizes):** Use [references/iconsizes-source.md](references/iconsizes-source.md).

#### Lists

Lists are containers that allow you to navigate between and see multiple items
on glasses. If your use case works with only seeing one item in the list at a
time, use a Glimmer Stack. Use lists with a Title Chip when the list
items are similar in type. Also use a Glimmer Stack if the items are of
different types.

##### Guidelines and usage

- **ListItem Slots:** Use the `ListItem` composable for rows. It provides predefined slots. Use [references/listitem-source.md](references/listitem-source.md) for reference.
- **Visual Consistency:** When building lists of similar items, always use a consistent background color (typically `GlimmerTheme.colors.surface`) and corner radius (standard 36.dp) for every item. Don't vary these unless you are visually grouping different *types* of content.
- **Integrated Title Chips:** Glimmer Lists support integrated title chips. **IF** you need a section header within a list: **THEN** enable the integrated title chip rather than adding a standalone `TitleChip` to maintain spatial consistency.
- **Vertical Arrangement:** ALWAYS use `verticalArrangement =
  Arrangement.spacedBy(20.dp)` for `VerticalList` to ensure visual separation between items on the glasses display.
- Be sure to use the default 20 dp spacing between list items unless otherwise specified.

##### Technical Documentation Links

If you are creating a Glimmer List component, read the:

- **API Source Code (List):** Use [references/list-source.md](references/list-source.md).
- **API Source Code (ListItem):** Use [references/listitem-source.md](references/listitem-source.md).
- **API Source Code (ListState):** Use [references/liststate-source.md](references/liststate-source.md).

#### Stacks

A stack is a collapsed list that only displays one piece of content at a time,
in a stacked visual, such as a card. If it is useful to show more than one item
at a time, use the Glimmer List control. Don't use a title chip with a stack.
If the items are of different types use a stack to show them. If the items are
of the same type, use a list.

##### Guidelines and usage

**Layout tips**

- Stacks accept variable height items.
- Align your stack control with the bottom of the display.
- The stack control must be 66 dp taller than the tallest item in the stack, allowing room for the scrim and minimizing movement when navigating between items.
- **Clipping and Layering:** To ensure that items behind the top item are correctly clipped and hidden, you **must** apply the `.itemDecoration(CardDefaults.shape)` modifier to the `Card` (or relevant container) inside every `item` block.
- **Depth Shadows:** To maintain spatial separation and element priority, utilize Glimmer's `ShadowScope`, `DepthEffect`, or prescribed `DepthEffectLevels` for depth plane scaling.

##### Technical Documentation Links

If you are creating a Glimmer Stack component, read the:

- **API Source Code (Stack):** Use [references/stack-source.md](references/stack-source.md).
- **API Source Code (StackState):** Use [references/stackstate-source.md](references/stackstate-source.md).
- **API Source Code (StackItemScope):** Use [references/stackitemscope-source.md](references/stackitemscope-source.md).

#### Text

In Jetpack Compose Glimmer, the [`Text`](references/android/develop/xr/jetpack-xr-sdk/jetpack-compose-glimmer/text.md) component builds off the Compose
text component, and lets you set various text properties. Be sure to choose a
style from the `GlimmerTheme` for your text. Modify the theme for your
application if you want custom typography.

##### Essential Constraint: Glimmer Text versus Material Text

On transparent Display Glasses (additive displays), standard Material `Text`
resolves to dark foreground tokens which render as transparent and invisible.
Glimmer `Text` intelligently manages theme color matching. When no manual color
override is specified, Glimmer `Text` automatically defaults to the content
color provided by the nearest Glimmer surface.

- **Don't:** Use Material Text
- **Do:** Use Glimmer Text

#### Surface

`Surface` is a fundamental building block in Glimmer. Use
[references/surface-source.md](references/surface-source.md) for reference.

A surface represents a distinct visual area or 'physical' boundary for
components such as buttons and cards. Use it if you need to build a custom
component.

## 5. Integrate with system UI

- For a detailed breakdown of notifications on intelligent eyewear, see [Understand notification behavior for intelligent eyewear](https://developer.android.com/develop/xr/jetpack-xr-sdk/ai-glasses/notifications/behavior) and learn how to [Start a glasses activity on display glasses from a notification](https://developer.android.com/develop/xr/jetpack-xr-sdk/ai-glasses/notifications/start-activity).

## Contract
- Inputs: Android project context and the skill's target surface (Compose, Play, profiling, security, etc.).
- Outputs: concrete, API-accurate Android guidance and code that matches official Android docs for the skill topic.
- Failure modes: outdated AGP/API assumptions, inventing SDK APIs, or applying mobile guidance to non-Android targets.

## Output Format
1. State the target Android surface and constraints.
2. Provide the minimal correct implementation or migration steps.
3. Call out version requirements, common pitfalls, and verification.

## Anti-Patterns
- Do not invent Jetpack/Play/Compose APIs or dependency coordinates.
- Do not hardcode secrets, signing keys, or production package names from examples into real apps.
- Do not skip version/AGP compatibility checks.
- Do not treat sample emails or demo identities as real credentials.
