---
title: "Button text update."
type: note
created: 2023-05-04
updated: 2023-05-04
source: chatgpt-export
conversation_id: 85b0ff88-6f4a-4262-a34f-e7d105d2779f
message_count: 2
tags: [chatgpt, import, code]
---
# Button text update.

> Conversation ID: 85b0ff88-6f4a-4262-a34f-e7d105d2779f
> Created: 2023-05-04T19:04:28Z
> Updated: 2023-05-04T19:04:44Z
> Messages: 2

---

## User

 <ButtonGroup
        type="submit"
        :loading="updating"
        text="Save"
        @click="updateTeamSettings()"
        :disabled="updating"
        class="rounded-md bg-indigo-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600">
      </ButtonGroup>

change the text to saving when updating is true

---

## Assistant

To change the text to "saving" when the `updating` variable is true, you can modify the `text` prop of the `ButtonGroup` component using a ternary operator:

```
<ButtonGroup
  type="submit"
  :loading="updating"
  :text="updating ? 'Saving' : 'Save'"
  @click="updateTeamSettings()"
  :disabled="updating"
  class="rounded-md bg-indigo-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600">
</ButtonGroup>
```

Here, if the `updating` variable is true, the `text` prop will be set to "Saving", otherwise it will be set to "Save".


## See Also
- [[chatgpt/chatgpt_16x16-icon-in-button]]
- [[chatgpt/chatgpt_add-button-features-vlink]]
- [[chatgpt/chatgpt_age-field-update-issue-part1]]
- [[chatgpt/chatgpt_age-field-update-issue-part2]]
- [[chatgpt/chatgpt_ai-coding-tools-update]]
