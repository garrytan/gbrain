---
title: "Styling Selected Contacts Rows."
type: note
created: 2023-05-28
updated: 2023-05-28
source: chatgpt-export
conversation_id: 7b1aebd5-1238-4c78-91af-c41a586cb06f
message_count: 2
tags: [chatgpt, import, code]
---
# Styling Selected Contacts Rows.

> Conversation ID: 7b1aebd5-1238-4c78-91af-c41a586cb06f
> Created: 2023-05-28T00:03:45Z
> Updated: 2023-05-28T00:03:56Z
> Messages: 2

---

## User

:class="[
        selectedContactsModel.includes(contact.id)
          ? 'bg-blue-50  dark:bg-indigo-950'
          : 'bg-slate-50 dark:bg-jovieDark-700',
        currentContact.id == contact.id
          ? 'bg-slate-200 dark:bg-jovieDark-border '
          : '',
      ]"



If the row is currenct contact and its selected contacts model i want it to be blue-100 and dark:bg-indigo-800

if the row is selected and not current contact i want it to be bluye-50 and dark:bg-indigo-950

if the row is current contact and not selected i want it to be slate-100
and if it is not selected and not current contact i want it to be slate-50

---

## Assistant

Based on your description, here's the modified code:

```javascript
:class="[
  selectedContactsModel.includes(contact.id)
    ? (currentContact.id === contact.id
        ? 'bg-blue-100 dark:bg-indigo-800'
        : 'bg-blue-50 dark:bg-indigo-950')
    : (currentContact.id === contact.id
        ? 'bg-slate-100'
        : 'bg-slate-50 dark:bg-jovieDark-700')
]"
```

Explanation:

- If the `selectedContactsModel` includes the `contact.id`, it means the row is selected.
  - If the `currentContact.id` is equal to `contact.id`, it means it is the current contact. In this case, the class will be `'bg-blue-100 dark:bg-indigo-800'`.
  - If the `currentContact.id` is not equal to `contact.id`, it means it is not the current contact. In this case, the class will be `'bg-blue-50 dark:bg-indigo-950'`.
- If the `selectedContactsModel` does not include the `contact.id`, it means the row is not selected.
  - If the `currentContact.id` is equal to `contact.id`, it means it is the current contact. In this case, the class will be `'bg-slate-100'`.
  - If the `currentContact.id` is not equal to `contact.id`, it means it is not the current contact. In this case, the class will be `'bg-slate-50 dark:bg-jovieDark-700'`.

Please note that this assumes you have defined the CSS classes `bg-blue-100`, `bg-blue-50`, `bg-slate-100`, `bg-slate-50`, `dark:bg-indigo-800`, `dark:bg-indigo-950`, and `dark:bg-jovieDark-700` with the desired background colors in your CSS or styling file.


## See Also
- [[chatgpt/chatgpt_discography-table-styling]]
- [[chatgpt/chatgpt_html-styling-jovies-span]]
- [[chatgpt/chatgpt_masculine-abs-styling]]
- [[chatgpt/chatgpt_styling-refactor-for-ui]]
- [[chatgpt/chatgpt_ui-styling-refactor]]
