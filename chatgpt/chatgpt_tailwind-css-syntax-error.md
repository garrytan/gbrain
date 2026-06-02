---
conversation_id: e6914f49-cd47-47b3-986a-47c7f3dc6b55
created: 2023-01-22
links:
- '[[chatgpt-clusters/coding_web_dev]]'
message_count: 4
source: chatgpt-export
tags:
- chatgpt
- import
title: 'Tailwind CSS Syntax Error '
type: note
updated: 2023-01-22
---

# Tailwind CSS Syntax Error

**Related:** [[coding_web_dev]]


> Conversation ID: e6914f49-cd47-47b3-986a-47c7f3dc6b55
> Created: 2023-01-22T09:09:45Z
> Updated: 2023-01-22T09:09:45Z
> Messages: 4

---

## User

im getting this error when i run storybook in my vue project

Welcome to Storybook
Storybook helps you build UI components in isolation from your app's business logic, data, and context. That makes it easy to develop hard-to-reach states. Save these UI states as stories to revisit during development, testing, or QA.

Browse example stories now by navigating to them in the sidebar. View their code in the stories directory to learn how they work. We recommend building UIs with a component-driven process starting with atomic components and ending with pages.

CONFIGURE
plugin
Presets for popular tools
Easy setup for TypeScript, SCSS and more.
Build
Build configuration
How to customize webpack and Babel
colors
Styling
How to load and configure CSS libraries
flow
Data
Providers and mocking for data libraries
LEARN
repo
Storybook documentation
Configure, customize, and extend
direction
In-depth guides
Best practices from leading teams
code
GitHub project
View the source and add issues
comments
Discord chat
Chat with maintainers and the community
TipEdit the Markdown in stories/Introduction.stories.mdx
ERROR in ./node_modules/css-loader/dist/cjs.js!./node_modules/postcss-loader/dist/cjs.js!./node_modules/style-loader/dist/cjs.js!./node_modules/css-loader/dist/cjs.js??clonedRuleSet-10.use[1]!./node_modules/tailwindcss/tailwind.css undefined
Module build failed (from ./node_modules/postcss-loader/dist/cjs.js):
SyntaxError

(1:1) /Users/timwhite/Documents/GitHub/Jovie/node_modules/tailwindcss/tailwind.css Unknown word

> 1 | import api from "!../style-loader/dist/runtime/injectStylesIntoStyleTag.js";
    | ^
  2 |             import content from "!!../css-loader/dist/cjs.js??clonedRuleSet-10.use[1]!./tailwind.css";
  3 | 

---

## Assistant

This error message is indicating that there is a problem with your setup of Tailwind CSS in your Vue project. It seems that there is a syntax error in your tailwind.css file. You should check that file and ensure that it is properly formatted and that any imports or exports are set up correctly. Additionally, you might want to check your webpack and postcss configurations to ensure that they are properly set up to handle the tailwind.css file.


---

## User


timwhite@tims-mbp Jovie % npm run storybook             

> storybook
> start-storybook -p 6006

info @storybook/vue3 v6.5.15
info 
✔ Port 6006 is not available. Would you like to run Storybook on port 6007 instead? … yes
info => Loading presets


attention => Storybook now collects completely anonymous telemetry regarding usage.
This information is used to shape Storybook's roadmap and prioritize features.
You can learn more, including how to opt-out if you'd not like to participate in this anonymous program, by visiting the following URL:
https://storybook.js.org/telemetry

info Addon-docs: using MDX1
info => Using PostCSS preset with postcss@8.4.21
info => Using default Webpack5 setup
<i> [webpack-dev-middleware] wait until bundle finished
10% building 0/1 entries 0/0 dependencies 0/0 modules
info => Ignoring cached manager due to change in manager config
<i> [webpack-dev-middleware] wait until bundle finished
<i> [webpack-dev-middleware] wait until bundle finished: /__webpack_hmr
95% emitting emitassets by chunk 6.12 MiB (id hint: vendors)
  assets by status 5.9 MiB [big]
    asset vendors-node_modules_storybook_addon-actions_manager_js-node_modules_storybook_addon-backgrou-076004.manager.bundle.js 4.46 MiB [emitted] [big] (id hint: vendors)
    asset vendors-node_modules_storybook_components_dist_esm_formatter-0d5cb0eb_js.manager.bundle.js 887 KiB [emitted] [big] (id hint: vendors)
    asset vendors-node_modules_storybook_components_dist_esm_OverlayScrollbars-1355f44c_js.manager.bundle.js 295 KiB [emitted] [big] (id hint: vendors)
    asset vendors-node_modules_storybook_components_dist_esm_syntaxhighlighter-b07b042a_js.manager.bundle.js 286 KiB [emitted] [big] (id hint: vendors)
  asset vendors-node_modules_storybook_components_dist_esm_WithTooltip-167e9982_js.manager.bundle.js 126 KiB [emitted] (id hint: vendors)
  asset vendors-node_modules_storybook_components_dist_esm_Color-f953d088_js.manager.bundle.js 82.8 KiB [emitted] (id hint: vendors)
  asset vendors-node_modules_storybook_components_dist_esm_GlobalScrollAreaStyles-8793ce4a_js.manager.bundle.js 15.5 KiB [emitted] (id hint: vendors)
