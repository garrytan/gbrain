---
title: "Vetur Finds tsconfig jsconfig
"
type: note
created: 2023-01-22
updated: 2023-01-22
source: chatgpt-export
conversation_id: 0c0c5ecf-5df1-4872-9e5b-ea5c67814925
message_count: 4
tags: [chatgpt, import, code]
---
# Vetur Finds tsconfig jsconfig


> Conversation ID: 0c0c5ecf-5df1-4872-9e5b-ea5c67814925
> Created: 2023-01-22T19:31:48Z
> Updated: 2023-01-22T19:31:48Z
> Messages: 4

---

## User

Vetur can't find `tsconfig.json` or `jsconfig.json` in /Users/timwhite/Documents/GitHub/Jovie.

---

## Assistant

Vetur is a VSCode extension for providing Vue.js development experience, it requires either `tsconfig.json` or `jsconfig.json` file to be present in the root of the project to work correctly. If it can't find either of these files in the specified directory, it won't be able to provide the expected features. You can create one of these files in the root of your project and configure it according to your project's needs, or you can move your project's files to a location where these files already exist.


---

## User

what should be in my jsconfig.json file if my project is vue 3 with tailwind and laravel mix and storybook

---

## Assistant

A `jsconfig.json` file is used to configure the JavaScript language options for your project in VSCode. If your project is a Vue 3 project that uses Tailwind CSS and Laravel Mix, and you want to use Storybook for building and previewing UI components, your `jsconfig.json` file should include the following:
```
{
  "compilerOptions": {
    "module": "esnext",
    "target": "esnext",
    "experimentalDecorators": true,
    "lib": ["esnext", "dom"],
    "moduleResolution": "node",
    "baseUrl": "./",
    "paths": {
      "@/*": ["src/*"]
    }
  },
  "include": [
    "./src/**/*",
    "./node_modules/@storybook/**/*"
  ]
}
```
This configures the project to use the latest JavaScript features, with support for ES modules and JSX, and allows the use of decorators. It also sets the baseUrl to the root of the project and the paths to the `src` folder, allowing you to use the `@` alias when importing modules. And it includes all files under the `src` folder and the `node_modules/@storybook` folder.

Please note that this is a basic configuration and you may need to adjust it to match the specific needs of your project.



## See Also
- [[chatgpt/chatgpt_01-vs-091-proof]]
- [[chatgpt/chatgpt_1-of-body-weight-part1]]
- [[chatgpt/chatgpt_1-of-body-weight-part2]]
- [[chatgpt/chatgpt_100-mbps-upload-options]]
- [[chatgpt/chatgpt_1001tracklisting-search-query]]
