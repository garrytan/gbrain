---
title: "New chat"
type: guide
created: 2023-01-18
updated: 2023-01-18
source: chatgpt-export
conversation_id: d66c3d83-f664-4bb5-a319-10b2353ba7ee
message_count: 4
tags: [chatgpt, import, code]
---
# New chat

> Conversation ID: d66c3d83-f664-4bb5-a319-10b2353ba7ee
> Created: 2023-01-18T20:45:45Z
> Updated: 2023-01-18T20:45:45Z
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
  name: 'CustomFieldsMenu',
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

This is a Vue.js template that utilizes various components such as Popover, Float, GlassmorphismContainer, InputGroup, ButtonGroup, ComboboxMenu and others to create a custom fields menu that allows users to add and edit fields. The template uses v-model to bind the data between the component and the data object and also uses v-if to conditionally render certain elements based on certain conditions. It also makes use of custom event handlers to handle user interactions and calls to a FieldService for managing the data.


---

## User

create a *.stories.js file for storybook to go along with this component.

---

## Assistant

Here is an example of what the `CustomFieldsMenu.stories.js` file could look like:

```
import { storiesOf } from '@storybook/vue';
import { withKnobs, text, boolean } from '@storybook/addon-knobs';
import CustomFieldsMenu from './CustomFieldsMenu.vue';
import { withInfo } from 'storybook-addon-vue-info';

storiesOf('CustomFieldsMenu', module)
  .addDecorator(withInfo)
  .addDecorator(withKnobs)
  .add('default', () => ({
    components: { CustomFieldsMenu },
    template: `<custom-fields-menu :isOpen="isOpen" :fieldType="fieldType" :errors="errors" :adding="adding" @saveCustomField="saveCustomField" />`,
    props: {
      isOpen: {
        default: boolean('isOpen', true)
      },
      fieldType: {
        default: text('fieldType', 'text')
      },
      errors: {
        default: text('errors', '{name: "Name is required"}')
      },
      adding: {
        default: boolean('adding', false)
      },
    },
    methods: {
      saveCustomField() {
        alert('Custom field added!');
      }
    }
  }));
```

This file uses the `storiesOf` method from the `@storybook/vue` package to create a new story for the `CustomFieldsMenu` component. It then adds the `withInfo` and `withKnobs` decorators to provide additional functionality to the story.

The `add` method is used to create a default story for the component and it utilizes a template with the `CustomFieldsMenu` component and sets the props and events that the component expects to receive. The `withKnobs` decorator is used to make the props of the component dynamic and able to change at runtime, so that the user can experiment with different values.

In the template, you can see that it binds the isOpen, fieldType, errors, adding props and saveCustomField event to the component.

The `saveCustomField` method is also added to the story's context to handle the save event and alert the user that the custom field has been added.

This is just a simple example of how the `CustomFieldsMenu.stories.js` file could be set up. You may need to adjust the file to match your specific requirements.



## See Also
- [[chatgpt/chatgpt_ai-chat-instrumentation-tools]]
- [[chatgpt/chatgpt_ai-chat-security-test]]
- [[chatgpt/chatgpt_ai-chat-test]]
- [[chatgpt/chatgpt_ai-sdk-chat-development]]
- [[chatgpt/chatgpt_chat-input-specs]]
