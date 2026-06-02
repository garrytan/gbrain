
<!-- This example requires Tailwind CSS v2.0+ -->
<template>
  <TransitionRoot as="template" :show="open">
    <Dialog as="div" class="relative z-10" @close="closeModal">
      <TransitionChild
        as="template"
        enter="ease-out duration-300"
        enter-from="opacity-0"
        enter-to="opacity-100"
        leave="ease-in duration-200"
        leave-from="opacity-100"
        leave-to="opacity-0">
        <div
          class="fixed inset-0 bg-slate-500 bg-opacity-75 transition-opacity" />
      </TransitionChild>

      <div class="fixed inset-0 z-10 overflow-y-auto">
        <div
          class="flex min-h-full items-end justify-center p-4 text-center sm:items-center sm:p-0">
          <TransitionChild
            as="template"
            enter="ease-out duration-300"
            enter-from="opacity-0 translate-y-4 sm:translate-y-0 sm:scale-95"
            enter-to="opacity-100 translate-y-0 sm:scale-100"
            leave="ease-in duration-200"
            leave-from="opacity-100 translate-y-0 sm:scale-100"
            leave-to="opacity-0 translate-y-4 sm:translate-y-0 sm:scale-95">
            <DialogPanel class="mx-auto w-full">
              <GlassmorphismContainer size="xl">
                <div class="relative w-full transform overflow-hidden">
                  <div>
                    <div class="mt-2" v-if="fromSocial">
                      <SocialInput
                        :list="list"
                        v-model="socialMediaProfileUrl"
                        @finishImport="closeModal" />
                    </div>
                    <div class="" v-else>
                      <form action="#" class="relative">
                        <div
                          class="overflow-hidden rounded-lg border border-gray-300 px-2 shadow-sm">
                          <!--  <ContactAvatar /> -->
                          <div class="mt-2 flex items-center justify-between">
                            <div class="flex items-center">
                              <div
                                class="inline-flex items-center rounded bg-gray-50 px-2 py-0.5 text-xs font-medium text-gray-600 shadow-sm ring-1 ring-inset ring-gray-500/10">
                                <InitialBox
                                  :name="
                                    currentUser.current_team.emoji ||
                                    currentUser.current_team.name
                                  "
                                  :height="12" />
                                <span class="ml-1"
                                  >{{ currentUser.current_team.name }}
                                </span>
                              </div>
                              <ChevronRightIcon class="mr-1 h-3 w-4" />
                              <span
                                class="items-center text-2xs font-semibold text-slate-400 dark:text-jovieDark-100"
                                >New contact</span
                              >
                            </div>
                            <button
                              type="button"
                              class="rounded-md text-slate-400 hover:text-slate-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 dark:bg-jovieDark-700 dark:text-jovieDark-300 dark:hover:text-slate-500"
                              @click="closeModal">
                              <span class="sr-only">Close</span>
                              <XMarkIcon class="h-6 w-6" aria-hidden="true" />
                            </button>
                          </div>
                          <div class="mt-4 flex w-full items-center px-4">
                            <div class="px-2">
                              <ContactAvatar
                                @updateAvatar="contact.profile_pic = $event"
                                :contact="contact"
                                :editable="true"
                                class="h-14 w-14 flex-shrink-0 text-gray-300" />
                            </div>

                            <div class="bg-red-500">
                              <label for="first_name" class="sr-only"
                                >First Name</label
                              >
                              <input
                                :width="firstNameWidth"
                                type="text"
                                :disabled="importing"
                                name="first_name"
                                tabindex="-1"
                                id="first_name"
                                class="z-20 block border-0 bg-transparent px-4 pt-2.5 text-lg font-bold tracking-tight placeholder-shown:w-28 placeholder-shown:text-slate-400 focus:ring-0 focus:placeholder:text-slate-300"
                                placeholder="First Name"
                                v-model="contact.first_name" />
                            </div>

                            <label for="first_name" class="sr-only"
                              >Last Name</label
                            >
                            <input
                              type="text"
                              :disabled="importing"
                              name="last_name"
                              tabindex="-1"
                              id="last_name"
                              class="block w-full border-0 bg-transparent pt-2.5 text-lg font-bold tracking-tight placeholder-shown:text-slate-400 focus:ring-0 focus:placeholder:text-slate-300"
                              placeholder="Last Name"
                              v-model="contact.last_name" />
                          </div>
                          <div
                            class="h-6 w-full justify-start py-1 text-xs text-red-600 dark:text-red-400">
                            <span v-if="errors.first_name">
                              {{ errors.first_name[0] }}</span
                            >
                          </div>

                          <label for="description" class="sr-only"
                            >Description</label
                          >
                          <!--  <textarea
                            rows="2"
                            name="description"
                            id="description"
                            class="block w-full resize-none border-0 py-0 text-gray-900 placeholder:text-gray-400 focus:ring-0 sm:text-sm sm:leading-6"
                            placeholder="Write a description..." /> -->
                          <div
                            class="mt-2 flex h-80 flex-col space-y-4 overflow-y-scroll px-4">
                            <template v-for="field in contactFields">
                              <DataInputGroup
                                v-model="contact[field.model]"
                                :id="field.model"
                                :disabled="importing"
                                :sortable="false"
                                :name="field.model"
                                :label="field.name"
                                :icon="field.icon"
                                :socialicon="field.socialicon"
                                :placeholder="field.placeholder"
                                type="text"
                                required="" />
                            </template>
                          </div>
                          <InputLists
                            @updateLists="updateContactLists"
                            :contactId="contact.id ?? 0"
                            :lists="contact.user_lists" />
                          <!-- Spacer element to match the height of the toolbar -->
                          <div aria-hidden="true">
                            <div class="py-2">
                              <div class="h-9" />
                            </div>
                            <div class="h-px" />
                            <div class="py-2">
                              <div class="py-px">
                                <div class="h-9" />
                              </div>
                            </div>
                          </div>
                        </div>
                        <div class="absolute inset-x-px bottom-0">
                          <div
                            class="flex items-center justify-between space-x-4 border-t border-gray-200 px-2 py-2">
                            <div
                              v-if="!enrichable"
                              class="flex w-full justify-end space-x-2">
                              <ButtonGroup
                                :loader="importing"
                                icon="UserPlusIcon"
                                design="secondary"
                                class="border"
                                text="Create contact" />
                            </div>
                            <div
                              v-else
                              class="flex w-full items-center justify-between">
                              <div
                                class="items-center text-xs font-light text-slate-400 dark:text-jovieDark-300">
                                Contact already exists. Override?
                                <CheckboxInput v-model="contact.override" />
                              </div>
                              <div class="flex items-center space-x-2">
                                <ButtonGroup
                                  design="secondary"
                                  icon="UserPlusIcon"
                                  class="border"
                                  size="sm"
                                  @click="importContact"
                                  :loader="importing"
                                  text="Create without enriching" />
                                <ButtonGroup
                                  :loader="importing"
                                  icon="SparklesIcon"
                                  size="sm"
                                  class="border"
                                  text="Create & Enrich" />
                              </div>
                            </div>
                          </div>
                        </div>
                      </form>
                    </div>
                  </div>
                </div>
              </GlassmorphismContainer>
            </DialogPanel>
          </TransitionChild>
        </div>
      </div>
    </Dialog>
  </TransitionRoot>
