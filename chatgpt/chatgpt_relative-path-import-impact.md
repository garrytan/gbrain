---
title: "Relative Path Import Impact"
type: note
created: 2022-12-23
updated: 2022-12-23
source: chatgpt-export
conversation_id: 200ab141-1287-4ba9-8e6d-9eecf2088e61
message_count: 2
tags: [chatgpt, import]
---
# Relative Path Import Impact

> Conversation ID: 200ab141-1287-4ba9-8e6d-9eecf2088e61
> Created: 2022-12-23T02:49:12Z
> Updated: 2022-12-23T02:49:12Z
> Messages: 2

---

## User

does using "import DataGridCellTextInput from './DataGridCellTextInput.vue';" vs "import DataGridCellTextInput from '../../components/DataGridCellTextInput.vue';" effect performance

---

## Assistant

Using a relative path to import a module or component will not have any impact on the performance of your application. The difference between the two import statements you provided is the location of the `DataGridCellTextInput.vue` file relative to the file that is doing the importing.

Using a relative path, like `'./DataGridCellTextInput.vue'`, means that the `DataGridCellTextInput.vue` file is located in the same directory as the file that is doing the importing. Using a relative path with multiple dots, like `'../../components/DataGridCellTextInput.vue'`, means that the `DataGridCellTextInput.vue` file is located in a directory that is a couple of levels up from the current directory, inside a `components` directory.

In general, it is a good practice to use relative paths for imports, as it makes your code more portable and easier to understand. If you use absolute paths for your imports, you will have to update them if you move the file to a different location in your file hierarchy.

