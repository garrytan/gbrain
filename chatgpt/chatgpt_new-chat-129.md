---
title: "New chat"
type: guide
created: 2023-01-18
updated: 2023-01-18
source: chatgpt-export
conversation_id: 797ebf8e-3beb-4356-bea4-7bb5bde4473b
message_count: 4
tags: [chatgpt, import, code]
---
# New chat

> Conversation ID: 797ebf8e-3beb-4356-bea4-7bb5bde4473b
> Created: 2023-01-18T20:43:47Z
> Updated: 2023-01-18T20:43:47Z
> Messages: 4

---

## User

<template>
  <!--  <JovieDropdownMenu
    @itemClicked="addCustomField"
    :items="customFields"
    placement="left-start"
    ><template #triggerButton
      ><PlusIcon
        class="h-4 w-4 text-slate-600 dark:text-jovieDark-200"></PlusIcon
    ></template>
  </JovieDropdownMenu> -->

  <!--  <Dialog :open="isOpen" @close="setIsOpen">
    <DialogPanel>
      <GlassmorphismContainer>
        <DialogTitle>Deactivate account</DialogTitle>
        <DialogDescription>
          This will permanently deactivate your account
        </DialogDescription>

        <p>You're about to create a {{ fieldType }}</p>

        <button @click="setIsOpen(false)">Deactivate</button>
        <button @click="setIsOpen(false)">Cancel</button>
      </GlassmorphismContainer>
    </DialogPanel>
  </Dialog> -->

  <Popover class="relative">
    <Float shift portal placement="left-start">
      <PopoverButton>
        <PlusIcon
          class="h-4 w-4 text-slate-600 dark:text-jovieDark-200"></PlusIcon>
      </PopoverButton>

      <PopoverPanel v-slot="{ close }" class="z-10">
        <GlassmorphismContainer class="w-80 px-4 py-2" size="3xl">
          <div class="flex flex-col space-y-4">
            <InputGroup
              tabindex="0"
              v-model="field.name"
              placeholder="Field Name"
              label="Field Name"
              type="text"
              :error="errors.name ? errors.name[0] : null"
              class="w-full border-0 border-none border-transparent bg-transparent px-1 py-2 text-xs font-medium text-slate-600 outline-0 ring-0 placeholder:font-light placeholder:text-slate-400 focus:border-transparent focus:ring-0 focus:ring-transparent focus:ring-offset-0" />
            <ComboboxMenu :items="customFieldTypes" v-model="field.type" />
           
          </div>
          <div v-if="fieldType.name === ">
            <p>You're about to create a {{ fieldType }}</p>
          </div>
          <div
            v-if="errors.type"
            class="min-h-4 text-xs text-red-600 dark:text-red-300">
            <span>
              {{ errors.type[0] }}
            </span>
          </div>
          <ButtonGroup
            class="mt-4"
            text="Add Field"
            :disabled="adding"
            @click="saveCustomField" />
        </GlassmorphismContainer>
      </PopoverPanel>
    </Float>
  </Popover>
</template>

<script>
import {
  Popover,
  PopoverButton,
  PopoverPanel,
  Menu,
  MenuItems,
} from '@headlessui/vue';
import GlassmorphismContainer from './GlassmorphismContainer.vue';
import { Float } from '@headlessui-float/vue';
import JovieDropdownMenu from './JovieDropdownMenu.vue';
import { PlusIcon } from '@heroicons/vue/24/solid';
import InputGroup from './InputGroup.vue';
import ButtonGroup from './ButtonGroup.vue';
import FieldService from '../services/api/field.service';
import DropdownMenuItem from './DropdownMenuItem.vue';
import ComboboxMenu from './ComboboxMenu.vue';

