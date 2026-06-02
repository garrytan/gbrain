---
conversation_id: ea572200-82e9-4ffd-9320-9186cb3d020c
created: 2023-02-05
links:
- '[[chatgpt-clusters/coding_web_dev]]'
message_count: 2
source: chatgpt-export
tags:
- chatgpt
- import
title: Vue.js Constructor Error Resolve
type: note
updated: 2023-02-05
---

# Vue.js Constructor Error Resolve

**Related:** [[coding_troubleshoot]]

> Conversation ID: ea572200-82e9-4ffd-9320-9186cb3d020c
> Created: 2023-02-05T04:47:27Z
> Updated: 2023-02-05T04:47:27Z
> Messages: 2

---

## User

Uncaught TypeError: vue__WEBPACK_IMPORTED_MODULE_6__.default is not a constructor
    at ./node_modules/@storybook/vue/dist/esm/client/preview/render.js (render.js:20:1)
    at __webpack_require__ (bootstrap:24:1)
    at fn (hot module replacement:62:1)
    at ./node_modules/@storybook/vue/dist/esm/client/preview/index.js (globals.js:4:1)
    at __webpack_require__ (bootstrap:24:1)
    at fn (hot module replacement:62:1)
    at ./node_modules/@storybook/vue/dist/esm/client/index.js (storySort.js:97:1)
    at __webpack_require__ (bootstrap:24:1)
    at fn (hot module replacement:62:1)
    at ./storybook-init-framework-entry.js (storybook.stories.js:18:1)

---

## Assistant

This error message is indicating that an instance of the Vue.js framework is not being properly constructed. It appears to be happening in the render.js file at line 20 in the @storybook/vue package installed in your project. The error message specifically states that the value of vue__WEBPACK_IMPORTED_MODULE_6__.default is not a constructor, which means that it is not a function that can be used to create a new instance of an object.

To resolve this issue, you will need to investigate why vue__WEBPACK_IMPORTED_MODULE_6__.default is not a constructor, and make sure that it is properly imported and instantiated in your code.


**Topic:** [[chatgpt-clusters/coding_web_dev]]


## See Also
- [[chatgpt/chatgpt_resolve-device-info-plus-module-error]]
- [[chatgpt/chatgpt_resolve-layoutsapp-error]]
- [[chatgpt/chatgpt_vue-vite-resolve-error]]
- [[chatgpt/chatgpt_davinci-resolve-mcp]]
- [[chatgpt/chatgpt_davinci-resolve-overview]]
