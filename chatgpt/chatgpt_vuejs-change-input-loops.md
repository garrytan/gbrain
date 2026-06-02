---
title: "Vuejs change input loops"
type: guide
created: 2023-01-03
updated: 2023-01-03
source: chatgpt-export
conversation_id: 40fd81c8-494b-449d-b5e6-b88b3ff6c5e3
message_count: 8
tags: [chatgpt, import, code]
---
# Vuejs change input loops

> Conversation ID: 40fd81c8-494b-449d-b5e6-b88b3ff6c5e3
> Created: 2023-01-03T01:18:44Z
> Updated: 2023-01-03T01:18:44Z
> Messages: 8

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


change the inputs so the first one loops only the first 3 inputs and the last one loops 4,5,6

---

## Assistant

To change the first input loop to only include the first three elements of the `code` array, you can modify the loop like this:

```
<input
  v-for="(digit, index) in code.slice(0, 3)"
  v-model="code[index]"
  @input="focusNextInput"
  :key="index"
  class="form-control m-2 h-10 w-10 rounded border border-slate-200 text-center font-bold dark:border-jovieDark-border dark:bg-jovieDark-800 dark:text-jovieDark-100 dark:text-jovieDark-200"
  type="text"
  :id="'digit' + index"
  maxlength="1" />
```

To change the second input loop to only include the last three elements of the `code` array, you can modify the loop like this:

```
<input
  v-for="(digit, index) in code.slice(3, 6)"
  v-model="code[index]"
  @input="focusNextInput"
  :key="index"
  class="form-control m-2 h-10 w-10 rounded border border-slate-200 text-center font-bold dark:border-jovieDark-border dark:bg-jovieDark-800 dark:text-jovieDark-100 dark:text-jovieDark-200"
  type="text"
  :id="'digit' + index"
  maxlength="1" />
```

Note that the `slice` method returns a new array, so this change will not modify the original `code` array.


---

## User

<template>
  <div id="otp" class="mt-5 flex flex-row justify-center px-2 text-center">
    <input
      v-for="(digit, index) in code.slice(0, 3)"
      v-model="code[index]"
      @input="focusNextInput"
      :key="index"
      class="form-control m-2 h-10 w-10 rounded border border-slate-200 text-center font-bold dark:border-jovieDark-border dark:bg-jovieDark-800 dark:text-jovieDark-100 dark:text-jovieDark-200"
      type="text"
      :id="'digit' + index"
      maxlength="1" />
    <span
      tabindex="-1"
      class="m-2 mt-3 h-10 items-center text-slate-600 dark:text-jovieDark-300"
      >-</span
    >
    <input
      v-for="(digit, index) in code.slice(3, 6)"
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


---

## Assistant

I see that you have modified the template and script code to include only the first three and last three elements of the `code` array in the input loops, respectively.

One thing to note is that the `key` attribute of the input elements should be set to a unique value that does not change, so it would be best to set it to a value that does not depend on the index of the loop. For example, you could set it to a static value such as `digit1`, `digit2`, etc.

```
<input
  v-for="(digit, index) in code.slice(0, 3)"
  v-model="code[index]"
  @input="focusNextInput"
  :key="'digit' + (index + 1)"
  class="form-control m-2 h-10 w-10 rounded border border-slate-200 text-center font-bold dark:border-jovieDark-border dark:bg-jovieDark-800 dark:text-jovieDark-100 dark:text-jovieDark-200"
  type="text"
  :id="'digit' + index"
  maxlength="1" />

<input
  v-for="(digit, index) in code.slice(3, 6)"
  v-model="code[index]"
  @input="focusNextInput"
  :key="'digit' + (index + 4)"
  class="form-control m-2 h-10 w-10 rounded border border-slate-200 text-center font-bold dark:border-jovieDark-border dark:bg-jovieDark-800 dark:text-jovieDark-100 dark:text-jovieDark-200"
  type="text"
  :id="'digit' + index"
  maxlength="1" />
```

This will ensure that the input elements are correctly identified and updated by Vue when the `code` array changes.


---

## User

show the full code

---

## Assistant

Here is the full code with the changes I suggested:

```
<template>
  <div id="otp" class="mt-5 flex flex-row justify-center px-2 text-center">
    <input
      v-for="(digit, index) in code.slice(0, 3)"
      v-model="code[index]"
      @input="focusNextInput"
      :key="'digit' + (index + 1)"
      class="form-control m-2 h-10 w-10 rounded border border-slate-200 text-center font-bold dark:border-jovieDark-border dark:bg-jovieDark-800 dark:text-jovieDark-100 dark:text-jovieDark-200"
      type="text"
      :id="'digit' + index"
      maxlength="1" />
    <span
      tabindex="-1"
      class="m-2 mt-3 h-10 items-center text-slate-600 dark:text-jovieDark-300"
      >-</span
    >
    <input
      v-for="(digit, index) in code.slice(3, 6)"
      v-model="code[index]"
      @input="focusNextInput"
      :key="'digit' + (index + 4)"
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
```

I hope this helps! Let me know if you have any questions.


---

## User

is this the most consise way to write this code?

---

## Assistant

Here is an alternative way to write the code that uses a single input loop and conditionally renders the hyphen `-` separator:

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
    <template v-if="code[3]">
      <span
        tabindex="-1"
        class="m-2 mt-3 h-10 items-center text-slate-600 dark:text-jovieDark-300"
        >-</span
      >
    </template>
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

This code uses a `template` element with a `v-if` directive to conditionally render the hyphen `-` separator only if the fourth element in the `code` array is truthy. This allows you to use a single loop to render all the input elements and the separator, which makes the code more concise.

I hope this helps! Let me know if you have any questions.
