---
conversation_id: b067302f-d64f-4542-a73d-49b7ed1afeca
created: 2023-01-04
links:
- '[[chatgpt-clusters/coding_web_dev]]'
message_count: 2
source: chatgpt-export
tags:
- chatgpt
- import
title: Vue JS Tabbed Interface
type: note
updated: 2023-01-04
---

# Vue JS Tabbed Interface

**Related:** [[coding_web_dev]]

> Conversation ID: b067302f-d64f-4542-a73d-49b7ed1afeca
> Created: 2023-01-04T00:03:53Z
> Updated: 2023-01-04T00:03:53Z
> Messages: 2

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
      privacyMarkdown: '',
      termsMarkdown: '',
    };
  },
  created() {
    this.privacyMarkdown = this.fetch('/markdown/privacy.md');
    this.termsMarkdown = this.fetch('/markdown/terms.md');
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

This Vue.js component appears to be a tabbed interface for displaying two separate pages of content: one for privacy information and one for terms of service. The component uses the `TabGroup`, `TabList`, `Tab`, `TabPanel`, and `TabPanels` components from the `@headlessui/vue` package to create the tabbed interface. The `privacyMarkdown` and `termsMarkdown` data properties hold the markdown content for each of the pages, which are then converted to HTML and displayed in the corresponding `TabPanel` using the `marked` library. The `changeTab` method appears to be responsible for changing the selected tab, but it is not being used in the code provided.


**Topic:** [[chatgpt-clusters/coding_web_dev]]
