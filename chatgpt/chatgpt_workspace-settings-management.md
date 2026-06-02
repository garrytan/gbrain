---
title: "Workspace Settings Management."
type: guide
created: 2023-05-04
updated: 2023-05-04
source: chatgpt-export
conversation_id: d501ecea-088c-4237-a713-59a7d2ce6345
message_count: 4
tags: [chatgpt, import, code, long-form]
---
# Workspace Settings Management.

> Conversation ID: d501ecea-088c-4237-a713-59a7d2ce6345
> Created: 2023-05-04T18:50:12Z
> Updated: 2023-05-04T18:51:34Z
> Messages: 4

---

## User

<template>
  <div class="mx-auto w-full py-10 sm:px-6 lg:px-8">
    <SectionHeader
      header="Workspace"
      subheader="Manage your workspace settings" />
    <div class="flex w-full">
      <div class="w-full">
        <h3 class="text-base font-semibold leading-6 text-gray-900">
          Plan Usage
        </h3>

        <dl class="mt-5 grid w-full grid-cols-1 gap-5 sm:grid-cols-3">
          <div
            v-for="item in stats"
            :key="item.name"
            class="overflow-hidden rounded-lg border border-slate-300 px-4 py-5 dark:border-jovieDark-border sm:p-6">
            <dt
              class="truncate text-sm font-medium text-slate-900 dark:text-jovieDark-100">
              {{ item.name }}
            </dt>
            <ProgressBar
              :percentage="Math.round((item.stat / item.limit) * 100)" />

            <dd
              class="mt-1 text-3xl font-semibold tracking-tight text-slate-900 dark:text-jovieDark-100">
              {{ item.stat }} / {{ item.limit }}
            </dd>
          </div>
        </dl>
      </div>
    </div>

    <div class="md:grid md:grid-cols-3 md:gap-6">
      <div class="mt-5 md:col-span-2 md:mt-0">
        <div
          x-data="{photoName: null, photoPreview: null}"
          class="px-4 py-5 sm:p-6">
          <div v-if="teamSetting" class="relative flex flex-col gap-y-3">
            <!-- Password -->
            <div
              v-for="(teamSetting, index) in teamSettings"
              :key="index"
              class="flex h-6 items-center">
              <JovieSpinner v-if="updating" />
              <CheckboxInput
                class="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-600"
                :checked="teamSetting.value == 1 ? true : false"
                v-model="teamSetting.value"
                :name="teamSetting.key"
                :disabled="updating" />
              <label
                class="ml-2 text-xs font-medium text-slate-900 dark:text-jovieDark-100"
                :for="teamSetting.key"
                >{{ unSlugify(teamSetting.key) }}</label
              >
            </div>

            <!-- Password -->
          </div>
          <div
            v-else
            class="flex h-6 w-40 animate-pulse items-center bg-slate-700 dark:bg-jovieDark-700"></div>
        </div>
      </div>
    </div>
    <div class="mt-6 flex items-center justify-end gap-x-6">
      <button
        type="submit"
        @click="updateTeamSettings()"
        :disabled="updating"
        class="rounded-md bg-indigo-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600">
        Save
      </button>
    </div>

    <div class="hidden sm:block">
      <div class="py-8">
        <div
          class="border-t border-slate-200 dark:border-jovieDark-border"></div>
      </div>
    </div>
  </div>
</template>

<script>
import CheckboxInput from '../CheckboxInput.vue';
import ButtonGroup from '../../components/ButtonGroup.vue';
import StatCard from '../../components/StatCard.vue';
import TeamService from '../../services/api/team.service';
import SectionHeader from '../../components/SectionHeader.vue';
import ProgressBar from '../../components/ProgressBar.vue';
import JovieSpinner from '../../components/JovieSpinner.vue';

