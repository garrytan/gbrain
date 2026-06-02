---
title: "Update team settings form."
type: note
created: 2023-05-04
updated: 2023-05-04
source: chatgpt-export
conversation_id: a97cd782-9294-4d2f-8125-b8ac7d8cbe3a
message_count: 4
tags: [chatgpt, import]
---
# Update team settings form.

> Conversation ID: a97cd782-9294-4d2f-8125-b8ac7d8cbe3a
> Created: 2023-05-04T02:36:20Z
> Updated: 2023-05-04T02:37:01Z
> Messages: 4

---

## User

<template>
  <div class="mx-auto max-w-7xl py-10 sm:px-6 lg:px-8">
    <div class="md:grid md:grid-cols-3 md:gap-6">
      <div class="flex justify-between md:col-span-1">
        <div class="px-4 sm:px-0">
          <h3
            class="text-lg font-medium text-slate-900 dark:text-jovieDark-100">
            Team Settings
          </h3>

          <p class="mt-1 text-sm text-slate-600 dark:text-jovieDark-300">
            Update your team preferences
          </p>
        </div>

        <div class="px-4 sm:px-0"></div>
      </div>

      <div class="flex">
        <StatCard v-for="stat in stats" />
      </div>

      <div class="mt-5 md:col-span-2 md:mt-0">
        <div
          x-data="{photoName: null, photoPreview: null}"
          class="bg-white px-4 py-5 shadow dark:bg-jovieDark-800 sm:rounded-tl-md sm:rounded-tr-md sm:p-6">
          <div class="grid grid-cols-6 gap-6">
            <!-- Password -->
            <div
              v-for="(teamSetting, index) in teamSettings"
              :key="index"
              class="col-span-6 sm:col-span-4">
              <CheckboxInput
                :checked="teamSetting.value == 1 ? true : false"
                v-model="teamSetting.value"
                :name="teamSetting.key"
                :disabled="updating" />
              <label :for="teamSetting.key">{{
                unSlugify(teamSetting.key)
              }}</label>
            </div>
          </div>
        </div>

        <div
          class="flex items-center justify-end bg-slate-50 px-4 py-3 text-right shadow dark:bg-jovieDark-900 dark:bg-jovieDark-900 sm:rounded-bl-md sm:rounded-br-md sm:px-6">
          <ButtonGroup
            type="submit"
            design="primary"
            text="Save"
            @click="updateTeamSettings()"
            :disabled="updating">
          </ButtonGroup>
        </div>
      </div>
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

export default {
  name: 'AccountTeamSetting',
  components: {
    ButtonGroup,
    CheckboxInput,
    StatCard,
  },
  data() {
    return {
      errors: {},
      updating: false,
      setting: {
        key: null,
        value: null,
      },
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

This is a Vue.js single-file component that displays a form for updating team settings. The component imports several other components such as CheckboxInput, ButtonGroup, and StatCard, and a service called TeamService that communicates with an API to retrieve and update team settings.

The component template consists of a container element with a max width of 7xl, a grid layout with 3 columns for displaying the team settings and some stats in the second column, and a save button at the bottom. The first column has a title and a description of the form, and the third column is empty. The second column displays several checkboxes with their labels to update team settings.

The component data contains several properties such as errors for handling errors, updating to indicate when an update is in progress, setting to hold the currently selected setting, and teamSettings to store the retrieved team settings. The component also receives a prop called onboarding which is a Boolean that is false by default.

The component has two methods: getTeamSettings and updateTeamSettings. The getTeamSettings method retrieves the team settings by calling the TeamService.getTeamSetting() function and sets the teamSettings property to the response data. The updateTeamSettings method updates the team settings by calling the TeamService.updateTeamSettings() function with the updated data and sets the teamSettings property to the response data.

Overall, this component provides a user interface for updating team settings and communicates with an API to make the necessary updates.

---

## User

i need to display that stats for the following data


<template>
  <div class="mx-auto max-w-7xl py-10 sm:px-6 lg:px-8">
    <div class="md:grid md:grid-cols-3 md:gap-6">
      <div class="flex justify-between md:col-span-1">
        <div class="px-4 sm:px-0">
          <h3
            class="text-lg font-medium text-slate-900 dark:text-jovieDark-100">
            Team Settings
          </h3>

          <p class="mt-1 text-sm text-slate-600 dark:text-jovieDark-300">
            Update your team preferences
          </p>
        </div>

        <div class="px-4 sm:px-0"></div>
      </div>

      <div class="flex">
        <StatCard v-for="stat in stats" />
      </div>

      <div class="mt-5 md:col-span-2 md:mt-0">
        <div
          x-data="{photoName: null, photoPreview: null}"
          class="bg-white px-4 py-5 shadow dark:bg-jovieDark-800 sm:rounded-tl-md sm:rounded-tr-md sm:p-6">
          <div class="grid grid-cols-6 gap-6">
            <!-- Password -->
            <div
              v-for="(teamSetting, index) in teamSettings"
              :key="index"
              class="col-span-6 sm:col-span-4">
              <CheckboxInput
                :checked="teamSetting.value == 1 ? true : false"
                v-model="teamSetting.value"
                :name="teamSetting.key"
                :disabled="updating" />
              <label :for="teamSetting.key">{{
                unSlugify(teamSetting.key)
              }}</label>
            </div>
          </div>
        </div>

        <div
          class="flex items-center justify-end bg-slate-50 px-4 py-3 text-right shadow dark:bg-jovieDark-900 dark:bg-jovieDark-900 sm:rounded-bl-md sm:rounded-br-md sm:px-6">
          <ButtonGroup
            type="submit"
            design="primary"
            text="Save"
            @click="updateTeamSettings()"
            :disabled="updating">
          </ButtonGroup>
        </div>
      </div>
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

export default {
  name: 'AccountTeamSetting',
  components: {
    ButtonGroup,
    CheckboxInput,
    StatCard,
  },
  data() {
    return {
      errors: {},
      updating: false,
      setting: {
        key: null,
        value: null,
      },
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

Unfortunately, the data necessary to display any statistics is not provided in the code you have provided. Can you please provide the necessary data for me to assist you in displaying the stats?