</template>

<script>
import {
  Dialog,
  DialogPanel,
  TransitionChild,
  TransitionRoot,
} from '@headlessui/vue';
import {
  XMarkIcon,
  UserGroupIcon,
  ChevronRightIcon,
} from '@heroicons/vue/24/outline';
import InitialBox from '../components/InitialBox.vue';
import SocialInput from '../components/SocialInput.vue';
import GlassmorphismContainer from '../components/GlassmorphismContainer.vue';
import InputGroup from './InputGroup.vue';
import ButtonGroup from './ButtonGroup.vue';
import ImportService from '../services/api/import.service';
import CheckboxInput from './CheckboxInput.vue';
import ContactAvatar from './ContactAvatar.vue';

import InputLists from './InputLists.vue';
import DataInputGroup from './DataInputGroup.vue';
export default {
  components: {
    DataInputGroup,
    CheckboxInput,
    ButtonGroup,
    InputGroup,
    Dialog,
    DialogPanel,
    TransitionChild,
    TransitionRoot,
    ContactAvatar,
    InputLists,
    ChevronRightIcon,
    UserGroupIcon,
    InitialBox,
    XMarkIcon,
    SocialInput,
    GlassmorphismContainer,
  },
  data() {
    return {
      importing: false,
      enrichable: false,
      contact: {
        id: 0,
        profile_pic: '',
        first_name: '',
        last_name: '',
        emails: '',
        phones: '',
        company: '',
        title: '',
        instagram: '',
        twitter: '',
        twitch: '',
        linkedin: '',
        titkok: '',
        snapchat: '',
        youtube: '',
        override: false,
        user_lists: [],
        list_id: [],
      },
      fields: [
        {
          name: 'First Name',
          icon: 'UserIcon',
          model: 'first_name',
          placeholder: 'First Name',
        },
        {
          name: 'Last Name',
          icon: 'UserIcon',
          model: 'last_name',
          placeholder: 'Last Name',
        },
        {
          name: 'Email',
          icon: 'EnvelopeIcon',
          model: 'emails',
          placeholder: 'Email',
        },
        {
          name: 'Phone',
          icon: 'PhoneIcon',
          model: 'phones',
          placeholder: 'Phone',
        },
        {
          name: 'Website',
          icon: 'LinkIcon',
          model: 'website',
          placeholder: 'Website',
        },
        {
          name: 'Instagram',
          socialicon: 'instagram',
          actionIcon2: 'ArrowTopRightOnSquareIcon',
          model: 'instagram',
          method2: 'instagramDMContact',
          placeholder: 'Instagram',
        },
        {
          name: 'Twitter',
          socialicon: 'twitter',
          model: 'twitter',

          placeholder: 'Twitter',
        },
        {
          name: 'TikTok',
          socialicon: 'tiktok',
          model: 'tiktok',
          placeholder: 'TikTok',
        },
        {
          name: 'Youtube',
          socialicon: 'youtube',
          model: 'youtube',
          placeholder: 'Youtube',
        },
        {
          name: 'Twitch',
          socialicon: 'twitch',
          model: 'twitch',
          placeholder: 'Twitch',
        },
        {
          name: 'Linkedin',
          socialicon: 'linkedin',
          model: 'linkedin',
          placeholder: 'Linkedin',
        },
      ],
      socialMediaProfileUrl: '',
      errors: {},
    };
  },
  props: {
    open: {
      type: Boolean,
      default: false,
    },
    list: {},
    fromSocial: {
      type: Boolean,
      default: false,
    },
  },
  watch: {
    list: {
      deep: true,
      immediate: true,
      handler(val) {
        if (val && val.id) {
          this.contact.user_lists = [];
          let payload = {
            list: val,
            add: true,
          };
          this.updateContactLists(payload);
        }
      },
    },
  },
  computed: {
    fistNameWidth() {
      //calculate the width of this.contact.first_name assuming every character is 8px and set a minimum value of 10px
      this.contact.first_name.length * 8 < 10
        ? 10
        : this.contact.first_name.length * 8;
    },
    contactFields() {
      return this.fields.filter(
        (field) =>
          field.model != 'override' &&
          field.model != 'list_id' &&
          field.model != 'first_name' &&
          field.model != 'last_name' &&
          field.model != 'profile_pic_url' &&
          field.model != 'profile_pic' &&
          field.model != 'id' &&
          field.model != 'user_lists'
      );
    },
  },
  methods: {
    closeModal() {
      this.$emit('closeModal');
      Object.assign(this.$data, this.$options.data());
    },
    pasteFromClipboard() {
      navigator.clipboard.readText().then((text) => {
        //set it as the socialMediaProfileUrl
        this.socialMediaProfileUrl = text;
      });
    },
    updateContactLists(payload) {
      if (payload.add) {
        if (
          !this.contact.user_lists.filter((l) => l.id === payload.list.id)
            .length
        ) {
          this.contact.user_lists.push(payload.list);
          console.log('this.contact.user_lists');
          console.log(this.contact.user_lists);
        }
        if (!this.contact.list_id.includes(payload.list.id)) {
          this.contact.list_id.push(payload.list.id);
        }
      } else {
        this.contact.user_lists = this.contact.user_lists.filter(
          (l) => l.id !== payload.list.id
        );
        this.contact.list_id = this.contact.list_id.filter(
          (id) => id !== payload.list.id
        );
      }
    },
    importContact() {
      this.importing = true;
      this.contact.list_id = this.contact.list_id
        ? this.contact.list_id
        : this.list
        ? this.list
        : '';
      let contact = JSON.parse(JSON.stringify(this.contact));
      contact.profile_pic_url = contact.profile_pic;
      ImportService.importContact(contact)
        .then((response) => {
          response = response.data;
          if (response.status) {
            this.$notify({
              group: 'user',
              type: 'success',
              title: 'Imported',
              text: response.message,
            });
            this.closeModal();
            this.$emit('contactImported', {
              contact: response.contact,
              list: response.list,
            });
          } else {
            this.$notify({
              group: 'user',
              type: 'error',
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
          this.importing = false;
        });
    },
  },
};
</script>

im trying to dynamically set the width of the first name input based on the width of the text inside it, but i dont think i did it right. can you fix it


The provided code appears to be a Vue.js template for a dialog or modal component. It uses the Tailwind CSS framework for styling. Here's a breakdown of the structure and components used:

Components imported:
- `Dialog` and `DialogPanel` from `@headlessui/vue`: These components provide the base structure for the dialog/modal.
- `TransitionChild` and `TransitionRoot` from `@headlessui/vue`: These components enable transitions/animations when showing and hiding the dialog/modal.
- `XMarkIcon`, `UserGroupIcon`, and `ChevronRightIcon` from `@heroicons/vue/24/outline`: These are icons used within the dialog/modal.
- `InitialBox` from a custom component file: This component represents an initial box with a user's initials or team emoji.
- `SocialInput` from a custom component file: This component handles input for social media profiles.
- `GlassmorphismContainer` from a custom component file: This component creates a glassmorphism effect for the container.

The template structure:
- `TransitionRoot` and `Dialog` components wrap the entire dialog/modal structure. `TransitionRoot` manages the show/hide state, and `Dialog` represents the modal itself.
- Inside `Dialog`, there are two `TransitionChild` components. These handle the transitions for the overlay and the dialog content.
- The dialog content is wrapped inside `DialogPanel` and `GlassmorphismContainer`. `DialogPanel` provides a container for the dialog content, and `GlassmorphismContainer` creates the glassmorphism effect.
- Inside `GlassmorphismContainer`, there's a `div` with the class "relative w-full transform overflow-hidden". This contains the actual dialog content.
- The dialog content includes conditional rendering based on the `fromSocial` property. If `fromSocial` is true, it renders `SocialInput` component; otherwise, it renders a form with various input fields.
- Input fields are implemented using `<input>` elements with various attributes and classes for styling. The `v-model` directive is used to bind input values to `contact` data properties.
- There are also other custom components such as `ContactAvatar`, `DataInputGroup`, `InputLists`, `CheckboxInput`, and `ButtonGroup` that are used for specific functionalities within the dialog.

The script section defines the component's logic, including data properties, computed properties, methods, and props.

Please note that this code alone may not be fully functional as it relies on custom components and services not provided in the given code snippet.


im trying to dynamically set the width of the first name input based on the width of the text inside it, but i dont think i did it right. can you fix it

use the code i provide in previous question


Certainly! To dynamically set the width of the first name input based on the width of the text inside it, you can use JavaScript to calculate the width of the text and apply it to the input element. Here's an updated version of your code that achieves this:

```html
<!DOCTYPE html>
<html>
  <head>
    <style>
      #firstName {
        width: auto;
        padding: 5px;
      }
    </style>
    <script>
      window.onload = function() {
        var firstNameInput = document.getElementById("firstName");
        var textWidth =
