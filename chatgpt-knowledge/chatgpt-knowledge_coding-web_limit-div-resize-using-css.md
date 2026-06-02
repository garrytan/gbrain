---
title: "Limit div resize using CSS"
type: guide
created: 2022-12-20
updated: 2022-12-20
source: chatgpt-export
topic: coding-web
message_count: 9
tags: [chatgpt, knowledge, coding-web]
---
**Topic:** [[chatgpt-knowledge/_topics/coding-web]]

# Limit div resize using CSS

> **Source:** ChatGPT conversation
> **Date:** 2022-12-20T21:47:18Z
> **Messages:** 9
> **Topic:** coding-web

## Question

i made my div resizable using tailwind css resize-x. but now i want to limit how far you can resize it

## Answer

To limit the amount that a div can be resized using the `resize` property in CSS, you can use the `min-width` and `max-width` properties. 

For example, to limit the width of a div to a minimum of 200 pixels and a maximum of 500 pixels, you can use the following CSS:

```css
div {
  resize: both; /* allow the div to be resized */
  min-width: 200px; /* set the minimum width to 200 pixels */
  max-width: 500px; /* set the maximum width to 500 pixels */
}
```

You can also use the `min-height` and `max-height` properties to limit the height of the div.

```css
div {
  resize: both; /* allow the div to be resized */
  min-height: 200px; /* set the minimum height to 200 pixels */
  max-height: 500px; /* set the maximum height to 500 pixels */
}
```

Keep in mind that the `resize` property only works on elements that have the `overflow` property set to something other than `visible`. So you may also need to add the following to your CSS:

```css
div {
  overflow: auto; /* add this to allow the div to be resized */
}
```

I hope this helps! Let me know if you have any questions.


## Question

how can i make it so that the user can click anywhere on the side of the column to resize it. im using tialwind css and vue.js

## Answer

To make it so that a user can click anywhere on the side of a column to resize it using Tailwind CSS and Vue.js, you can use the `cursor` property in CSS to change the cursor to a resize cursor when the user hovers over the side of the column. You can then use the `resize` property to allow the column to be resized.

For example, you could use the following CSS to change the cursor to a horizontal resize cursor when the user hovers over the left or right side of the column:

```css
.column {
  /* other styles for the column */
  cursor: ew-resize; /* change the cursor to a horizontal resize cursor when hovering over the left or right side of the column */
  resize: horizontal; /* allow the column to be resized horizontally */
}
```

Alternatively, you can use the `cursor` property to change the cursor to a vertical resize cursor when the user hovers over the top or bottom of the column:

```css
.column {
  /* other styles for the column */
  cursor: ns-resize; /* change the cursor to a vertical resize cursor when hovering over the top or bottom of the column */
  resize: vertical; /* allow the column to be resized vertically */
}
```

Keep in mind that the `resize` property only works on elements that have the `overflow` property set to something other than `visible`. So you may also need to add the following to your CSS:

```css
.column {
  overflow: auto; /* add this to allow the column to be resized */
}
```

I hope this helps! Let me know if you have any questions.


## Question

its showing the cursor now but i can only resize if i click the corner not the edge

## Answer

If you want to allow the user to resize the column by clicking anywhere on the edge of the column, rather than just the corner, you can use the `resize` property with the value `both`. This will allow the column to be resized both horizontally and vertically by clicking anywhere on the edge of the column.

For example, you can use the following CSS to change the cursor to a resize cursor when the user hovers over the edge of the column and allow the column to be resized by clicking anywhere on the edge:

```css
.column {
  /* other styles for the column */
  cursor: resize; /* change the cursor to a resize cursor when hovering over the edge of the column */
  resize: both; /* allow the column to be resized both horizontally and vertically by clicking anywhere on the edge */
  overflow: auto; /* add this to allow the column to be resized */
}
```

Keep in mind that the `resize` property only works on elements that have the `overflow` property set to something other than `visible`. So you will need to make sure that the `overflow` property is set to something other than `visible` for the column.

I hope this helps! Let me know if you have any questions.


## Question

max and min width are not working

## Answer

If the `min-width` and `max-width` properties are not working as expected when you are using the `resize` property, there are a few things you can try:

1. Make sure that the `overflow` property is set to something other than `visible`. The `resize` property only works on elements that have the `overflow` property set to something other than `visible`.

2. Make sure that the `min-width` and `max-width` properties are being applied to the element that you are trying to resize. If you are applying the `min-width` and `max-width` properties to a parent element, they may not have any effect on the element that you are trying to resize.

3. If you are using a CSS preprocessor such as SASS or LESS, make sure that you are using the correct syntax for the `min-width` and `max-width` properties. For example, in SASS you will need to use the `min-width` and `max-width` mixins, rather than the `min-width` and `max-width` properties.

4. Make sure that the `min-width` and `max-width` values are valid. The `min-width` and `max-width` values must be a valid length, such as `100px` or `20em`, or a percentage value.

I hope this helps! Let me know if you have any questions.


## Question

<div
        class="min-w-60 max-w-96 top-0 z-30 mx-auto flex h-screen w-60 cursor-ew-resize resize-x flex-col justify-between overflow-auto border-r border-slate-100 bg-white py-4 dark:border-jovieDark-border dark:bg-jovieDark-900">
        <div>
          <slot name="header">
            <div class="w-full flex-col px-2">
              <div class="items-center" @click="navigateBack()" v-if="menu">
                <div
                  class="items-cemter flex cursor-pointer justify-between text-xl font-light tracking-wide text-slate-900 hover:text-slate-700 dark:text-jovieDark-400 dark:hover:text-white">
                  <ChevronLeftIcon
                    class="mr-2 h-5 w-5 text-slate-400 dark:text-gray-200 dark:hover:text-gray-100"
                    aria-hidden="true" />
                  {{ menu || 'Back' }}
                </div>
              </div>
              <div v-else class="flex h-8 w-full items-center justify-between">
                <!-- <SwitchTeams /> -->
    
