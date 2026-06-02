---
title: "Convert Vue Component To Options API"
type: note
created: 2023-01-13
updated: 2023-01-13
source: chatgpt-export
conversation_id: 315b9cd4-cca2-4a4e-aafd-1550acc5ebe0
message_count: 4
tags: [chatgpt, import]
---
# Convert Vue Component To Options API

> Conversation ID: 315b9cd4-cca2-4a4e-aafd-1550acc5ebe0
> Created: 2023-01-13T20:09:36Z
> Updated: 2023-01-13T20:09:36Z
> Messages: 4

---

## User

convert this to the options api

<script setup>
import { ref } from 'vue';
import {
  Dialog,
  DialogPanel,
  DialogTitle,
  DialogDescription,
} from '@headlessui/vue';

const isOpen = ref(true);

function setIsOpen(value) {
  isOpen.value = value;
}
</script>

---

## Assistant

<template>
  <Dialog :isOpen="isOpen.value" @close="setIsOpen(false)">
    <DialogPanel>
      <DialogTitle>Title</DialogTitle>
      <DialogDescription>Description</DialogDescription>
    </DialogPanel>
  </Dialog>
</template>

<script>
import { ref } from 'vue';
import {
  Dialog,
  DialogPanel,
  DialogTitle,
  DialogDescription,
} from '@headlessui/vue';

export default {
  setup() {
    const isOpen = ref(true);

    function setIsOpen(value) {
      isOpen.value = value;
    }

    return {
      isOpen,
      setIsOpen,
    };
  },
};
</script>


---

## User

dont use setup use data and method

---

## Assistant

<template>
  <Dialog :isOpen="isOpen" @close="closeDialog">
    <DialogPanel>
      <DialogTitle>Title</DialogTitle>
      <DialogDescription>Description</DialogDescription>
    </DialogPanel>
  </Dialog>
</template>

<script>
import {
  Dialog,
  DialogPanel,
  DialogTitle,
  DialogDescription,
} from '@headlessui/vue';

export default {
  data() {
    return {
      isOpen: true,
    };
  },
  methods: {
    closeDialog() {
      this.isOpen = false;
    },
  },
};
</script>