export default {
  name: 'AccountTeamSetting',
  components: {
    ButtonGroup,
    CheckboxInput,
    SectionHeader,
    StatCard,
    JovieSpinner,
    ProgressBar,
  },
  data() {
    return {
      errors: {},
      updating: false,
      setting: {
        key: null,
        value: null,
      },
      stats: [
        { name: 'Contacts', stat: '3', limit: '100' },
        { name: 'AI Credits', stat: '100', limit: '500' },
        { name: 'Enrichment Credits', stat: '58', limit: '100' },
        { name: 'AI Field Credits', stat: '12', limit: '100' },
      ],
      //add an object called stats and put the number of AI Credits, Enrich Credits, and Contacts used

      teamSettings: {},
    };
  },
  props: {
    onboarding: {
      type: Boolean,
      default: false,
    },
  },
  mounted() {
    this.getTeamSettings();
    window.analytics.page('Manage Security');
  },
  methods: {
    getTeamSettings() {
      TeamService.getTeamSetting()
        .then((response) => {
          response = response.data;
          this.teamSettings = response.data;
          console.log('TeamSetting', response);
          if (response.status) {
            this.errors = {};
          }
        })
        .catch((error) => {
          error = error.response;
          if (error.status == 422) {
            this.errors = error.data.errors;
          }
        })
        .finally(() => {
          this.updating = false;
        });
    },
    updateTeamSettings() {
      this.updating = true;
      let data = { teamSettings: this.teamSettings };
      TeamService.updateTeamSettings(data)
        .then((response) => {
          response = response.data;
          this.TeamSettings = response.data;
          console.log('UpdateSetting', response);
          if (response.status) {
            this.errors = {};
            this.$notify({
              group: 'user',
              title: 'Successful',
              text: response.message,
              type: 'success',
            });
          }
        })
        .catch((error) => {
          error = error.response;
          if (error.status == 422) {
            this.errors = error.data.errors;
          }
        })
        .finally(() => {
          this.updating = false;
        });
    },
  },
};
</script>

<style scoped></style>


---

## Assistant

This is a Vue.js single-file component that shows workspace settings that can be managed by a user. The template section contains the HTML code, which consists of two main sections. 

The first section is a `SectionHeader` component with two props: `header` and `subheader`, that displays the text "Workspace" and "Manage your workspace settings", respectively.

The second section shows the current plan usage of the workspace. The plan usage is presented in four `StatCard` components that show the number of contacts, AI credits, enrichment credits, and AI field credits used by the workspace, respectively. These cards are arranged in a `dl` element, where each card is displayed in a `div` element that contains the `name`, `stat`, and `limit` data for the corresponding plan.

The third section displays the team settings of the workspace. The team settings are shown in a `div` element that contains a list of `CheckboxInput` components. Each checkbox represents a team setting, which is stored in the `teamSettings` object in the component's data. This object is populated by a call to the `getTeamSettings` method, which retrieves the current team settings using the `TeamService.getTeamSetting` method. Once the `teamSettings` object is populated, the `CheckboxInput` components are generated using a `v-for` loop that iterates over each item in the `teamSettings` object.

Below the list of `CheckboxInput` components, there is a `Save` button that is disabled when the `updating` flag is set to `true`, indicating that a request to update the team settings is already in progress. When the button is clicked, the `updateTeamSettings` method is called, which sends a request to the server to update the team settings using the `TeamService.updateTeamSetting` method. Once the request is completed, the `updating` flag is set to `false`, and the `getTeamSettings` method is called again to update the `teamSettings` object with the new values.

---

## User

the v-if checking for teamsetting needs to check if there is any value in teamsetting. if it is an empty array then it should trigger the v-else. is this setup right?

---

## Assistant

Yes, your understanding is correct. If you want to check whether `teamsetting` has any value, you can use the `v-if` directive with a condition that checks if the `teamsetting` variable is not empty, like this:

```
<div v-if="teamsetting.length > 0">
  <!-- Render content if teamsetting is not empty -->
</div>

<div v-else>
  <!-- Render content if teamsetting is an empty array -->
</div>
```

This code will check if `teamsetting` has any items in it by checking the `length` property. If `teamsetting` is not empty, the first `div` will be rendered, and if it is empty, the second `div` will be rendered.

Note that you can also use `v-if` and `v-else` together without checking for an empty array explicitly, like this:

```
<div v-if="teamsetting">
  <!-- Render content if teamsetting has a value -->
</div>

<div v-else>
  <!-- Render content if teamsetting is undefined or null -->
</div>
```

This code will check if `teamsetting` is truthy or falsy. If `teamsetting` is truthy (i.e., it has a value), the first `div` will be rendered, and if it is falsy (i.e., it is undefined, null, or an empty array), the second `div` will be rendered.
