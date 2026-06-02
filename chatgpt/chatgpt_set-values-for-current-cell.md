---
title: "Set values for current cell."
type: note
created: 2022-12-24
updated: 2022-12-24
source: chatgpt-export
conversation_id: 2ac93050-cb88-42ae-a377-0187a0c147e5
message_count: 2
tags: [chatgpt, import, code]
---
# Set values for current cell.

> Conversation ID: 2ac93050-cb88-42ae-a377-0187a0c147e5
> Created: 2022-12-24T21:14:07Z
> Updated: 2022-12-24T21:14:07Z
> Messages: 2

---

## User

 setFocus() {
      this.$emit('update:currentCell', {
        row: this.rowIndex,
        column: this.column.key,
      });

this method emits to the parent row component. that component listens and emits to the parent table component.

write a function to go in the table component that handles the emitted event and sets the new values for currentCell

---

## Assistant

```
handleUpdateCurrentCell(newCell) {
  this.currentCell = {
    row: newCell.row,
    column: newCell.column
  };
}
```

You would need to add this function to the table component and bind it to the event emitted by the row component. Here is an example of how you can do this:

```
<template>
  <!-- other code -->
  <table-row
    v-for="row in rows"
    :key="row.id"
    :row="row"
    @update:currentCell="handleUpdateCurrentCell"
  ></table-row>
  <!-- other code -->
</template>

<script>
export default {
  name: 'Table',
  // other properties and methods
  methods: {
    handleUpdateCurrentCell(newCell) {
      this.currentCell = {
        row: newCell.row,
        column: newCell.column
      };
    }
  }
}
</script>
```

This will bind the `handleUpdateCurrentCell` function to the `update:currentCell` event emitted by the row component, so that when the event is emitted, the function will be called and the `currentCell` property in the table component will be updated with the new values.

I hope this helps! Let me know if you have any questions or need further clarification.


## See Also
- [[chatgpt/chatgpt_cell-phone-impact-on-flight]]
- [[chatgpt/chatgpt_cell-phone-radiation-effects]]
- [[chatgpt/chatgpt_fuel-cell-cars-overview]]
- [[chatgpt/chatgpt_handle-cell-navigation-event]]
- [[chatgpt/chatgpt_vue-data-grid-cell-component]]
