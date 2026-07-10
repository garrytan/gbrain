Styles differ from modifiers by design. Styles don't replace modifiers; instead,
the two systems coexist with different goals. Internally, a Style is a modifier.
You can do everything Styles can do with modifiers, but not all functionality in
modifiers is available in Styles.
**Important:**

- **Choose Styles if:** You need to override a default of an existing component, perform high-performance animations, or define a theme-wide set of properties for a component.
- **Choose Modifiers if:** You need to add behavior (for example, clickable, gestures), define unique one-off layouts, or need additive properties.

The following is a comparison between Styles versus modifiers:

| Feature | Modifiers | Styles |
|---|---|---|
| **Primary Goal** | Define behaviors, semantics, and complex layouts. Modifiers manipulate individual elements on the fly for a particular composable and don't trickle down from the theme. | Define visual appearance, individual item sizing and themeable properties. Styles operate at a theme level and are over-writeable at a component level. They trickle down and apply styling across different composables. |
| **Logic** | Additive - the modifiers combine together to form a new result. | Over-writable - the last property set in the Style wins. Styles act as a single layer of properties that override each other based on a defined precedence hierarchy. |
| **Theming** | Challenging to lift into a theme, normally used individually. | By design, Styles are themeable (they can access `CompositionLocal`s) and can be defined once and used across components. |
| **Performance** | Updates often require all three phases of Compose: composition, layout and draw. Achieving good animation performance of modifiers often requires writing lambda-based versions. | Skips composition phase, only active in layout and draw phase, reducing recompositions. Requires less object allocation. |
| **Animations** | Requires using separate animation primitives like `animate*AsState` | Features built-in `animate { }` API that handles some animations for you. |

## Limitations of modifiers

Modifiers have many benefits in the current Compose landscape. However, Styles
address some limitations of modifiers, which the following list describes:

- Modifiers are typically created in the Composition phase. Updates can force a full rerun of Composition, Layout, and Draw, even for small visual changes like color, unless you create lambda-based modifiers.
- Conditional modifiers require disruptive if-else logic within fluent chains. Animating them requires manual state boilerplate and lacks a high-performance "auto-animate" mechanism.
- Modifiers stack rather than replace. You can't override a component's default border; you can only draw a second one on top.
- Modifiers are difficult to abstract into global themes. Consequently, themes usually store raw values instead of reusable modifier configurations.

## Limitations of Styles

While Styles can fill in some of the gaps that modifiers have, they also have
some limitations, which show how they cannot entirely replace modifiers:

- Styles are specialized Modifiers. While a modifier can do anything a Style does, the reverse is not true. Consequently, Styles can supplement, but cannot replace, modifiers.
- Styles are limited to visual configuration (backgrounds, padding, borders). They cannot handle behaviors like click logic, gesture detection, or accessibility semantics.
- Resolving a Style into its final state is *more expensive than applying a
  single modifier*. The system must generate a data structure containing all possible property values, and the lookup of inherited properties further complicates this.

## When to use Styles over modifiers

While the choice to use Styles is largely dependent on your app and use cases,
the following guidance helps determine when to prefer a style over a modifier:

- **To achieve theme-wide consistency:** Styles are designed to be "lifted" into a global theme. Instead of passing repetitive Modifiers to every component, you can define a single Style in your theme to create a unified look across the entire app.
- **When performing frequent animations:** Styles evaluate during the Layout and Draw phases, allowing properties like color or scale to animate while bypassing the Composition phase entirely. This significantly reduces performance overhead. Use a Style instead of a modifier when doing visual property animations.
- **Overriding vs. stacking:** Use Styles when you need to replace a default property. Modifiers are additive (adding a border stacks a second one), whereas Styles use "last-write-wins" logic, making it easier to swap out backgrounds or padding without visual clutter.
- **Customizing Material components:** If a Material component provides a Style parameter, it is the suggested approach for customization. These styles allow you to access and modify specific properties within the composable's internal structure that might otherwise be inaccessible.