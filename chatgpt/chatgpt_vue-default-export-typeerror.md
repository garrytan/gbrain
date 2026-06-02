---
title: "\"Vue Default Export TypeError\""
type: note
created: 2023-02-05
updated: 2023-02-05
source: chatgpt-export
conversation_id: b42ba47c-6a55-49e2-b687-42bff6d61394
message_count: 2
tags: [chatgpt, import]
---
# "Vue Default Export TypeError"

> Conversation ID: b42ba47c-6a55-49e2-b687-42bff6d61394
> Created: 2023-02-05T03:25:12Z
> Updated: 2023-02-05T03:25:12Z
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

---

## Assistant

This error message is indicating that the default export from the `vue` package is not a constructor. It's likely that the code is trying to instantiate a new Vue component, but the exported value from the `vue` package is not a constructor function. To resolve this error, ensure that the `vue` package is correctly imported and used in your code. If the issue persists, check if you are using the correct version of `vue` and if the package has been installed correctly.


**Topic:** [[chatgpt-clusters/coding_web_dev]]