export default {
  components: {
    PlusIcon,
    JovieDropdownMenu,
    GlassmorphismContainer,
    Popover,
    PopoverButton,
    PopoverPanel,
    Float,
    InputGroup,
    ButtonGroup,
    DropdownMenuItem,
    Menu,
    MenuItems,
    ComboboxMenu,
  },
  data() {
    return {
      isOpen: true,

      fieldType: '',
      customFieldTypes: [],
      errors: {},
      field: {
        name: '',
        type: '',
      },
      adding: false,
    };
  },
  mounted() {
    this.getCustomFieldTypes();
  },
  methods: {
    saveCustomField() {
      this.adding = true;
      FieldService.saveCustomField(this.field)
        .then((response) => {
          response = response.data;
          if (response.status) {
            this.$notify({
              group: 'user',
              type: 'success',
              duration: 40000,
              title: 'Successful',
              text: response.message,
            });
            this.field = {
              name: '',
              type: '',
            };
          } else {
            this.$notify({
              group: 'user',
              type: 'error',
              duration: 15000,
              title: 'Error',
              text: response.message,
            });
          }
        })
        .catch((error) => {
          if (error.response && error.response.status == 422) {
            this.errors = error.response.data.errors;
          }
        })
        .finally((response) => {
          this.adding = false;
          close();
        });
    },
    getCustomFieldTypes() {
      FieldService.getCustomFieldTypes()
        .then((response) => {
          response = response.data;
          if (response.status) {
            this.customFieldTypes = response.data;
          } else {
            this.$notify({
              group: 'user',
              type: 'error',
              duration: 15000,
              title: 'Error',
              text: response.message,
            });
          }
        })
        .catch((error) => {})
        .finally((response) => {});
    },
    closeDialog() {
      this.isOpen = false;
    },
    setIsOpen(value) {
      this.isOpen = value;
    },
    addCustomField(field) {
      console.log('field');
      this.fieldType = field.name;
      isOpen = true;
      console.log(field);
    },
  },
};
</script>


---

## Assistant

This is a Vue.js template for a popover that allows the user to create a custom field. The template uses various components such as Popover, PopoverButton, PopoverPanel, InputGroup, ComboboxMenu, ButtonGroup, and GlassmorphismContainer. The template also includes a number of imported components such as PlusIcon, JovieDropdownMenu, and Float from external libraries. The template also uses a service called FieldService to interact with the API to save the custom field and a number of data properties to store the state of the popover and the custom field being created.

---

## User

create a *.stories.js file for storybook to go along with this component.

---

## Assistant

Here's an example of what the `*.stories.js` file for this component could look like using Storybook for Vue:

```
import { storiesOf } from '@storybook/vue';
import CustomFieldPopover from './CustomFieldPopover.vue';

storiesOf('CustomFieldPopover', module)
  .add('default', () => ({
    components: { CustomFieldPopover },
    template: '<custom-field-popover />',
    data() {
      return {
        customFieldTypes: [
          { id: 1, name: 'Text' },
          { id: 2, name: 'Number' },
          { id: 3, name: 'Date' },
        ],
      };
    },
  }))
  .add('with errors', () => ({
    components: { CustomFieldPopover },
    template: '<custom-field-popover :errors="errors" />',
    data() {
      return {
        errors: {
          name: ['Field name is required'],
          type: ['Field type is required'],
        },
        customFieldTypes: [
          { id: 1, name: 'Text' },
          { id: 2, name: 'Number' },
          { id: 3, name: 'Date' },
        ],
      };
    },
  }))
  .add('loading', () => ({
    components: { CustomFieldPopover },
    template: '<custom-field-popover :adding="true" />',
    data() {
      return {
        customFieldTypes: [
          { id: 1, name: 'Text' },
          { id: 2, name: 'Number' },
          { id: 3, name: 'Date' },
        ],
      };
    },
  }));
```
Here, I am importing the component and using the `.add()` method to create different stories for the component. I am passing different data properties to the component to demonstrate different scenarios, such as when there are errors, or when the component is loading. The `template` property inside each scenario is showing the component with it's name.
You will also need to import any other components that the component uses, in this case `PlusIcon`, `JovieDropdownMenu`, `GlassmorphismContainer
