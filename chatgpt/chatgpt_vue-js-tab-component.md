---
conversation_id: 543693de-f047-43f7-8c1f-0c3607cc2eb1
created: 2023-01-03
links:
- '[[chatgpt-clusters/coding_web_dev]]'
message_count: 6
source: chatgpt-export
tags:
- chatgpt
- import
- code
title: Vue JS Tab Component
type: guide
updated: 2023-01-03
---

# Vue JS Tab Component

**Related:** [[coding_web_dev]]

> Conversation ID: 543693de-f047-43f7-8c1f-0c3607cc2eb1
> Created: 2023-01-03T20:00:17Z
> Updated: 2023-01-03T20:00:17Z
> Messages: 6

---

## User

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
        <div class="pb-16">
          <div class="px-4 sm:px-6 md:px-0">
            <div class="pb-6">
              <!-- Tabs -->

              <div
                class="border-b border-slate-200 dark:border-jovieDark-border"></div>

              <TabPanels as="template">
                <TabPanel class="mx-auto max-w-5xl space-y-12 px-4 py-6">
                  <div v-html="privacyHtml"></div>
                </TabPanel>
              </TabPanels>
              <TabPanels as="template">
                <TabPanel class="space-y-12 px-4 py-6">
                  <div v-html="termsHtml"></div>
                </TabPanel>
              </TabPanels>
            </div>
          </div>
        </div>
      </div>
    </main>
  </TabGroup>
</template>

<script>
import { ref } from 'vue';
import { TabGroup, Tab, TabList, TabPanel, TabPanels } from '@headlessui/vue';

import { marked } from 'marked';
const tabs = [
  { name: 'Privacy', href: '#', current: true },
  { name: 'Terms', href: '#', current: false },
];

const selectedTab = ref(0);

function changeTab(index) {
  selectedTab.value = index;
}
export default {
  components: {
    TabGroup,
    TabList,
    TabPanel,
    TabPanels,
    Tab,
  },
  data() {
    return {
      tabs,
      privacyMarkdown: '## this is the privacy policy',
      termsMarkdown: '## this is the terms of service',
    };
  },
  computed: {
    privacyHtml() {
      return marked(this.privacyMarkdown);
    },
    termsHtml() {
      return marked(this.termsMarkdown);
    },
  },

  props: {
    defaultTab: {
      type: Number,
      default: 0,
    },
  },
};
</script>


---

## Assistant

This is a Vue.js component that consists of a `TabGroup` with two `Tab` components inside a `TabList`. The `TabGroup` has two `TabPanel` components inside `TabPanels`, each containing a piece of Markdown text that gets rendered as HTML when the corresponding `Tab` is selected.

The `TabGroup` component is provided by the `@headlessui/vue` library, which provides a set of customizable, accessible UI components for Vue.js.

The component has a `defaultTab` prop that allows you to specify which tab should be displayed by default when the component is rendered. The `selectedTab` data property is used to store the index of the currently selected tab. The `changeTab` function is used to update the value of `selectedTab` when a different tab is selected.

The `marked` function, imported from the `marked` library, is used to parse the Markdown text and return the corresponding HTML. The HTML is then rendered in the template using the `v-html` directive.

---

## User

now instead of getting the markdown from the sscript lets import the markdown files resources/markdown/privacy.md and resources/markdown/terms.md


---

## Assistant

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

---

## User

no we need to fetch the contents of the md files and run it through markdown to parse it to html

---

## Assistant

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



**Topic:** [[chatgpt-clusters/coding_web_dev]]


## See Also
- [[chatgpt/chatgpt_add-prop-to-vue-component]]
- [[chatgpt/chatgpt_add-prop-to-vuejs-component]]
- [[chatgpt/chatgpt_component-audit-and-matching]]
- [[chatgpt/chatgpt_component-deduplication-concerns]]
- [[chatgpt/chatgpt_component-naming-guidance]]
