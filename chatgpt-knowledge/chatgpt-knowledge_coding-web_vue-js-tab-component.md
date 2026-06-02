---
title: "Vue JS Tab Component"
type: guide
created: 2023-01-03
updated: 2023-01-03
source: chatgpt-export
topic: coding-web
message_count: 6
tags: [chatgpt, knowledge, coding-web]
---
**Topic:** [[chatgpt-knowledge/_topics/coding-web]]

# Vue JS Tab Component

> **Source:** ChatGPT conversation
> **Date:** 2023-01-03T20:00:17Z
> **Messages:** 6
> **Topic:** coding-web

## Question

<template>
  <TabGroup
    vertical
    :defaultIndex="defaultTab"
    as="div"
    class="flex h-screen w-full flex-row">
    <div class="fixed top-0 flex h-full w-60 flex-col">
      <TabList class="mt-24 flex flex-col space-y-2 px-4">
        <Tab
          as="template"
          v-for="tab in tabs"
          :key="tab.name"
          v-slot="{ selected }">
          <button
            :class="[
              selected
                ? 'bg-slate-100 text-slate-700 dark:bg-jovieDark-700 dark:text-jovieDark-300'
                : 'border-transparent text-slate-900 dark:text-jovieDark-100',
              'flex-1 whitespace-nowrap rounded-md py-1 px-1 text-left text-xs font-medium  outline-none ring-0 focus:outline-none focus:ring-0',
            ]">
            {{ tab.name }}
          </button>
        </Tab>
      </TabList>
    </div>
    <main class="flex h-full w-full dark:bg-jovieDark-900">
      <div class="relative mx-auto max-w-7xl md:px-8 xl:px-0">
        <div class="pb-16

## Answer

This is a Vue.js component that consists of a `TabGroup` with two `Tab` components inside a `TabList`. The `TabGroup` has two `TabPanel` components inside `TabPanels`, each containing a piece of Markdown text that gets rendered as HTML when the corresponding `Tab` is selected.

The `TabGroup` component is provided by the `@headlessui/vue` library, which provides a set of customizable, accessible UI components for Vue.js.

The component has a `defaultTab` prop that allows you to specify which tab should be displayed by default when the component is rendered. The `selectedTab` data property is used to store the index of the currently selected tab. The `changeTab` function is used to update the value of `selectedTab` when a different tab is selected.

The `marked` function, imported from the `marked` library, is used to parse the Markdown text and return the corresponding HTML. The HTML is then rendered in the template using the `v-html` directive.

## Question

now instead of getting the markdown from the sscript lets import the markdown files resources/markdown/privacy.md and resources/markdown/terms.md


## Answer

To import the Markdown files from the `resources/markdown` directory, you can use the `import` statement in the script block of your component:

```
import privacyMarkdown from '@/resources/markdown/privacy.md';
import termsMarkdown from '@/resources/markdown/terms.md';
```

Then, you can update the `privacyMarkdown` and `termsMarkdown` data properties to use the imported Markdown files:

```
data() {
  return {
    tabs,
    privacyMarkdown,
    termsMarkdown,
  };
},
```

Now, the component will use the imported Markdown files to render the content of the tabs.

## Question

no we need to fetch the contents of the md files and run it through markdown to parse it to html

## Answer

To fetch the contents of the Markdown files and parse them to HTML, you can use the `fetch` function to make an HTTP request to the URL of the Markdown file and use the `marked` function to parse the response.

First, you need to update the import statements to include the `fetch` function:

```
import { ref, fetch } from 'vue';
```

Then, you can use the `fetch` function to make a request to the URL of the Markdown file and use the `text` method of the response to get the contents of the file as a string:

```
async fetchMarkdown(url) {
  const response = await fetch(url);
  const markdown = await response.text();
  return marked(markdown);
}
```

Now, you can call the `fetchMarkdown` function in the `created` hook of the component to fetch the Markdown files and parse them to HTML when the component is created:

```
created() {
  this.privacyHtml = this.fetchMarkdown('/resources/markdown/privacy.md');
  this.termsHtml = this.fetchMarkdown('/resources/markdown/terms.md');
},
```

You also need to update the `data` function to add the `privacyHtml` and `termsHtml` properties:

```
data() {
  return {
    tabs,
    privacyMarkdown: '',
    termsMarkdown: '',
    privacyHtml: '',
    termsHtml: '',
  };
},
```

Finally, you can update the template to bind to the `privacyHtml` and `termsHtml` properties:

```
<TabPanel class="mx-auto max-w-5xl space-y-12 px-4 py-6">
  <div v-html="privacyHtml"></div>
</TabPanel>

<TabPanel class="space-y-12 px-4 py-6">
  <div v-html="termsHtml"></div>
</TabPanel>
```

Now, the component will fetch the Markdown files and parse them to HTML when it is created, and the resulting HTML will be rendered in the template.

