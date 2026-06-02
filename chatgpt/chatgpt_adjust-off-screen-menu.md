---
title: "Adjust Off-Screen Menu"
type: guide
created: 2023-06-09
updated: 2023-06-09
source: chatgpt-export
conversation_id: b0b2fd6e-6a4c-41eb-bb4a-7efb4ffb3ce1
message_count: 4
tags: [chatgpt, import, code]
---
# Adjust Off-Screen Menu

> Conversation ID: b0b2fd6e-6a4c-41eb-bb4a-7efb4ffb3ce1
> Created: 2023-06-09T00:58:15Z
> Updated: 2023-06-09T01:01:36Z
> Messages: 4

---

## User

<template>
  <teleport to="#crm">
    <div
      ref="rightClickMenu"
      style="z-index: 9999"
      :style="{ top: y + 'px', left: x + 'px' }"
      class="absolute">
      <Menu>
        <TransitionRoot
          :show="show"
          enter-active-class="transition ease-out duration-100"
          enter-from-class="transform opacity-0 scale-95"
          enter-to-class="transform opacity-100 scale-100"
          leave-active-class="transition ease-in duration-75"
          leave-from-class="transform opacity-100 scale-100"
          leave-to-class="transform opacity-0 scale-95">
          <MenuItems as="div" :style="{ top: y + 'px', left: x + 'px' }" static>
            <GlassmorphismContainer
              style="z-index: 9999"
              class="z-10 mt-2 w-48 origin-top-right px-1 py-1 ring-1 ring-black ring-opacity-5 focus-visible:outline-none">
              <div class="py-1">
                <DropdownMenuItem
                  @click="$emit('checkContactsEnrichable', contact.id)"
                  :name="'Enrich'"
                  icon="SparklesIcon" />

                <DropdownMenuItem separator />

                <ContactContextMenuItem
                  :contact="contact"
                  :contactMethods="[
                    'email',
                    'phone',
                    'sms',
                    'calendar',
                    'instagram',

                    'twitter',

                    'whatsapp',
                    'separator',
                    'validate',
                  ]">
                </ContactContextMenuItem>
                <DropdownMenuItem
                  name="AddToList"
                  submenu
                  icon="QueueListIcon" />
                <DropdownMenuItem
                  v-if="filters.list"
                  name="Remove from list"
                  icon="TrashIcon"
                  danger
                  @click="
                    $emit(
                      'toggleContactsFromList',
                      contact.id,
                      filters.list,
                      true
                    )
                  " />
                <DropdownMenuItem separator />

                <DropdownMenuItem
                  v-if="currentUser.is_admin"
                  name="Refresh"
                  icon="ArrowPathIcon"
                  @click="$emit('refresh', contact)" />

                <DropdownMenuItem
                  :name="
                    filters.type == 'archived' && contact.archived
                      ? 'Unarchive'
                      : 'Archive'
                  "
                  danger
                  icon="ArchiveBoxIcon"
                  @blur="$emit('updateContact')"
                  @click="
                    $emit('archive-contacts', contact.id, !contact.archived)
                  " />
              </div>
            </GlassmorphismContainer>
          </MenuItems>
        </TransitionRoot>
      </Menu>
    </div>
  </teleport>
</template>
<script>
import ContactContextMenu from './ContactContextMenu.vue';
import ContactContextMenuItem from './ContactContextMenuItem.vue';
import DropdownMenuItem from './DropdownMenuItem.vue';
import { Menu, MenuButton, MenuItems, TransitionRoot } from '@headlessui/vue';
import { CloudArrowDownIcon } from '@heroicons/vue/24/solid';
import GlassmorphismContainer from './GlassmorphismContainer.vue';

