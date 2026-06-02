---
title: "Resizable Columns with Dragging (Vue.js)"
type: note
created: 2023-05-01
updated: 2023-05-01
source: chatgpt-export
conversation_id: 41c8ea7b-543c-422f-90d5-b5c5a7d764f3
message_count: 2
tags: [chatgpt, import, code]
---
# Resizable Columns with Dragging (Vue.js)

> Conversation ID: 41c8ea7b-543c-422f-90d5-b5c5a7d764f3
> Created: 2023-05-01T18:11:35Z
> Updated: 2023-05-01T18:12:33Z
> Messages: 2

---

## User

im trying to make reziable columns in a table in a vue.js SPA. But i am also use vue-draggable-next package to make the columns drag and drop to reorder.  these two features are conflicting, because the user needs to click and drag to resize which is also trigger a re-order. how do i fix this

---

## Assistant

One solution to this problem is to add a conditional check in your Vue component's drag and drop event listener to determine whether the user is trying to resize the column or drag it. You can do this by checking the location of the mouse pointer when the event is triggered.

Here is a possible implementation:

1. Add a ref to each column in the table, for example:

   ```
   <table>
     <thead>
       <tr>
         <th ref="col1" @mousedown="onColumnMouseDown('col1')">Column 1</th>
         <th ref="col2" @mousedown="onColumnMouseDown('col2')">Column 2</th>
         <th ref="col3" @mousedown="onColumnMouseDown('col3')">Column 3</th>
       </tr>
     </thead>
     <tbody>
       ...
     </tbody>
   </table>
   ```

2. In the component's data, add a flag to indicate whether the user is resizing a column or not:

   ```
   data() {
     return {
       resizingColumn: false
     }
   }
   ```

3. Define the `onColumnMouseDown` method that sets the `resizingColumn` flag when the user clicks on the resize handle (for example, the rightmost border of the column):

   ```
   methods: {
     onColumnMouseDown(colRef) {
       const col = this.$refs[colRef][0]
       const resizeHandleWidth = 5 // adjust as needed
       const mouseX = event.clientX
       const colRightX = col.getBoundingClientRect().right
       if (colRightX - mouseX <= resizeHandleWidth) {
         this.resizingColumn = true
       }
     }
   }
   ```

4. Modify your drag and drop event listener to check the `resizingColumn` flag and only trigger a re-order if the user is not resizing a column:

   ```
   methods: {
     onColumnDrag(event) {
       if (!this.resizingColumn) {
         // reorder columns here
       }
     }
   }
   ```

This way, the `onColumnMouseDown` method will only set the `resizingColumn` flag if the user clicks on the resize handle. When the user starts dragging a column, the `onColumnDrag` method will only reorder the columns if the `resizingColumn` flag is not set.
