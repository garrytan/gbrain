---
title: "Vue ModuleNotFound Error Fix"
type: note
created: 2023-02-04
updated: 2023-02-04
source: chatgpt-export
conversation_id: e304b764-6fc9-41f2-a54c-347664ec0827
message_count: 2
tags: [chatgpt, import, code]
---
# Vue ModuleNotFound Error Fix

> Conversation ID: e304b764-6fc9-41f2-a54c-347664ec0827
> Created: 2023-02-04T20:24:00Z
> Updated: 2023-02-04T20:24:00Z
> Messages: 2

---

## User

ModuleNotFoundError: Module not found: Error: Can't resolve '@storybook/vue' in

---

## Assistant

This error message suggests that the "@storybook/vue" module could not be found in your project. This error can occur when the required module is not installed or when it's not listed as a dependency in your project's package.json file. 

To resolve this issue, you should install the "@storybook/vue" package using the following command in your terminal:

```
npm install @storybook/vue
```

If it's already installed, make sure it's listed as a dependency in your project's package.json file.