asset runtime~main.manager.bundle.js 14.1 KiB [emitted] (name: runtime~main)
asset index.html 4.5 KiB [emitted]
asset main.manager.bundle.js 1.49 KiB [emitted] (name: main)
asset node_modules_unfetch_dist_unfetch_js.manager.bundle.js 1.26 KiB [emitted]
Entrypoint main [big] 4.48 MiB = runtime~main.manager.bundle.js 14.1 KiB vendors-node_modules_storybook_addon-actions_manager_js-node_modules_storybook_addon-backgrou-076004.manager.bundle.js 4.46 MiB main.manager.bundle.js 1.49 KiB
orphan modules 980 KiB [orphan] 126 modules
runtime modules 8.59 KiB 15 modules
modules by path ./node_modules/ 5.44 MiB 899 modules
./util.inspect (ignored) 15 bytes [built] [code generated]
manager (webpack 5.75.0) compiled successfully in 27639 ms
99% done plugins webpack-hot-middlewarewebpack built preview f0ff21ec90ea2bfb4c27 in 28469ms
WARN Force closed manager build
ModuleBuildError: Module build failed (from ./node_modules/@storybook/addon-postcss/node_modules/postcss-loader/dist/cjs.js):
SyntaxError

(1:1) /Users/timwhite/Documents/GitHub/Jovie/node_modules/tailwindcss/tailwind.css Unknown word

> 1 | import api from "!../style-loader/dist/runtime/injectStylesIntoStyleTag.js";
    | ^
  2 |             import content from "!!../css-loader/dist/cjs.js!../postcss-loader/dist/cjs.js!./tailwind.css";
  3 | 

    at processResult (/Users/timwhite/Documents/GitHub/Jovie/node_modules/webpack/lib/NormalModule.js:758:19)
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/webpack/lib/NormalModule.js:860:5
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/loader-runner/lib/LoaderRunner.js:400:11
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/loader-runner/lib/LoaderRunner.js:252:18
    at context.callback (/Users/timwhite/Documents/GitHub/Jovie/node_modules/loader-runner/lib/LoaderRunner.js:124:13)
    at Object.loader (/Users/timwhite/Documents/GitHub/Jovie/node_modules/@storybook/addon-postcss/node_modules/postcss-loader/dist/index.js:102:7)
ModuleBuildError: Module build failed (from ./node_modules/postcss-loader/dist/cjs.js):
SyntaxError

(1:1) /Users/timwhite/Documents/GitHub/Jovie/node_modules/tailwindcss/tailwind.css Unknown word

> 1 | var api = require("!../@storybook/addon-postcss/node_modules/style-loader/dist/runtime/injectStylesIntoStyleTag.js");
    | ^
  2 |             var content = require("!!../@storybook/addon-postcss/node_modules/css-loader/dist/cjs.js!../@storybook/addon-postcss/node_modules/postcss-loader/dist/cjs.js??clonedRuleSet-10.use[2]!../style-loader/dist/cjs.js!../css-loader/dist/cjs.js!../postcss-loader/dist/cjs.js!./tailwind.css");
  3 | 

    at processResult (/Users/timwhite/Documents/GitHub/Jovie/node_modules/webpack/lib/NormalModule.js:758:19)
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/webpack/lib/NormalModule.js:860:5
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/loader-runner/lib/LoaderRunner.js:400:11
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/loader-runner/lib/LoaderRunner.js:252:18
    at context.callback (/Users/timwhite/Documents/GitHub/Jovie/node_modules/loader-runner/lib/LoaderRunner.js:124:13)
    at reportError (/Users/timwhite/Documents/GitHub/Jovie/node_modules/postcss-loader/dist/utils.js:396:5)
    at Object.loader (/Users/timwhite/Documents/GitHub/Jovie/node_modules/postcss-loader/dist/index.js:112:28)

WARN Broken build, fix the error above.
WARN You may need to refresh the browser.

info => Loading presets
✔ Would you like to send crash reports to Storybook? … yes
39% building 8/15 entries 20/22 dependencies 749/18 modules%   

---

## Assistant

This error message is indicating that there is an issue with the Storybook addon for postcss. It seems that there is a problem with building the postcss module. 
You should check that your postcss configuration is correct and that all dependencies are installed and up-to-date. You might also want to check the version of postcss you are using, as it might not be compatible with the version of @storybook/addon-postcss you are using. It could also be caused by a conflicting configuration in your webpack. You can try removing the addon-postcss or downgrading the version of postcss or webpack.



**Topic:** [[chatgpt-clusters/coding_web_dev]]


## See Also
- [[chatgpt/chatgpt_css-import-syntax-error]]
- [[chatgpt/chatgpt_fix-syntax-error-2]]
- [[chatgpt/chatgpt_fix-syntax-error-3]]
- [[chatgpt/chatgpt_fix-syntax-error]]
- [[chatgpt/chatgpt_syntax-error-in-colordotvue]]
