---
title: "New chat"
type: guide
created: 2023-01-29
updated: 2023-01-29
source: chatgpt-export
conversation_id: bf2ec761-d792-4f74-a9c4-9705e3de258f
message_count: 6
tags: [chatgpt, import, code]
---
# New chat

> Conversation ID: bf2ec761-d792-4f74-a9c4-9705e3de258f
> Created: 2023-01-29T18:32:37Z
> Updated: 2023-01-29T18:32:37Z
> Messages: 6

---

## User

<template>
  <Popover as="div" class="relative">
    <Float :z-index="999" placement="bottom-end" shift>
      <PopoverButton>
        <CalendarDaysIcon
          class="hidden h-5 w-5 cursor-pointer text-slate-400 dark:text-jovieDark-600 dark:active:text-slate-100 dark:group-hover/action:text-slate-400" />
      </PopoverButton>
      <div>
        <PopoverPanel static>
          <GlassmorphismContainer>
            <div
              class="rounded-md bg-white shadow-lg dark:bg-jovieDark-900 dark:text-jovieDark-100">
              <div class="p-2">
                <vue-tailwind-datepicker
                  as-single
                  class="border-none bg-transparent shadow-none"
                  no-input
                  @select="updateDate($event)"
                  v-model="date" />
              </div>
            </div>
          </GlassmorphismContainer>
        </PopoverPanel>
      </div>
    </Float>
  </Popover>
</template>
<script>
//@ts-check
import { CalendarDaysIcon } from '@heroicons/vue/24/solid';
import VueTailwindDatepicker from 'vue-tailwind-datepicker';
import { Popover, PopoverButton, PopoverPanel } from '@headlessui/vue';
import { Float } from '@headlessui-float/vue';
import GlassmorphismContainer from './GlassmorphismContainer.vue';

export default {
  name: 'JovieDatePicker',
  components: {
    CalendarDaysIcon,
    VueTailwindDatepicker,
    Popover,
    PopoverButton,
    PopoverPanel,
    Float,
    GlassmorphismContainer,
  },
  props: {
    value: {
      type: Date,
      default: null,
      required: true,
    },
  },
  data() {
    return {
      date: null,
    };
  },
  methods: {
    updateDate(date) {
      console.log(date);
      this.$emit('update:value', date);
    },
  },
};
</script>


---

## Assistant

This is a Vue.js component that implements a date picker. When the user clicks on the calendar icon, a date picker popover appears, which allows the user to select a date. The selected date is then stored in the `date` property of the component's data. The selected date can be emitted to the parent component using the `update:value` event. The component uses several other components from the @headlessui/vue and vue-tailwind-datepicker packages, including a popover, a float, and a glassmorphism container.

---

## User

when the input changes value we need to emit that with the updateDate function

---

## Assistant

The `updateDate` function is called when the date is selected in the date picker and updates the value of the `date` property in the component's data. The selected date can then be emitted to the parent component using the `update:value` event.

Here's the updated code:

```
<script>
//@ts-check
import { CalendarDaysIcon } from '@heroicons/vue/24/solid';
import VueTailwindDatepicker from 'vue-tailwind-datepicker';
import { Popover, PopoverButton, PopoverPanel } from '@headlessui/vue';
import { Float } from '@headlessui-float/vue';
import GlassmorphismContainer from './GlassmorphismContainer.vue';

export default {
  name: 'JovieDatePicker',
  components: {
    CalendarDaysIcon,
    VueTailwindDatepicker,
    Popover,
    PopoverButton,
    PopoverPanel,
    Float,
    GlassmorphismContainer,
  },
  props: {
    value: {
      type: Date,
      default: null,
      required: true,
    },
  },
  data() {
    return {
      date: this.value,
    };
  },
  watch: {
    date(newValue) {
      this.$emit('update:value', newValue);
    },
  },
};
</script>
```

---

## User

how can i make it support v-model on the parent

---

## Assistant

You can make the component support `v-model` on the parent by binding the `value` prop to the `v-model` directive. Additionally, you can watch the `value` prop for changes and update the `date` property in the component's data accordingly.

Here's the updated code:

```
<script>
//@ts-check
import { CalendarDaysIcon } from '@heroicons/vue/24/solid';
import VueTailwindDatepicker from 'vue-tailwind-datepicker';
import { Popover, PopoverButton, PopoverPanel } from '@headlessui/vue';
import { Float } from '@headlessui-float/vue';
import GlassmorphismContainer from './GlassmorphismContainer.vue';

export default {
  name: 'JovieDatePicker',
  components: {
    CalendarDaysIcon,
    VueTailwindDatepicker,
    Popover,
    PopoverButton,
    PopoverPanel,
    Float,
    GlassmorphismContainer,
  },
  props: {
    value: {
      type: Date,
      default: null,
      required: true,
    },
  },
  data() {
    return {
      date: this.value,
    };
  },
  watch: {
    value(newValue) {
      this.date = newValue;
    },
    date(newValue) {
      this.$emit('input', newValue);
    },
  },
};
</script>
```

Now you can use the component in the parent component with the `v-model` directive:

```
<JovieDatePicker v-model="selectedDate" />
```
