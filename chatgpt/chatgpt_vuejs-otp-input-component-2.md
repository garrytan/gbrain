---
conversation_id: 9eedfad0-4c45-4d4d-8e4e-23fda80fe758
created: 2023-01-03
links:
- '[[chatgpt-clusters/coding_web_dev]]'
message_count: 5
source: chatgpt-export
tags:
- chatgpt
- import
- code
title: Vue.js OTP Input Component
type: guide
updated: 2023-01-03
---

# Vue.js OTP Input Component

**Related:** [[coding_web_dev]]

> Conversation ID: 9eedfad0-4c45-4d4d-8e4e-23fda80fe758
> Created: 2023-01-03T01:16:04Z
> Updated: 2023-01-03T01:16:04Z
> Messages: 5

---

## User

<template>
  <div id="otp" class="mt-5 flex flex-row justify-center px-2 text-center">
    <input
      v-model="first"
      @input="focusNextInput"
      class="form-control m-2 h-10 w-10 rounded border border-slate-200 text-center font-bold dark:border-jovieDark-border dark:bg-jovieDark-800 dark:text-jovieDark-100 dark:text-jovieDark-200"
      type="text"
      id="first"
      maxlength="1" />
    <input
      v-model="second"
      @input="focusNextInput"
      class="form-control m-2 h-10 w-10 rounded border border-slate-200 text-center font-bold dark:border-jovieDark-border dark:bg-jovieDark-800 dark:text-jovieDark-100 dark:text-jovieDark-200"
      type="text"
      id="second"
      maxlength="1" />
    <input
      v-model="third"
      @input="focusNextInput"
      class="form-control m-2 h-10 w-10 rounded border border-slate-200 text-center font-bold dark:border-jovieDark-border dark:bg-jovieDark-800 dark:text-jovieDark-100 dark:text-jovieDark-200"
      type="text"
      id="third"
      maxlength="1" />
    <span
      class="m-2 mt-3 h-10 items-center text-slate-600 dark:text-jovieDark-300"
      >-</span
    >
    <input
      v-model="fourth"
      @input="focusNextInput"
      class="form-control m-2 h-10 w-10 rounded border border-slate-200 text-center font-bold dark:border-jovieDark-border dark:bg-jovieDark-800 dark:text-jovieDark-100 dark:text-jovieDark-200"
      type="text"
      id="fourth"
      maxlength="1" />
    <input
      v-model="fifth"
      @input="focusNextInput"
      class="form-control m-2 h-10 w-10 rounded border border-slate-200 text-center font-bold dark:border-jovieDark-border dark:bg-jovieDark-800 dark:text-jovieDark-100 dark:text-jovieDark-200"
      type="text"
      id="fifth"
      maxlength="1" />
    <input
      v-model="sixth"
      @input="focusNextInput"
      class="form-control m-2 h-10 w-10 rounded border border-slate-200 text-center font-bold dark:border-jovieDark-border dark:bg-jovieDark-800 dark:text-jovieDark-100 dark:text-jovieDark-200"
      type="text"
      id="sixth"
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
      first: '',
      second: '',
      third: '',
      fourth: '',
      fifth: '',
      sixth: '',
    };
  },
  computed: {
    code: {
      get() {
        return (
          this.first +
          this.second +
          this.third +
          this.fourth +
          this.fifth +
          this.sixth
        );
      },
      set(value) {
        this.first = value[0] || '';
        this.second = value[1] || '';
        this.third = value[2] || '';
        this.fourth = value[3] || '';
        this.fifth = value[4] || '';
        this.sixth = value[5] || '';
      },
    },
  },
  watch: {
    code: {
      handler(value) {
        this.$emit('input', value);
      },
      immediate: true,
    },
  },
  methods: {
    focusNextInput(event) {
      if (event.target.value.length === 1) {
        event.target.nextElementSibling.focus();
      }
    },
    focusPreviousInput(event) {
      if (event.target.value.length === 0) {
        event.target.previousElementSibling.focus();
      }
    },
    codeChanged(value) {
      this.code = value;
    },
  },
};
</script>


---

## Assistant

This is a Vue.js template that defines a component to input one-time password (OTP) code. The component is made up of six `input` elements, each representing a digit in the OTP code. The component also has a `computed` property called `code` that gets and sets the values of the `input` elements as a single string. The component listens for changes to the `code` property using a `watch`er, and emits an `input` event with the updated `code` value whenever the `code` value changes.

---

## User

any issues with this code? Can it be made more concise?

---

## Assistant

There don't seem to be any obvious issues with this code. Here are a few ways it could be made more concise:

1. Instead of defining individual data properties for each `input` element (e.g. `first`, `second`, etc.), you could define a single data array called `code` that stores the values of all the `input` elements. This would allow you to use a `v-for` directive in the template to render the `input` elements and reduce the amount of repetition in the template.

2. Instead of using a `computed` property to get and set the values of the `input` elements, you could use a method to do the same thing. This would allow you to replace the `get` and `set` functions with a single method, which could make the code more readable.

3. Instead of using a `watch`er to listen for changes to the `code` property, you could use a `v-model` directive in the template to bind the `code` property to the `input` elements. This would eliminate the need for the `watch`er and the `input` event, and make the code more concise.

4. You could use a single class for all the `input` elements instead of defining the styles for each element separately. This would reduce the amount of repetition in the template.

Here's how the code might look after making these changes:

```
<template>
  <div id="otp" class="mt-5 flex flex-row justify-center px-2 text-center">
    <input
      v-for="(digit, index) in code"
      v-model="code[index]"
      @input="focusNextInput"
      :key="index"
      class="form-control m-2 h-10 w-10 rounded border border-slate-200 text-center font-bold dark:border-jovieDark-border dark:bg-jovieDark-800 dark:text-jovieDark-100 dark:text-jovieDark-200"
      type="text"
      :id="'digit' + index"
      maxlength="1" />
    <span class="m-2 mt-3 h-10 items-center text-slate-600 dark:text-jovieDark-300">-</span>
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
```

---

## User

<template>
  <div id="otp" class="mt-5 flex flex-row justify-center px-2 text-center">
    <input
      v-for="(digit, index) in code"
      v-model="code[index]"
      @input="focusNextInput"
      :key="index"
      class="form-control m-2 h-10 w-10 rounded border border-slate-200 text-center font-bold dark:border-jovieDark-border dark:bg-jovieDark-800 dark:text-jovieDark-100 dark:text-jovieDark-200"
      type="text"
      :id="'digit' + index"
      maxlength="1" />
    <span
      class="m-2 mt-3 h-10 items-center text-slate-600 dark:text-jovieDark-300"
      >-</span
    >
    <input
      v-for="(digit, index) in code"
      v-model="code[index]"
      @input="focusNextInput"
      :key="index"
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



**Topic:** [[chatgpt-clusters/coding_web_dev]]
