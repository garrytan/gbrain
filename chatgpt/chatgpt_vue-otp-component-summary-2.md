---
title: "Vue OTP component summary"
type: note
created: 2023-01-03
updated: 2023-01-03
source: chatgpt-export
conversation_id: 51de7e4d-5502-4eca-948a-275d77f26f7d
message_count: 4
tags: [chatgpt, import, code]
---
# Vue OTP component summary

> Conversation ID: 51de7e4d-5502-4eca-948a-275d77f26f7d
> Created: 2023-01-03T01:24:08Z
> Updated: 2023-01-03T01:24:08Z
> Messages: 4

---

## User

<template>
  <div id="otp" class="mt-5 flex flex-row justify-center px-2 text-center">
    <input
      v-for="(digit, index) in code"
      v-model="code[index]"
      @input="focusNextInput"
      :key="'digit' + (index + 1)"
      class="form-control m-2 h-10 w-10 rounded border border-slate-200 text-center font-bold dark:border-jovieDark-border dark:bg-jovieDark-800 dark:text-jovieDark-100 dark:text-jovieDark-200"
      type="text"
      :id="'digit' + index"
      maxlength="1" />
  </div>
</template>

<script>
export default {
  props: {
    otpCode: {
      type: String,
      required: true,
    },
  },
  data() {
    return {
      code: ['', '', '', '', '', ''],
    };
  },
  methods: {
    focusNextInput(event) {
      const input = event.target;
      const nextInput = input.nextElementSibling;
      if (input.value && nextInput) {
        nextInput.focus();
      }
    },
  },
};
</script>


---

## Assistant

This is a Vue.js component that defines an OTP (one-time password) input field. The component is rendered as a `div` element with an `input` element for each digit in the OTP code. The `input` element has a `v-for` directive that iterates over the `code` array and a `v-model` directive that binds the value of the input field to the corresponding element in the `code` array. The `focusNextInput` method is called whenever the user inputs a value into an `input` element, and it focuses the next `input` element in the sequence if the current `input` element has a value.


---

## User

add a hypen between the 3 and 4th inputs. it should not affect focus. and it should not break any code.

---

## Assistant

To add a hyphen between the 3rd and 4th input elements, you can modify the template as follows:

```
<template>
  <div id="otp" class="mt-5 flex flex-row justify-center px-2 text-center">
    <input
      v-for="(digit, index) in code"
      v-model="code[index]"
      @input="focusNextInput"
      :key="'digit' + (index + 1)"
      class="form-control m-2 h-10 w-10 rounded border border-slate-200 text-center font-bold dark:border-jovieDark-border dark:bg-jovieDark-800 dark:text-jovieDark-100 dark:text-jovieDark-200"
      type="text"
      :id="'digit' + index"
      maxlength="1" />
    <template v-if="code[2]">-</template>
  </div>
</template>
```

This will insert a hyphen between the 3rd and 4th input elements if the 3rd input element has a value. It should not affect the focus of the input elements or break any code.
