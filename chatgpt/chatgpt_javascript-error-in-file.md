---
conversation_id: 6ab73ab9-daf1-4388-ab2f-84204af9e053
created: 2023-03-27
links:
- '[[chatgpt-clusters/coding_web_dev]]'
message_count: 2
source: chatgpt-export
tags:
- chatgpt
- import
title: JavaScript Error in File
type: note
updated: 2023-03-27
---

# JavaScript Error in File

**Related:** [[coding_web_dev]]

> Conversation ID: 6ab73ab9-daf1-4388-ab2f-84204af9e053
> Created: 2023-03-27T05:22:59Z
> Updated: 2023-03-27T05:23:13Z
> Messages: 2

---

## User

Uncaught SyntaxError: Unexpected token '<' (at resources_js_views_Crm_vue.js:1:1)
vendor.js:12056 [Vue Router warn]: uncaught error during route navigation:
warn @ vendor.js:12056
triggerError @ vendor.js:12483
(anonymous) @ vendor.js:12452
Promise.catch (async)
pushWithRedirect @ vendor.js:12452
push @ vendor.js:12445
(anonymous) @ VM154 app.js:145
Promise.then (async)
_callee2$ @ VM154 app.js:145
tryCatch @ VM154 app.js:139
(anonymous) @ VM154 app.js:139
(anonymous) @ VM154 app.js:139
asyncGeneratorStep @ VM154 app.js:140
_next @ VM154 app.js:141
(anonymous) @ VM154 app.js:141
(anonymous) @ VM154 app.js:141
(anonymous) @ VM154 app.js:147
(anonymous) @ vendor.js:12316
(anonymous) @ vendor.js:12312
(anonymous) @ vendor.js:12497
Promise.then (async)
(anonymous) @ vendor.js:12497
runGuardQueue @ vendor.js:12497
(anonymous) @ vendor.js:12459
Promise.then (async)
navigate @ vendor.js:12458
pushWithRedirect @ vendor.js:12452
push @ vendor.js:12445
install @ vendor.js:12492
use @ vendor.js:1365
./resources/js/app.js @ VM154 app.js:129
__webpack_require__ @ manifest.js:2
__webpack_exec__ @ VM154 app.js:409
(anonymous) @ VM154 app.js:410
__webpack_require__.O @ manifest.js:6
webpackJsonpCallback @ manifest.js:16
(anonymous) @ manifest.js:17
(anonymous) @ manifest.js:17
(anonymous) @ manifest.js:17
vendor.js:12484 ChunkLoadError: Loading chunk resources_js_views_Crm_vue failed.
(missing: https://dev.jov.ie/js/resources_js_views_Crm_vue.js)
    at __webpack_require__.f.j (manifest.js:12:790)
    at manifest.js:7:605
    at Array.reduce (<anonymous>)
    at __webpack_require__.e (manifest.js:7:555)
    at Array.map (<anonymous>)
    at webpackAsyncContext (VM154 app.js:408:60)
    at VM154 app.js:149:757
    at extractComponentsGuards (vendor.js:12339:27)
    at vendor.js:12463:142

---

## Assistant

This error message indicates that there is a problem with the JavaScript code in the `resources_js_views_Crm_vue.js` file. Specifically, the error message states that there is an "Unexpected token '<'" at the beginning of the file, which suggests that there may be an HTML or XML tag at the beginning of the file instead of valid JavaScript code.

Additionally, there is a ChunkLoadError reported, which suggests that the file could not be loaded or is missing from the specified URL.

To resolve this issue, you may need to check the `resources_js_views_Crm_vue.js` file to ensure that it contains valid JavaScript code and that there are no HTML or XML tags at the beginning of the file. You should also check that the file is present and accessible at the specified URL.


**Topic:** [[chatgpt-clusters/coding_web_dev]]
