---
conversation_id: 400ecb35-77eb-435a-b26f-50cab1e55972
created: 2022-12-21
links:
- '[[chatgpt-clusters/coding_web_dev]]'
message_count: 2
source: chatgpt-export
tags:
- chatgpt
- import
- code
title: Tailwind CSS Custom CSS
type: note
updated: 2022-12-21
---

# Tailwind CSS Custom CSS

**Related:** [[coding_web_dev]]

> Conversation ID: 400ecb35-77eb-435a-b26f-50cab1e55972
> Created: 2022-12-21T18:31:15Z
> Updated: 2022-12-21T18:31:15Z
> Messages: 2

---

## User

im using tialwind css but my datepicker has custom css. how can i add the custom css below using @apply in tailwind css

.dp__theme_dark {
  --dp-background-color: #191a22;
  --dp-text-color: #ffffff;
  --dp-hover-color: #484848;
  --dp-hover-text-color: #ffffff;
  --dp-hover-icon-color: #959595;
  --dp-primary-color: #005cb2;
  --dp-primary-text-color: #ffffff;
  --dp-secondary-color: #a9a9a9;
  --dp-border-color: #292b41;
  --dp-menu-border-color: #2d2d2d;
  --dp-border-color-hover: #aaaeb7;
  --dp-disabled-color: #737373;
  --dp-scroll-bar-background: #212121;
  --dp-scroll-bar-color: #484848;
  --dp-success-color: #00701a;
  --dp-success-color-disabled: #428f59;
  --dp-icon-color: #959595;
  --dp-danger-color: #e53935;
  --dp-highlight-color: rgba(80, 0, 178, 0.2);
  --dp-row_margin: 0px 0 !default;
  --dp-common_padding: 0px !default;
  --dp-font_size: 0.5rem !default;

---

## Assistant

You can use the `@apply` directive to apply the styles defined in the `.dp__theme_dark` class to a specific element or class in your Tailwind CSS project. Here's an example of how you might do this:

```css
.my-element {
  @apply .dp__theme_dark;
}
```

This will apply all of the styles defined in the `.dp__theme_dark` class to the `.my-element` class.

Alternatively, you can also apply specific styles from the `.dp__theme_dark` class to your element or class by referencing them individually, like this:

```css
.my-element {
  background-color: var(--dp-background-color);
  color: var(--dp-text-color);
}
```

This will apply only the `background-color` and `color` styles from the `.dp__theme_dark` class to the `.my-element` class.



**Topic:** [[chatgpt-clusters/coding_web_dev]]
