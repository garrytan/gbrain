---
conversation_id: 688461ae-e404-832d-a94c-9eada41ee297
created: 2025-07-26
links:
- '[[chatgpt-clusters/design_ux]]'
message_count: 2
source: chatgpt-export
tags:
- chatgpt
- import
- code
title: Atomic design structure
type: note
updated: 2025-07-26
---

# Atomic design structure

> Conversation ID: 688461ae-e404-832d-a94c-9eada41ee297
> Created: 2025-07-26T05:03:43Z
> Updated: 2025-07-26T05:03:50Z
> Messages: 2

---

## User

Atomic design component folder structure 

---

## Assistant

Here's a recommended **Atomic Design folder structure** for a modern frontend project (like Vue, React, or SwiftUI), following best practices used by YC startups:

---

### 📁 `components/`
```
components/
├── atoms/
│   └── Button.vue
│   └── TextField.vue
│   └── Icon.vue
├── molecules/
│   └── SearchBar.vue
│   └── LabeledInput.vue
├── organisms/
│   └── Navbar.vue
│   └── UserProfileCard.vue
├── templates/
│   └── AuthLayout.vue
│   └── DashboardLayout.vue
├── pages/
│   └── HomePage.vue
│   └── SettingsPage.vue
```

---

### 🔁 Notes:
- **Atoms**: smallest elements, no state (buttons, inputs, icons).
- **Molecules**: simple groups of atoms (input + label).
- **Organisms**: sections of the UI (cards, modals, navbars).
- **Templates**: structure/placement of organisms (layouts).
- **Pages**: full views (route-level components).

---

### ✅ Tips:
- Co-locate tests, styles, and stories (e.g., `Button.vue`, `Button.test.js`, `Button.stories.js`)
- Use index files for clean imports:
  ```
  export { default as Button } from './Button.vue'
  ```

Need the Swift version? Let me know which framework (UIKit, SwiftUI, or others).


**Topic:** [[chatgpt-clusters/design_ux]]
