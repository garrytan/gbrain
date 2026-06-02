---
conversation_id: f2c42efd-3488-4e35-9d5c-8f45901163f7
created: 2022-12-23
links:
- '[[chatgpt-clusters/business_startup]]'
message_count: 2
source: chatgpt-export
tags:
- chatgpt
- import
- code
title: Get width from array
type: note
updated: 2022-12-23
---

# Get width from array

**Related:** [[business_startup]]

> Conversation ID: f2c42efd-3488-4e35-9d5c-8f45901163f7
> Created: 2022-12-23T04:40:59Z
> Updated: 2022-12-23T04:40:59Z
> Messages: 2

---

## User

<template>
  <td
    v-if="freezeColumn || neverHide || visibleColumns.includes(columnName)"
    :class="[
      currentContact.id == creator.id
        ? ' bg-slate-100 text-slate-500 dark:bg-jovieDark-700 dark:text-slate-400'
        : 'darK bg-white text-slate-200 text-slate-300 dark:bg-jovieDark-900  ',
      freezeColumn ? 'sticky isolate z-20 font-bold focus:outline-none' : '',
      cellActive ? 'border-indigo-500' : '',
      width ? `w-${width}` : '',
    ]"
    class="overflow-auto whitespace-nowrap border-y border-slate-300 text-center text-xs font-medium focus:outline-indigo-500 dark:border-jovieDark-border before:dark:border-jovieDark-border">
    <slot>
      <DataGridCellTextInput
        :fieldId="fieldId"
        @blur="onBlur"
        v-model="modelValue" />
    </slot>
  </td>
</template>

<script>
import DataGridCellTextInput from './DataGridCellTextInput.vue';
export default {
  name: 'DataGridCell',
  components: {
    DataGridCellTextInput,
  },
  emits: ['update:modelValue', 'blur'],
  methods: {
    onBlur() {
      this.$emit('blur');
    },
  },
  props: {
    currentContact: Object,
    creator: Object,
    index: Number,
    selectedCreators: Array,
    freezeColumn: Boolean,
    width: String,
    fieldId: String,
    columnName: String,
    visibleColumns: Array,
    neverHide: Boolean,
    cellActive: Boolean,
    columnIndex: Number,
    rowIndex: Number,
    dataType: String,
    modelValue: String,
  },
};
</script>


instead of getting the width from a dedicated prop id like to get it from visibleColumns.width

---

## Assistant

If you want to get the width for a particular column from the `visibleColumns` array, you can use the `find` method to find the object that represents the column in the array and then access its `width` property.

Here's an example of how you could do that:

```
<template>
  <td
    v-if="freezeColumn || neverHide || visibleColumns.includes(columnName)"
    :class="[
      currentContact.id == creator.id
        ? ' bg-slate-100 text-slate-500 dark:bg-jovieDark-700 dark:text-slate-400'
        : 'darK bg-white text-slate-200 text-slate-300 dark:bg-jovieDark-900  ',
      freezeColumn ? 'sticky isolate z-20 font-bold focus:outline-none' : '',
      cellActive ? 'border-indigo-500' : '',
      columnWidth ? `w-${columnWidth}` : '',
    ]"
    class="overflow-auto whitespace-nowrap border-y border-slate-300 text-center text-xs font-medium focus:outline-indigo-500 dark:border-jovieDark-border before:dark:border-jovieDark-border">
    <slot>
      <DataGridCellTextInput
        :fieldId="fieldId"
        @blur="onBlur"
        v-model="modelValue" />
    </slot>
  </td>
</template>

<script>
import DataGridCellTextInput from './DataGridCellTextInput.vue';
export default {
  name: 'DataGridCell',
  components: {
    DataGridCellTextInput,
  },
  emits: ['update:modelValue', 'blur'],
  methods: {
    onBlur() {
      this.$emit('blur');
    },
  },
  computed: {
    columnWidth() {
      // Find the object in the visibleColumns array that represents the current column
      const column = this.visibleColumns.find(col => col.name === this.columnName);
      // If the object was found, return its width. Otherwise, return an empty string.
      return column ? column.width : '';
    },
  },
  props: {
    currentContact: Object,
    creator: Object,
    index: Number,
    selectedCreators: Array,
    freezeColumn: Boolean,
    fieldId: String,
    columnName: String,
    visibleColumns: Array,
    neverHide: Boolean,
    cellActive: Boolean,
    columnIndex: Number,
    rowIndex: Number,
    dataType: String,
    modelValue: String,
  },
};
</script>
```

In the above code, the `columnWidth` computed property uses the `find` method to search the `visibleColumns` array for an object that has a `name` property that matches the `columnName` prop. If such an object is found, its `width` property is returned. If no object is found, an empty string is returned instead.

You can then use the `columnWidth` computed property in the template like you would use a regular prop, by binding it to the `class` attribute of


**Topic:** [[chatgpt-clusters/business_startup]]


## See Also
- [[chatgpt/chatgpt_3-months-from-today]]
- [[chatgpt/chatgpt_avatar-generation-from-metrics]]
- [[chatgpt/chatgpt_cheap-flights-from-la]]
- [[chatgpt/chatgpt_excuse-from-jury-duty]]
- [[chatgpt/chatgpt_generate-output-from-markdown]]
