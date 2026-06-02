---
conversation_id: 47c46c45-05d6-4b83-8bee-04bc07c76ef0
created: 2022-12-24
links:
- '[[chatgpt-clusters/coding_web_dev]]'
message_count: 2
source: chatgpt-export
tags:
- chatgpt
- import
- code
title: Update CSS Class on Condition
type: note
updated: 2022-12-24
---

# Update CSS Class on Condition

> Conversation ID: 47c46c45-05d6-4b83-8bee-04bc07c76ef0
> Created: 2022-12-24T00:29:37Z
> Updated: 2022-12-24T00:29:37Z
> Messages: 2

---

## User

<template>
  <td
    tabindex="0"
    @keydown="onKeyDown"
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
      <component
        :is="inputComponent"
        :fieldId="fieldId"
        @blur="onBlur"
        :placeholder="columnName"
        v-model="modelValue" />
      <!--  <star-rating
        v-if="dataType == 'rating'"
        class="w-20"
        :star-size="12"
        :increment="0.5"
        v-model:rating="modelValue"
        @blur="onBlur" />
      <CheckboxInput v-if="dataType == 'checkbox'" v-model="modelValue" />
      <DataGridCellTextInput
        v-else
        :fieldId="fieldId"
        @blur="onBlur"
        :placeholder="columnName"
        v-model="modelValue" /> -->
    </slot>
  </td>
</template>

<script>
import CheckboxInput from './CheckboxInput.vue';
import DataGridCellTextInput from './DataGridCellTextInput.vue';
import StarRating from 'vue-star-rating';
export default {
  name: 'DataGridCell',
  components: {
    DataGridCellTextInput,
    StarRating,
    CheckboxInput,
  },
  emits: ['update:modelValue', 'blur', 'move'],
  methods: {
    onBlur() {
      this.$emit('blur');
    },
  },
  onKeyDown(event) {
    switch (event.key) {
      case 'ArrowRight':
        this.$emit('move', 'right');
        break;
      case 'ArrowLeft':
        this.$emit('move', 'left');
        break;
      case 'ArrowUp':
        this.$emit('move', 'up');
        break;
      case 'ArrowDown':
        this.$emit('move', 'down');
        break;
    }
  },
  computed: {
    inputComponent() {
      switch (this.dataType) {
        case 'rating':
          return 'star-rating';
        case 'checkbox':
          return 'checkbox-input';
        default:
          return 'data-grid-cell-text-input';
      }
    },
    columnWidth() {
      // Find the object in the visibleColumns array that represents the current column
      const column = this.visibleColumns.find(
        (col) => col.name === this.columnName
      );
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

    visibleColumns: Array,
    neverHide: Boolean,
    cellActive: Boolean,
    column: Object,
    rowIndex: Number,
    dataType: String,
    modelValue: String,
  },
};
</script>


if the freeze prop is true, set focus:outline-none as as focus:border-none and focus:ring-none

---

## Assistant

To update the `focus:outline-none` class to `focus:border-none` and `focus:ring-none` when the `freezeColumn` prop is `true`, you can add the following lines of code to the `td` element in the template:

```
:class="[
  freezeColumn ? 'focus:border-none focus:ring-none' : 'focus:outline-none',
  // other classes
]"
```

This will set the `focus:border-none` and `focus:ring-none` classes when `freezeColumn` is `true`, and the `focus:outline-none` class otherwise.

Alternatively, you can also use a ternary operator to set the `class` attribute directly:

```
class="overflow-auto whitespace-nowrap border-y border-slate-300 text-center text-xs font-medium focus:outline-indigo-500 dark:border-jovieDark-border before:dark:border-jovieDark-border"
class="overflow-auto whitespace-nowrap border-y border-slate-300 text-center text-xs font-medium focus:border-none focus:ring-none dark:border-jovieDark-border before:dark:border-jovieDark-border"

class="[
  freezeColumn ? 'focus:border-none focus:ring-none' : 'focus:outline-none',
  'overflow-auto whitespace-nowrap border-y border-slate-300 text-center text-xs font-medium focus:outline-indigo-500 dark:border-jovieDark-border before:dark:border-jovieDark-border',
]"
```

This will set the `focus:border-none` and `focus:ring-none` classes when `freezeColumn` is `true`, and the `focus:outline-none` class otherwise.


**Topic:** [[chatgpt-clusters/coding_web_dev]]
