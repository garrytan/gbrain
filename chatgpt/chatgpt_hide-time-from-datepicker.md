---
title: "Hide time from datepicker"
type: note
created: 2022-12-21
updated: 2022-12-21
source: chatgpt-export
conversation_id: c18c3332-781d-4f7a-a3d5-f168c1857de1
message_count: 2
tags: [chatgpt, import, code]
---
# Hide time from datepicker

> Conversation ID: c18c3332-781d-4f7a-a3d5-f168c1857de1
> Created: 2022-12-21T18:28:24Z
> Updated: 2022-12-21T18:28:24Z
> Messages: 2

---

## User

im using vue3datepicker npm package. how do i hide the time from the date picker

---

## Assistant

To hide the time from the date picker, you can use the `show-time` prop of the `vue3-datepicker` component and set it to `false`. This will hide the time selection from the date picker.

Here is an example of how to use the `show-time` prop to hide the time from the date picker:

```
<template>
  <div>
    <vue3-datepicker v-model="selectedDate" show-time="false" />
  </div>
</template>

<script>
import { Datepicker } from 'vue3-datepicker';

export default {
  components: {
    Datepicker,
  },
  data() {
    return {
      selectedDate: null,
    };
  },
};
</script>
```

This will display the date picker with only the date selection, and the time selection will be hidden.