export default {
  components: {
    ContactContextMenu,
    ContactContextMenuItem,
    DropdownMenuItem,
    Menu,
    MenuButton,
    MenuItems,
    TransitionRoot,
    CloudArrowDownIcon,
    GlassmorphismContainer,
  },
  mounted() {
    document.addEventListener('click', this.closeMenu);
  },
  beforeUnmount() {
    document.removeEventListener('click', this.closeMenu);
  },
  methods: {
    hideMenu() {
      console.log('hide menu');
      //emit event to parent
      this.$emit('hide-menu');
    },

    closeMenu(event) {
      //if click outside of menu and trigger is not menu-button then hideMenu()
      if (
        !this.$refs.rightClickMenu.contains(event.target) &&
        this.trigger !== 'menu-button'
      ) {
        this.hideMenu();
        console.log('Menu closed' + this.trigger);
      }
    },
  },
  //add props
  props: {
    contact: {
      type: Object,
      required: false,
    },
    show: {
      type: Boolean,
      default: false,
    },
    trigger: {
      type: String,
      default: 'right-click',
    },
    x: {
      type: Number,
      default: 0,
    },
    y: {
      type: Number,
      default: 0,
    },
    filters: {
      required: false,
    },
  },
};
</script>

modify this vue component so it handles situations where the menu opens offscreen or partially offscreen

---

## Assistant

Sure, to make the component handle situations where the menu opens off-screen or partially off-screen, we could implement a mechanism that checks if the menu is within the viewport bounds. If it isn't, we can adjust the position of the menu accordingly.

```vue
<template>
  ...
</template>
<script>
import ...

export default {
  ...
  mounted() {
    ...
    this.$nextTick(() => {
      this.repositionMenu();
    });
  },
  ...
  methods: {
    ...
    repositionMenu() {
      const menuElement = this.$refs.rightClickMenu;
      const rect = menuElement.getBoundingClientRect();
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
      const viewportWidth = window.innerWidth || document.documentElement.clientWidth;

      if (rect.right > viewportWidth) {
        this.x = viewportWidth - rect.width - 10;  // padding from right edge
      }
      if (rect.bottom > viewportHeight) {
        this.y = viewportHeight - rect.height - 10;  // padding from bottom edge
      }
    }
  },
  ...
};
</script>
```

This code uses the `getBoundingClientRect` function to get the size of the menu and its position relative to the viewport. Then it checks if any part of the menu is outside the viewport (on the right or bottom edge). If it is, the position of the menu is adjusted to fit within the viewport. We call the `repositionMenu` method right after the component has been mounted and the DOM is ready, which is the perfect time to manipulate the position of the menu. 

It's important to note that this solution only accounts for situations where the menu opens off the right or bottom edge of the screen. You could easily expand the `repositionMenu` method to also handle situations where the menu opens off the left or top edge of the screen, but such situations are less common (usually the user will trigger the menu somewhere in the middle of the screen, so it's more likely to open off the right or bottom edge than the left or top edge).

Another thing to keep in mind is that this solution assumes the page doesn't have any scrollbars. If your page does have scrollbars, you'll have to take the scroll position into account when calculating the position of the menu.

---

## User

this gives an unexpected mutation of the y prop

---

## Assistant

I apologize for that oversight. In Vue, we should not directly mutate the value of a prop inside a child component. Instead, we can make use of Vue's reactivity system by creating local data properties that will react to changes in the prop values.

Here is an updated version of the code:

```vue
<template>
  ...
</template>
<script>
import ...

export default {
  ...
  data() {
    return {
      localX: this.x,
      localY: this.y,
    };
  },
  watch: {
    x(newVal) {
      this.localX = newVal;
    },
    y(newVal) {
      this.localY = newVal;
    },
  },
  mounted() {
    ...
    this.$nextTick(() => {
      this.repositionMenu();
    });
  },
  ...
  methods: {
    ...
    repositionMenu() {
      const menuElement = this.$refs.rightClickMenu;
      const rect = menuElement.getBoundingClientRect();
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
      const viewportWidth = window.innerWidth || document.documentElement.clientWidth;

      if (rect.right > viewportWidth) {
        this.localX = viewportWidth - rect.width - 10;  // padding from right edge
      }
      if (rect.bottom > viewportHeight) {
        this.localY = viewportHeight - rect.height - 10;  // padding from bottom edge
      }
    }
  },
  ...
};
</script>
```

In the updated code, we have two new local data properties, `localX` and `localY`, which are initialized with the values of `x` and `y` respectively. These local data properties are what we will be updating within the `repositionMenu` method, instead of the props directly. We also add watchers for the `x` and `y` props, so that when these props change, the new values are reflected in `localX` and `localY`. Then, you'll need to adjust your template code to use these local variables, `localX` and `localY` instead of the props `x` and `y`.
