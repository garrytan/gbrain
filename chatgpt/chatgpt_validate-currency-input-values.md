---
title: "Validate currency input values"
type: note
created: 2022-12-22
updated: 2022-12-22
source: chatgpt-export
conversation_id: afd0d012-0643-43cf-93b5-bb7c7b84817d
message_count: 2
tags: [chatgpt, import, code]
---
# Validate currency input values

> Conversation ID: afd0d012-0643-43cf-93b5-bb7c7b84817d
> Created: 2022-12-22T23:53:06Z
> Updated: 2022-12-22T23:53:06Z
> Messages: 2

---

## User

<input
      :class="{
        'pl-6': dataType == 'currency',
        'pr-3': dataType == 'email',
      }"
      class="block w-full bg-transparent px-2 py-1 placeholder-slate-300 focus-visible:border-2 focus-visible:border-indigo-500 focus-visible:outline-indigo-500 focus-visible:ring-indigo-500 dark:placeholder-slate-500 sm:text-xs"
      :value="modelValue"
      :id="fieldId"
      @blur="debouncedEmailCheck(modelValue)"
      autocomplete="off"
      :placeholder="placeholder"
      :aria-describedby="fieldId"
      @input="$emit('update:modelValue', $event.target.value)" />

if dataType is currency, only accept numbers 

---

## Assistant

To only accept numbers when the `dataType` is `currency`, you can use the `pattern` attribute of the `input` element and specify a regular expression that only allows digits.

Here's an example of how you can do this:

```
<input
  :class="{
    'pl-6': dataType == 'currency',
    'pr-3': dataType == 'email',
  }"
  class="block w-full bg-transparent px-2 py-1 placeholder-slate-300 focus-visible:border-2 focus-visible:border-indigo-500 focus-visible:outline-indigo-500 focus-visible:ring-indigo-500 dark:placeholder-slate-500 sm:text-xs"
  :value="modelValue"
  :id="fieldId"
  @blur="debouncedEmailCheck(modelValue)"
  autocomplete="off"
  :placeholder="placeholder"
  :aria-describedby="fieldId"
  @input="$emit('update:modelValue', $event.target.value)"
  :pattern="dataType == 'currency' ? '\\d*' : null"
/>
```

The regular expression `'\\d*'` allows for any number of digits (0 or more). The `pattern` attribute specifies a regular expression that the `input` element's value must match in order for the value to pass validation. If the value does not match the specified pattern, the `input` element will be invalid and the form will not be submitted (if the `input` element is within a form element).

Note that this will not automatically add a comma for every thousandth place, or a currency symbol. You will need to handle this formatting separately.
