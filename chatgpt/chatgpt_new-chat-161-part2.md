
<template>
  <div class="h-full w-full flex-col overflow-y-scroll">
    <div class="flex h-full w-full flex-col">
      <div class="h-full pb-10">
        <div
          class="flex w-full items-center justify-between border-slate-300 bg-white px-2 py-2 dark:border-jovieDark-border dark:bg-jovieDark-900">
          <div class="w-full items-center px-4">
            <h1
              v-if="header.includes('all')"
              class="flex items-center text-sm font-semibold capitalize text-slate-900 dark:text-jovieDark-100">
              <UserGroupIcon
                class="mr-1 h-4 w-4 rounded-md text-purple-400"
                aria-hidden="true" />
              {{ header + ' Contacts' }}
            </h1>
            <h1
              v-else-if="header.includes('favourites')"
              class="flex items-center text-sm font-semibold capitalize text-slate-900 dark:text-jovieDark-100">
              <HeartIcon
                class="mr-1 h-4 w-4 rounded-md text-red-400"
                aria-hidden="true" />
              Favorited
            </h1>
            <h1
              v-else
              class="flex items-center text-sm font-semibold capitalize text-slate-900 dark:text-jovieDark-100">
              <UserIcon
                class="mr-1 h-4 w-4 rounded-md text-sky-400"
                aria-hidden="true" />
              {{ header }}
            </h1>
            <p
              v-if="header.includes('all')"
              class="text-2xs font-light text-slate-600">
              {{ subheader.total }} Contacts
            </p>

            <p v-else class="text-2xs font-light text-slate-600">
              {{ subheader[header] }} Contacts
            </p>
          </div>
          <div class="flex h-6 w-full content-end items-center">
            <div
              class="group flex h-full w-full cursor-pointer content-end items-center justify-end gap-2 py-2 text-right transition-all duration-150 ease-out">
              <!-- <div class="group">
                trigger
                <span
                  data-tooltip="test"
                  class="backfdrop-filter absolute z-50 hidden w-auto flex-col items-center justify-between rounded-md border border-slate-300 bg-slate-800 px-2 py-1 text-xs text-slate-50 shadow-lg backdrop-blur-2xl backdrop-saturate-150 group-hover:flex"
                  >test content</span
                >
              </div> -->

              <TransitionRoot
                :show="searchVisible"
                enter="transition-opacity duration-75"
                enter-from="opacity-0"
                enter-to="opacity-100"
                leave="transition-opacity duration-0"
                leave-from="opacity-100"
                leave-to="opacity-0">
                <div
                  class="flex h-6 w-full items-center justify-end transition-all">
                  <div
                    class="flex items-center rounded-md border border-slate-300 dark:border-jovieDark-border dark:bg-jovieDark-700">
                    <div
                      class="content-right relative flex flex-grow items-center py-1 focus-within:z-10">
                      <div
                        class="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
                        <MagnifyingGlassIcon
                          class="h-4 w-4 text-slate-400 dark:text-jovieDark-600"
                          aria-hidden="true" />
                      </div>
                      <input
                        placeholder="Press /  to search"
                        ref="searchInput"
                        v-model="searchQuery"
                        class="rounded-m block w-full border-slate-300 py-0.5 pl-10 ring-0 focus:outline-0 focus-visible:border-none focus-visible:ring-0 dark:border-jovieDark-border dark:bg-jovieDark-700 dark:text-jovieDark-100 dark:placeholder:text-slate-400 sm:text-sm" />

                      <div
                        @click="toggleSearchVisible()"
                        class="group absolute inset-y-0 right-0 flex items-center pr-3">
                        <XMarkIcon
                          class="h-4 w-4 cursor-pointer rounded-md p-0.5 text-slate-400 transition-all duration-150 group-hover:bg-slate-100 group-hover:text-slate-600 dark:bg-jovieDark-800 dark:text-jovieDark-300 dark:group-hover:bg-jovieDark-800"
                          aria-hidden="true" />
                      </div>
                    </div>
                  </div>
                </div>
              </TransitionRoot>
              <div v-if="!searchVisible">
                <JovieTooltip
                  text="Search"
                  class="w-full justify-end"
                  arrow
                  placement="right-start"
                  ><template #content
                    ><KeyboardShortcut text="/" /> to search</template
                  >
                  <ButtonGroup
                    :design="'toolbar'"
                    :text="'Search'"
                    icon="MagnifyingGlassIcon"
                    hideText
                    @click="toggleSearchVisible()" />
                </JovieTooltip>
              </div>
              <!--  <div
                class="group flex cursor-pointer items-center rounded-md px-2 py-2 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 disabled:opacity-30"
                v-else>
                <MagnifyingGlassIcon
                  @click="toggleSearchVisible()"
                  class="h-5 w-5 text-slate-400 dark:text-jovieDark-600 group-hover:text-slate-600" />
              </div> -->
            </div>
            <div class="flex items-center">
              <div class="group h-full cursor-pointer items-center">
                <Menu v-slot="{ open }" class="items-center">
                  <Float portal class="pr-2" :offset="4" placement="bottom-end">
                    <MenuButton class="inline-flex items-center">
                      <!--  <AdjustmentsHorizontalIcon
                        class="h-5 w-5 font-bold text-slate-400 dark:text-jovieDark-600 group-hover:text-slate-600"
                        aria-hidden="true" /> -->
                      <JovieTooltip
                        text="Adjustments"
                        class="w-full justify-end"
                        arrow
                        placement="bottom-end"
                        ><template #content
                          ><KeyboardShortcut text="/" /> to search</template
                        >
                        <ButtonGroup
                          :design="'toolbar'"
                          :text="'Hide Columns'"
                          icon="AdjustmentsHorizontalIcon"
                          hideText />
                      </JovieTooltip>
                    </MenuButton>
                    <TransitionRoot
                      :show="open"
                      enter-active-class="transition duration-100 ease-out"
                      enter-from-class="transform scale-95 opacity-0"
                      enter-to-class="transform scale-100 opacity-100"
                      leave-active-class="transition duration-75 ease-in"
                      leave-from-class="transform scale-100 opacity-100"
                      leave-to-class="transform scale-95 opacity-0">
                      <MenuItems @focus="focusTableColumnFilterInput()" static>
                        <GlassmorphismContainer
                          class="w-60 flex-col rounded-md py-2 pl-2 pr-1 ring-0 focus:ring-0">
                          <!--  <div as="div">
                          <div
                            class="flex items-center justify-between border-b border-slate-300 dark:border-jovieDark-border  py-1">
                            <div
                              class="text-xs font-bold text-slate-500 line-clamp-1">
                              Display Columns
                            </div>
                          </div>
                        </div> -->
                          <div class="px-1">
                            <MenuItem v-slot="{ active }" as="div">
                              <div class="relative flex items-center">
                                <input
                                  ref="tableColumnFilterInput"
                                  v-model="tableViewSearchQuery"
                                  placeholder="Add columns..."
                                  class="w-full border-0 border-none border-transparent bg-transparent px-1 py-2 text-xs font-medium text-slate-600 outline-0 ring-0 placeholder:font-light placeholder:text-slate-400 focus:border-transparent focus:ring-0 focus:ring-transparent focus:ring-offset-0 dark:bg-jovieDark-800 dark:text-jovieDark-300" />
                                <!-- <div
                                class="absolute inset-y-0 right-0 flex py-2 pr-1.5">
                                <kbd
                                  class="inline-flex items-center rounded border border-slate-300 dark:border-jovieDark-border  px-1 font-sans text-2xs font-medium text-slate-400"
                                  >S</kbd
                                >
                              </div> -->
                              </div>
                            </MenuItem>
                          </div>
                          <MenuItem
                            as="div"
                            v-slot="{ active }"
                            v-for="(column, index) in filteredColumnList">
                            <SwitchGroup>
                              <SwitchLabel
                                class="flex items-center rounded-md"
                                :class="{
                                  'bg-slate-300 text-white dark:bg-jovieDark-700 dark:text-jovieDark-300':
                                    active,
                                }">
                                <button
                                  class="group flex w-full items-center justify-between rounded-md px-2 py-1 text-xs font-medium text-slate-700 dark:text-jovieDark-300">
                                  <div class="flex items-center">
                                    <component
                                      :is="column.icon"
                                      :active="active"
                                      class="mr-2 h-3 w-3 text-slate-400 dark:text-jovieDark-200"
                                      aria-hidden="true" />
                                    <span class="line-clamp-1">{{
                                      column.name
                                    }}</span>
                                  </div>

                                  <Switch
                                    name="columns-visible"
                                    v-model="column.visible"
                                    as="template"
                                    v-slot="{ checked }">
                                    <button
                                      :class="
                                        checked
                                          ? 'bg-indigo-600 dark:bg-indigo-400'
                                          : 'bg-slate-200 dark:bg-jovieDark-800'
                                      "
                                      class="relative inline-flex h-4 w-6 items-center rounded-full border border-slate-300 dark:border-jovieDark-border">
                                      <span class="sr-only"
                                        >Show/hide column</span
                                      >
                                      <span
                                        :class="
                                          checked
                                            ? 'translate-x-3'
                                            : 'translate-x-0'
                                        "
                                        class="inline-block h-3 w-3 transform rounded-full bg-white transition dark:bg-jovieDark-900" />
                                    </button>
                                  </Switch>
                                </button>
                              </SwitchLabel>
                            </SwitchGroup>
                          </MenuItem>
                          <div
                            class="text-medium border-t border-slate-300 dark:border-jovieDark-border">
                            <MenuItem
                              v-slot="{ active }"
                              v-for="setting in settings">
                              <SwitchGroup>
                                <SwitchLabel
                                  class="flex items-center rounded-md"
                                  :class="{
                                    'bg-slate-300 text-white dark:bg-jovieDark-700 dark:text-jovieDark-200':
                                      active,
                                  }">
                                  <button
                                    class="group flex w-full items-center justify-between rounded-md px-2 py-1 text-xs font-medium text-slate-700 dark:text-jovieDark-300">
                                    <div class="flex items-center">
                                      <component
                                        :is="setting.icon"
                                        class="mr-2 h-3 w-3 text-slate-400 dark:text-jovieDark-200"
                                        aria-hidden="true" />
                                      <span class="line-clamp-1">{{
                                        setting.name
                                      }}</span>
                                    </div>

                                    <Switch
                                      v-if="setting.type === 'toggle'"
                                      name="columns-visible"
                                      v-model="setting.isVisable"
                                      as="template"
                                      v-slot="{ checked }">
                                      <button
                                        :class="
                                          checked
                                            ? 'bg-indigo-600 dark:bg-indigo-400'
                                            : 'bg-slate-200 dark:bg-jovieDark-700'
                                        "
                                        class="relative inline-flex h-4 w-6 items-center rounded-full border border-slate-300 dark:border-jovieDark-border">
                                        <span
                                          :class="
                                            checked
                                              ? 'translate-x-3'
                                              : 'translate-x-0'
                                          "
                                          class="inline-block h-3 w-3 transform rounded-full bg-white transition dark:bg-jovieDark-100" />
                                      </button>
                                    </Switch>
                                  </button>
                                </SwitchLabel>
                              </SwitchGroup>
                            </MenuItem>
                            <MenuItem v-slot="{ active }">
                              <div
                                class="flex items-center rounded-md"
                                :class="{
                                  'bg-slate-300 text-white dark:bg-jovieDark-700 dark:text-jovieDark-200':
                                    active,
                                }">
                                <button
                                  @click="importCSV()"
                                  class="group flex w-full items-center justify-between rounded-md px-2 py-1 text-xs font-medium text-slate-700 dark:text-jovieDark-300">
                                  <div class="flex items-center">
                                    <CloudArrowUpIcon
                                      class="mr-2 h-3 w-3 text-slate-400"
                                      aria-hidden="true" />
                                    <span class="line-clamp-1">
                                      Import CSV
                                    </span>
                                  </div>
                                </button>
                              </div>
                            </MenuItem>
                          </div>
                        </GlassmorphismContainer>
                      </MenuItems>
                    </TransitionRoot>
                  </Float>
                </Menu>
              </div>
              <!-- <div v-if="currentContact">
                <button
                  v-if="!$store.state.ContactSidebarOpen"
                  class="group inline-flex items-center rounded-md px-2 py-2 text-2xs font-medium text-slate-700 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 disabled:opacity-30">
                  <ChevronRightIcon
                    @click="openSidebarAndSetContact()"
                    class="h-5 w-5 font-bold text-slate-400 transition-all group-hover:text-slate-600" />
                </button>
              </div> -->
            </div>
          </div>
        </div>
        <div
          class="inline-block h-full w-full overflow-x-auto scroll-smooth align-middle">
          <div
            class="flex h-full w-full flex-col overflow-auto bg-white shadow-sm ring-1 ring-black ring-opacity-5 dark:bg-jovieDark-900">
            <table
              class="block w-full divide-y divide-slate-200 overflow-x-auto bg-slate-100 dark:divide-slate-700 dark:border-jovieDark-border dark:bg-jovieDark-700">
              <thead class="relative isolate z-20 w-full items-center">
                <tr class="sticky h-8 items-center">
                  <th
                    scope="col"
                    class="sticky left-0 top-0 z-50 w-6 items-center border-slate-300 bg-slate-100 text-center text-xs font-light tracking-wider text-slate-600 backdrop-blur backdrop-filter before:absolute before:left-0 before:top-0 before:h-full before:border-l before:border-slate-300 before:content-[''] dark:border-jovieDark-border dark:border-jovieDark-border dark:bg-jovieDark-700 dark:before:border-jovieDark-border">
                    <div class="mx-auto items-center text-center">
                      <input
                        type="checkbox"
                        class="h-3 w-3 rounded border-slate-300 text-indigo-600 focus-visible:ring-indigo-500 dark:border-jovieDark-border dark:text-indigo-400"
                        :checked="
                          intermediate ||
                          selectedCreators.length === creatorRecords.length
                        "
                        :intermediate="intermediate"
                        @change="
                          selectedCreators = $event.target.checked
                            ? creatorRecords.map((c) => c.id)
                            : []
                        " />
                    </div>
                  </th>
                  <th
                    scope="col"
                    class="sticky left-[26.5px] top-0 z-50 w-8 items-center border-slate-300 bg-slate-100 text-center text-xs font-thin tracking-wider text-slate-600 backdrop-blur backdrop-filter dark:border-jovieDark-border dark:bg-jovieDark-700 dark:text-jovieDark-400">
                    <span class="sr-only">Favorite</span>
                  </th>
                  <th
                    scope="col"
                    class="sticky left-[55px] top-0 isolate z-50 w-60 resize-x items-center border-r border-slate-300 bg-slate-100 text-left text-xs font-medium tracking-wider text-slate-600 backdrop-blur backdrop-filter after:absolute after:right-[-1px] after:top-0 after:h-full after:border-r after:border-slate-300 after:content-[''] dark:border-jovieDark-border dark:border-jovieDark-border dark:bg-jovieDark-700 dark:text-jovieDark-400 after:dark:border-jovieDark-border">
                    <div
                      v-if="selectedCreators.length > 0"
                      class="flex items-center space-x-3 bg-slate-100 dark:bg-jovieDark-700">
                      <!--   <ContactActionMenu /> -->
                      <Menu>
                        <Float portal :offset="2" placement="bottom-start">
                          <MenuButton
                            class="py-.5 inline-flex items-center rounded border border-slate-300 bg-white px-2 text-2xs font-medium text-slate-700 shadow-sm hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-30 dark:border-jovieDark-border dark:bg-jovieDark-900 dark:text-jovieDark-300 dark:hover:bg-jovieDark-800">
                            <span class="line-clamp-1">Bulk Actions</span>
                            <ChevronDownIcon
                              class="ml-2 -mr-1 h-5 w-5 text-slate-500 dark:text-jovieDark-400"
                              aria-hidden="true" />
                          </MenuButton>
                          <transition
                            enter-active-class="transition duration-100 ease-out"
                            enter-from-class="transform scale-95 opacity-0"
                            enter-to-class="transform scale-100 opacity-100"
                            leave-active-class="transition duration-75 ease-in"
                            leave-from-class="transform scale-100 opacity-100"
                            leave-to-class="transform scale-95 opacity-0">
                            <MenuItems
                              class="max-h-80 w-60 flex-col overflow-y-scroll rounded-md border border-slate-300 bg-white/60 bg-clip-padding px-1 py-1 shadow-xl backdrop-blur-2xl backdrop-filter dark:border-jovieDark-border dark:bg-jovieDark-900/60">
                              <MenuItem
                                v-if="filters.list"
                                v-slot="{ active }"
                                @click="
                                  toggleCreatorsFromList(
                                    selectedCreators,
                                    filters.list,
                                    true
                                  )
                                ">
                                <button
                                  :class="[
                                    active
                                      ? 'bg-slate-300 text-slate-900 dark:bg-jovieDark-700 dark:text-jovieDark-100'
                                      : 'text-slate-700 dark:text-jovieDark-200',
                                    'group  flex w-full items-center rounded-md px-2 py-2 text-xs disabled:cursor-not-allowed disabled:opacity-50',
                                  ]">
                                  <TrashIcon class="mr-2 inline h-4 w-4" />
                                  Remove from list
                                </button>
                              </MenuItem>

                              <MenuItem
                                v-slot="{ active }"
                                @click="
                                  toggleArchiveCreators(
                                    this.selectedCreators,
                                    this.filters.type == 'archived'
                                      ? false
                                      : true
                                  )
                                ">
                                <button
                                  :class="[
                                    active
                                      ? 'bg-slate-300 text-slate-900 dark:bg-jovieDark-700 dark:text-jovieDark-100'
                                      : 'text-slate-700 dark:text-jovieDark-200',
                                    'group  flex w-full items-center rounded-md px-2 py-2 text-xs disabled:cursor-not-allowed disabled:opacity-50',
                                  ]">
                                  <ArchiveBoxIcon
                                    :active="active"
                                    class="mr-2 h-3 w-3 text-sky-400"
                                    aria-hidden="true" />
                                  {{
                                    this.filters.type == 'archived'
                                      ? 'Unarchive'
                                      : 'Archive'
                                  }}
                                </button>
                              </MenuItem>
                            </MenuItems>
                          </transition>
                        </Float>
                      </Menu>
                    </div>
                    <div v-else>
                      <CrmTableSortableHeader
                        icon="Bars3BottomLeftIcon"
                        :column="fullNameColumn"
                        @sortData="
                          sortData({
                            sortBy: fullNameColumn.key,
                            sortOrder: fullNameColumn.sortOrder,
                          })
                        "
                        menu="false" />
                    </div>
                  </th>

                  <template v-for="column in otherColumns">
                    <th
                      :key="column.key"
                      v-if="column.visible"
                      scope="col"
                      class="dark:border-x-slate-border sticky top-0 z-30 table-cell w-48 items-center border-x border-slate-300 bg-slate-100 text-left text-xs font-medium tracking-wider text-slate-600 backdrop-blur backdrop-filter dark:border-jovieDark-border dark:bg-jovieDark-700 dark:bg-jovieDark-700 dark:text-jovieDark-400">
                      <CrmTableSortableHeader
                        class="w-full"
                        @sortData="sortData"
                        @hide-column="column.visible = false"
                        :column="column" />
                    </th>
                  </template>
                  <th
                    scope="col"
                    :class="[{ 'border-b-2': view.atTopOfPage }, 'border-b-0']"
                    class="sticky top-0 isolate z-30 table-cell w-full content-end items-center border-slate-300 bg-slate-100 py-1 text-right text-xs font-medium tracking-wider text-slate-600 backdrop-blur-2xl backdrop-filter dark:border-jovieDark-border dark:bg-jovieDark-700"></th>
                </tr>
              </thead>
              <tbody
                class="relative isolate z-0 h-full w-full divide-y divide-slate-200 overflow-y-scroll bg-slate-50 dark:divide-slate-700 dark:bg-jovieDark-700">
                <template class="w-full" v-if="loading">
                  <tr class="w-full">
                    <td class="w-full" colspan="11">
                      <div
                        class="flex min-h-screen w-full items-center justify-center pb-80">
                        <JovieSpinner />
                        <span class="visually-hidden sr-only">
                          Loading...
                        </span>
                      </div>
                    </td>
                  </tr>
                </template>
                <template
                  v-else
                  v-for="(creator, index) in filteredCreators"
                  :key="creator">
                  <tr
                    v-if="creator"
                    @click="setCurrentContact($event, creator)"
                    @contextmenu.prevent="openContextMenu(index, creator)"
                    class="border-1 group w-full flex-row overflow-y-visible border border-slate-300 focus-visible:ring-indigo-700 dark:border-jovieDark-border"
                    :class="[
                      {
                        'bg-slate-100 hover:bg-slate-100 hover:bg-slate-100 dark:bg-jovieDark-700 hover:dark:bg-jovieDark-700':
                          currentContact.id == creator.id,
                      },
                      'bg-white hover:bg-slate-50 dark:bg-jovieDark-900 dark:hover:bg-jovieDark-800',
                    ]">
                    <td
                      :class="[
                        {
                          'bg-slate-100 hover:bg-slate-100 hover:bg-slate-100 dark:bg-jovieDark-700 hover:dark:bg-jovieDark-700':
                            currentContact.id == creator.id,
                        },
                        'bg-white hover:bg-slate-50 group-hover:bg-slate-50 dark:bg-jovieDark-900 dark:group-hover:bg-jovieDark-800',
                      ]"
                      class="sticky left-0 w-6 overflow-auto whitespace-nowrap border-y border-slate-300 bg-white py-0.5 text-center text-xs font-bold text-slate-300 before:absolute before:left-0 before:top-0 before:h-full before:border-l before:border-slate-300 before:content-[''] group-hover:text-slate-500 dark:border-jovieDark-border dark:bg-jovieDark-900 before:dark:border-jovieDark-border dark:group-hover:text-slate-400">
                      <div class="group mx-auto w-6">
                        <span
                          class="group-hover:block"
                          :class="[
                            {
                              hidden: !selectedCreators.includes(creator.id),
                            },
                            'block',
                          ]">
                          <form>
                            <input
                              type="checkbox"
                              name="selectCreatorCheckbox"
                              :value="creator.id"
                              class="h-3 w-3 rounded border-slate-300 text-indigo-600 focus-visible:ring-indigo-500 dark:border-jovieDark-border dark:text-indigo-400 sm:left-6"
                              v-model="selectedCreators" />
                          </form>
                        </span>
                        <span
                          class="text-xs font-light text-slate-600 group-hover:hidden dark:text-jovieDark-400"
                          :class="[
                            { hidden: selectedCreators.includes(creator.id) },
                            'block',
                          ]">
                          {{ index + 1 }}
                        </span>
                      </div>
                      <!--                                                                    favourite-->
                    </td>
                    <td
                      :class="[
                        {
                          'bg-slate-100 hover:bg-slate-100 hover:bg-slate-100 dark:bg-jovieDark-700 hover:dark:bg-jovieDark-700':
                            currentContact.id == creator.id,
                        },
                        'bg-white hover:bg-slate-50 group-hover:bg-slate-50 dark:bg-jovieDark-900 dark:group-hover:bg-jovieDark-800',
                      ]"
                      class="sticky left-[26.5px] w-4 overflow-auto whitespace-nowrap border-y border-slate-300 bg-white px-2 py-1 text-center text-xs font-bold text-slate-300 group-hover:text-slate-500 dark:border-jovieDark-border dark:text-jovieDark-700 dark:group-hover:text-slate-400">
                      <div
                        class="hidden cursor-pointer items-center lg:block"
                        @click="
                          $emit('updateCreator', {
                            id: creator.id,
                            index: index,
                            key: `crm_record_by_user.favourite`,
                            value: !creator.crm_record_by_user.favourite,
                          })
                        ">
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          :class="{
                            'fill-red-500 text-red-500':
                              creator.crm_record_by_user.favourite,
                          }"
                          class="-mt-.5 h-3 w-3 hover:fill-red-500 hover:text-red-500"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor">
                          <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            stroke-width="2"
                            d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
                        </svg>
                      </div>
                    </td>
                    <td
                      :class="[
                        {
                          'bg-slate-100 hover:bg-slate-100 hover:bg-slate-100 dark:bg-jovieDark-700 hover:dark:bg-jovieDark-700':
                            currentContact.id == creator.id,
                        },
                        'bg-white hover:bg-slate-50 group-hover:bg-slate-50 dark:bg-jovieDark-900 dark:group-hover:bg-jovieDark-800',
                      ]"
                      v-on:dblclick="cellActive"
                      class="border-seperate sticky left-[55px] w-60 cursor-pointer whitespace-nowrap border-y border-slate-300 bg-white pl-2 pr-0.5 after:absolute after:right-[-1px] after:top-0 after:h-full after:border-r after:border-slate-300 after:border-slate-300 after:content-[''] dark:border-jovieDark-border dark:border-jovieDark-border dark:bg-jovieDark-900 dark:after:border-jovieDark-border">
                      <div class="flex items-center justify-between">
                        <div
                          @click="$emit('openSidebar', creator)"
                          class="flex w-full items-center">
                          <div class="mr-2 h-8 w-8 flex-shrink-0">
                            <div
                              class="rounded-full bg-slate-400 p-0.5 dark:bg-jovieDark-600">
                              <div
                                class="rounded-full bg-white p-0 dark:bg-jovieDark-900">
                                <img
                                  class="rounded-full object-cover object-center"
                                  :src="creator.profile_pic_url"
                                  @error="imageLoadingError"
                                  alt="Profile Image" />
                              </div>
                            </div>
                          </div>

                          <div
                            v-if="cellActive"
                            class="items-center text-sm text-slate-900 line-clamp-1 dark:text-jovieDark-100">
                            <input
                              v-model="creator.meta.name"
                              @blur="$emit('updateCrmMeta', creator)"
                              autocomplete="off"
                              type="creator-name"
                              name="creator-name"
                              id="creator-name"
                              class="block w-full bg-white/0 px-2 py-1 placeholder-slate-300 focus-visible:border-2 focus-visible:border-indigo-500 focus-visible:ring-indigo-500 dark:bg-jovieDark-900/0 dark:placeholder-slate-700 sm:text-xs"
                              placeholder="Name"
                              aria-describedby="name-description" />
                          </div>
                          <div
                            v-else
                            class="text-sm text-slate-900 line-clamp-1 dark:text-jovieDark-100">
                            {{ creator.meta.name }}
                          </div>
                        </div>
                        <div
                          @click="$emit('openSidebar', creator)"
                          class="mx-auto h-6 w-6 items-center rounded-full bg-slate-200/0 pr-4 text-center text-slate-400 transition-all active:border active:bg-slate-200 dark:text-jovieDark-600 dark:active:bg-slate-800">
                          <ArrowTopRightOnSquareIcon
                            v-if="
                              !this.$store.state.ContactSidebarOpen ||
                              currentContact.id !== creator.id
                            "
                            class="mx-auto mt-0.5 ml-0.5 hidden h-4 w-4 group-hover:block" />
                          <XMarkIcon
                            v-else
                            class="mx-auto ml-1 mt-1 hidden h-4 w-4 group-hover:block" />
                        </div>
                        <div>
                          <ContactContextMenu
                            @close="showContextMenu = false"
                            :open="showContextMenu"
                            :creator="creator">
                            <MenuItem
                              v-if="filters.list"
                              v-slot="{ active }"
                              class="cursor-pointer items-center"
                              @click="
                                toggleCreatorsFromList(
                                  creator.id,
                                  filters.list,
                                  true
                                )
                              ">
                              <a
                                href="#"
                                :class="[
                                  active
                                    ? 'bg-slate-100 text-slate-900 dark:bg-jovieDark-700 dark:text-jovieDark-100'
                                    : 'text-slate-700 dark:text-jovieDark-200',
                                  'group  flex w-full items-center rounded-md px-2 py-2 text-xs disabled:cursor-not-allowed disabled:opacity-50',
                                ]">
                                <TrashIcon
                                  class="mr-2 inline h-4 w-4 text-red-400" />
                                Remove from list</a
                              >
                            </MenuItem>
                            <MenuItem
                              v-slot="{ active }"
                              @blur="$emit('updateCrmMeta')"
                              @click="
                                toggleArchiveCreators(
                                  creator.id,
                                  !creator.crm_record_by_user.archived
                                )
                              "
                              class="items-center">
                              <button
                                :class="[
                                  active
                                    ? 'bg-slate-100 text-slate-900 dark:bg-jovieDark-700 dark:text-jovieDark-100'
                                    : 'text-slate-700 dark:text-jovieDark-200',
                                  'group  flex w-full items-center rounded-md px-2 py-2 text-xs disabled:cursor-not-allowed disabled:opacity-50',
                                ]">
                                <ArchiveBoxIcon
                                  class="mr-2 inline h-4 w-4 text-sky-400" />
                                {{
                                  filters.type == 'archived' &&
                                  creator.crm_record_by_user.archived
                                    ? 'Unarchived'
                                    : 'Archive'
                                }}
                              </button>
                            </MenuItem>
                            <MenuItem
                              v-if="currentUser.is_admin"
                              v-slot="{ active }"
                              class="items-center"
                              @click="refresh(creator)"
                              :disabled="adding">
                              <a
                                href="#"
                                class="items-center text-slate-400 hover:text-slate-900"
                                :class="[
                                  active
                                    ? 'bg-slate-100 text-slate-900 dark:bg-jovieDark-700 dark:text-jovieDark-100'
                                    : 'text-slate-700 dark:text-jovieDark-200',
                                  'group  flex w-full items-center rounded-md px-2 py-2 text-xs disabled:cursor-not-allowed disabled:opacity-50',
                                ]">
                                <ArrowPathIcon class="mr-2 inline h-4 w-4" />
                                Refresh</a
                              >
                            </MenuItem>
                          </ContactContextMenu>
                        </div>
                      </div>
                    </td>
                    <td
                      v-if="visibleColumns.includes('first_name')"
                      class="border-1 table-cell w-28 whitespace-nowrap border border-slate-300 dark:border-jovieDark-border">
                      <div class="text-sm text-slate-900 line-clamp-1">
                        <input
                          v-model="creator.meta.first_name"
                          @blur="$emit('updateCrmMeta', creator)"
                          autocomplete="off"
                          type="creator-firstname"
                          name="creator-firstname"
                          id="creator-firname"
                          class="block w-full bg-white/0 px-2 py-1 placeholder-slate-300 focus-visible:border-2 focus-visible:border-indigo-500 focus-visible:ring-indigo-500 dark:bg-jovieDark-900/0 dark:text-jovieDark-100 sm:text-xs"
                          placeholder="First"
                          aria-describedby="email-description" />
                      </div>
                    </td>
                    <td
                      v-if="visibleColumns.includes('last_name')"
                      class="border-1 table-cell w-28 whitespace-nowrap border border-slate-300 dark:border-jovieDark-border">
                      <div class="text-xs text-slate-900 line-clamp-1">
                        <input
                          v-model="creator.meta.last_name"
                          @blur="$emit('updateCrmMeta', creator)"
                          autocomplete="off"
                          type="creator-lastname"
                          name="creator-lastname"
                          id="creator-lastname"
                          class="block w-full bg-white/0 px-2 py-1 placeholder-slate-300 focus-visible:border-2 focus-visible:border-indigo-500 focus-visible:ring-indigo-500 dark:bg-jovieDark-900/0 dark:text-jovieDark-100 sm:text-xs"
                          placeholder="Last"
                          aria-describedby="email-description" />
                      </div>
                    </td>
                    <td
                      v-if="visibleColumns.includes('title')"
                      class="border-1 table-cell w-40 resize-x whitespace-nowrap border border-slate-300 dark:border-jovieDark-border">
                      <div class="text-xs text-slate-900 line-clamp-1">
                        <input
                          v-model="creator.meta.platform_title"
                          @blur="$emit('updateCrmMeta', creator)"
                          autocomplete="off"
                          type="platform-title"
                          name="platform-title"
                          id="platform-title"
                          class="block w-full bg-white/0 px-2 py-1 placeholder-slate-300 focus-visible:border-2 focus-visible:border-indigo-500 focus-visible:ring-indigo-500 dark:bg-jovieDark-900/0 dark:text-jovieDark-100 sm:text-xs"
                          placeholder="Title"
                          aria-describedby="title" />
                      </div>
                    </td>
                    <td
                      v-if="visibleColumns.includes('employer')"
                      class="border-1 table-cell w-40 whitespace-nowrap border border-slate-300 dark:border-jovieDark-border">
                      <div class="text-xs text-slate-900 line-clamp-1">
                        <input
                          v-model="creator.meta.platform_employer"
                          @blur="$emit('updateCrmMeta', creator)"
                          autocomplete="off"
                          type="platform-employer"
                          name="platform-employer"
                          id="platform-employer"
                          class="block w-full bg-white/0 px-2 py-1 placeholder-slate-300 focus-visible:border-2 focus-visible:border-indigo-500 focus-visible:ring-indigo-500 dark:bg-jovieDark-900/0 dark:text-jovieDark-100 sm:text-xs"
                          placeholder="Company"
                          aria-describedby="Company" />
                      </div>
                    </td>

                    <td
                      v-if="visibleColumns.includes('emails')"
                      class="border-1 table-cell w-40 whitespace-nowrap border border-slate-300 focus:border-slate-500 focus:outline-none focus:ring-0 dark:border-jovieDark-border">
                      <div
                        class="text-xs text-slate-700 line-clamp-1 dark:text-jovieDark-300">
                        <input
                          v-model="creator.meta.emails"
                          @blur="$emit('updateCrmMeta', creator)"
                          @keyup.enter="$emit('selectNextCreator', creator)"
                          autocomplete="off"
                          type="creator-email"
                          name="creator-email"
                          id="creator-email"
                          class="block w-full bg-white/0 px-2 py-1 placeholder-slate-300 focus-visible:border-2 focus-visible:border-indigo-500 focus-visible:ring-indigo-500 dark:bg-jovieDark-900/0 dark:placeholder-slate-500 sm:text-xs"
                          placeholder="someone@gmail.com"
                          aria-describedby="email-description" />
                      </div>
                    </td>
                    <td
                      v-if="visibleColumns.includes('networks')"
                      class="border-1 w-18 items-center whitespace-nowrap border border-slate-300 dark:border-jovieDark-border">
                      <a
                        v-for="network in networks"
                        :href="creator[`${network}_handler`]"
                        target="_blank"
                        class="inline-flex items-center justify-between rounded-full px-1 py-1 text-center text-xs font-bold text-slate-800">
                        <div class=".clear-both mx-auto flex-col items-center">
                          <div class="mx-auto items-center">
                            <SocialIcons
                              :linkDisabled="
                                !creator[`${network}_handler`] &&
                                !creator.meta[`${network}_handler`]
                              "
                              class="mx-auto"
                              height="14px"
                              setting.isVisable
                              :link="
                                creator[`${network}_handler`] ||
                                creator.meta[`${network}_handler`]
                              "
                              :icon="network" />
                          </div>

                          <div v-if="settings.countsVisible" class="">
                            <span
                              v-if="creator[`${network}_handler`]"
                              class="mx-auto items-center text-2xs font-bold text-slate-400">
                              {{
                                formatCount(creator[`${network}_followers`])
                              }}</span
                            >
                          </div>
                        </div>
                      </a>
                    </td>
                    <td
                      v-if="visibleColumns.includes('crm_record_by_user.offer')"
                      class="border-1 table-cell w-12 whitespace-nowrap border border-slate-300 dark:border-jovieDark-border">
                      <span
                        class="inline-flex items-center rounded-full px-2 text-center text-xs font-bold leading-5 text-slate-800 dark:text-jovieDark-200">
                        $
                        <input
                          v-model="creator.crm_record_by_user.offer"
                          @blur="
                            $emit('updateCreator', {
                              id: creator.id,
                              index: index,
                              key: `crm_record_by_user.offer`,
                              value: creator.crm_record_by_user.offer,
                            })
                          "
                          autocomplete="off"
                          type="number"
                          name="creator-offer"
                          id="creator-offer"
                          class="block w-full border-0 bg-white/0 px-2 py-0.5 placeholder-slate-300 focus-visible:border-2 focus-visible:border-indigo-500 focus-visible:ring-indigo-500 dark:bg-jovieDark-900/0 sm:text-xs"
                          :placeholder="
                            creator.crm_record_by_user.suggested_offer
                          "
                          aria-describedby="email-description" />
                      </span>
                    </td>

                    <td
                      v-if="visibleColumns.includes('crm_record_by_user.stage')"
                      class="border-1 relative isolate z-10 table-cell w-24 items-center whitespace-nowrap border border-slate-300 dark:border-jovieDark-border">
                      <ContactStageMenu
                        :creator="creator"
                        :key="key"
                        :open="showContactStageMenu[index]"
                        @close="toggleContactStageMenu(index)"
                        :stages="stages"
                        :index="index"
                        @updateCreator="$emit('updateCreator', $event)" />
                    </td>
                    <td
                      v-if="
                        visibleColumns.includes(
                          'crm_record_by_user.last_contacted'
                        )
                      "
                      class="border-1 table-cell w-40 items-center whitespace-nowrap border border border-slate-300 text-xs text-slate-500 dark:border-jovieDark-border">
                      <Datepicker
                        :dark="getTheme === '!light'"
                        v-model="creator.crm_record_by_user.last_contacted"
                        @update:modelValue="
                          $emit('updateCreator', {
                            id: creator.id,
                            index: index,
                            key: `crm_record_by_user.last_contacted`,
                            value: creator.crm_record_by_user.last_contacted,
                          })
                        "
                        autocomplete="off"
                        enableTimePicker="false"
                        monthNameFormat="short"
                        data-format="yyyy-MM-dd"
                        autoApply="true"
                        type="datetime-local"
                        :id="creator.id + '_datepicker'"
                        class="focus-visible:border-1 focus-visible:border-1 block w-full rounded-md border-0 bg-white/0 text-xs text-slate-500 placeholder-slate-300 focus-visible:border-indigo-500 focus-visible:ring-indigo-500 dark:bg-jovieDark-900/0"
                        placeholder="--/--/--"
                        aria-describedby="email-description" />
                      <!-- <input
                          v-model="creator.crm_record_by_user.last_contacted"
                          @click="
                           creator.crm_record_by_user.last_contacted$emit('updateCrmMeta', creator)  })
                          "
                          autocomplete="off"
                          enableTimePicker="false"
                          monthNameFormat="short"
                          data-format="yyyy-MM-dd"
                          autoApply="true"
                          type="datetime-local"
                          :id="creator.id + '_datepicker'"
                          class="focus-visible:border-1 focus-visible:border-1 block w-full rounded-md border-0 bg-white/0 dark:bg-jovieDark-900/0 px-2 py-1 text-xs text-slate-500 placeholder-slate-300 focus-visible:border-indigo-700 focus-visible:border-indigo-500 focus-visible:ring-indigo-500"
                          placeholder="--/--/--"
                          aria-describedby="email-description" /> -->
                    </td>
                    <td
                      v-if="
                        visibleColumns.includes('crm_record_by_user.rating')
                      "
                      class="table-cell w-14 whitespace-nowrap border border-slate-300 px-2 py-1 text-sm text-slate-500 dark:border-jovieDark-border">
                      <star-rating
                        class="w-20"
                        :star-size="12"
                        :increment="0.5"
                        v-model:rating="creator.crm_record_by_user.rating"
                        @update:rating="
                          $emit('updateCreator', {
                            id: creator.id,
                            index: index,
                            key: `crm_record_by_user.rating`,
                            value: creator.crm_record_by_user.rating,
                          })
                        "></star-rating>
                    </td>
                    <td
                      v-if="visibleColumns.includes('crm_record_by_user.lists')"
                      class="table-cell w-24 whitespace-nowrap border-y border-slate-300 px-2 py-1 text-sm text-slate-500 dark:border-jovieDark-border">
                      <InputLists
                        @updateLists="updateCreatorLists"
                        :creatorId="creator.id ?? 0"
                        :lists="creator.lists"
                        :currentList="creator.current_list" />
                    </td>
                    <td
                      class="table-cell h-full w-full items-center justify-end whitespace-nowrap border-y border-slate-300 px-2 py-1 text-right text-xs font-medium dark:border-jovieDark-border">
                      <div
                        class="flex h-full items-center justify-end text-right">
                        <router-link
                          v-if="currentUser.is_admin"
                          :to="{
                            name: 'Creator Overview',
                            params: { id: creator.id },
                          }"
                          class="hover:dark:text-indigio-300 text-slate-600 hover:text-indigo-900 dark:text-jovieDark-300">
                          Manage
                        </router-link>
                      </div>
                    </td>
                  </tr>
                </template>
              </tbody>
            </table>
            <div
              v-if="creatorRecords.length < 50"
              @click="$emit('addContact')"
              class="flex w-full cursor-pointer items-center bg-white py-2 px-4 text-xs font-bold text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:bg-jovieDark-900 dark:text-jovieDark-400 hover:dark:bg-jovieDark-700 dark:hover:text-slate-200">
              <PlusIcon class="mr-2 h-4 w-4" />
              Add new contact
            </div>

            <Pagination
              class="z-50 w-full bg-blue-500"
              v-if="creatorRecords.length > 50"
              :totalPages="creatorsMeta.last_page"
              :perPage="creatorsMeta.per_page"
              :currentPage="creatorsMeta.current_page"
              :disabled="loading"
              @pagechanged="$emit('pageChanged', $event)" />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import ContactContextMenu from '../../components/ContactContextMenu';
import GlassmorphismContainer from '../../components/GlassmorphismContainer';
import { Float } from '@headlessui-float/vue';
import Datepicker from '@vuepic/vue-datepicker';
import ContactContextMenuItem from '../../components/ContactContextMenuItem';
import InputLists from '../../components/InputLists';
import { ref } from 'vue';
import '@vuepic/vue-datepicker/dist/main.css';
import {
  Menu,
  MenuButton,
  MenuItems,
  MenuItem,
  Popover,
  PopoverButton,
  PopoverPanel,
  TransitionRoot,
} from '@headlessui/vue';
import StarRating from 'vue-star-rating';
import {
  EllipsisVerticalIcon,
  ArchiveBoxIcon,
  ArrowSmallLeftIcon,
  ChevronDownIcon,
  CloudArrowUpIcon,
  PlusIcon,
  ChatBubbleOvalLeftEllipsisIcon,
  BriefcaseIcon,
  UserIcon,
  NoSymbolIcon,
  StarIcon,
  TrashIcon,
  HeartIcon,
  ArrowPathIcon,
  MagnifyingGlassIcon,
  ChevronUpIcon,
  Bars3BottomLeftIcon,
  AtSymbolIcon,
  CurrencyDollarIcon,
  EnvelopeIcon,
  LinkIcon,
  ListBulletIcon,
  CalendarDaysIcon,
  ArrowDownCircleIcon,
  ArrowUpCircleIcon,
  ChevronRightIcon,
  CloudArrowDownIcon,
  AdjustmentsHorizontalIcon,
  XMarkIcon,
  UserGroupIcon,
  ArrowTopRightOnSquareIcon,
  PhoneIcon,
  ChatBubbleLeftEllipsisIcon,
  CheckIcon,
} from '@heroicons/vue/24/solid';
import KeyboardShortcut from '../../components/KeyboardShortcut';
import Pagination from '../../components/Pagination';
import SocialIcons from '../../components/SocialIcons.vue';
import JovieSpinner from '../../components/JovieSpinner.vue';
import ImportService from '../../services/api/import.service';
import CrmTableSortableHeader from '../CrmTableSortableHeader.vue';
import { Switch, SwitchGroup, SwitchLabel } from '@headlessui/vue';
import ButtonGroup from '../../components/ButtonGroup.vue';
import JovieTooltip from '../../components/JovieTooltip.vue';
import ContactStageMenu from '../../components/ContactStageMenu.vue';
import JovieDropdownMenu from '../../components/JovieDropdownMenu.vue';
export default {
  name: 'CrmTable',
  components: {
    ContactStageMenu,
    JovieDropdownMenu,
    ArchiveBoxIcon,
    ChevronRightIcon,
    ContactContextMenu,
    StarRating,
    ContactContextMenuItem,
    KeyboardShortcut,
    MagnifyingGlassIcon,
    PhoneIcon,
    ChatBubbleLeftEllipsisIcon,
    GlassmorphismContainer,
    ButtonGroup,
    CloudArrowUpIcon,
    Menu,
    InputLists,
    EnvelopeIcon,
    ArrowSmallLeftIcon,
    Switch,
    Datepicker,
    MenuButton,
    Float,
    StarIcon,
    ArrowPathIcon,
    MenuItems,
    MenuItem,
    EllipsisVerticalIcon,
    SocialIcons,
    Popover,
    BriefcaseIcon,
    UserIcon,
    CheckIcon,
    ChatBubbleOvalLeftEllipsisIcon,
    UserGroupIcon,
    ChevronDownIcon,
    PopoverButton,
    PopoverPanel,
    NoSymbolIcon,
    ListBulletIcon,
    TrashIcon,
    Pagination,
    HeartIcon,
    JovieTooltip,
    PlusIcon,
    JovieSpinner,
    CrmTableSortableHeader,
    Bars3BottomLeftIcon,
    AtSymbolIcon,
    CurrencyDollarIcon,
    ChevronUpIcon,
    LinkIcon,
    CalendarDaysIcon,
    ArrowDownCircleIcon,
    AdjustmentsHorizontalIcon,
    CloudArrowDownIcon,
    XMarkIcon,
    SwitchGroup,
    SwitchLabel,
    ArrowUpCircleIcon,
    TransitionRoot,
    ArrowTopRightOnSquareIcon,
  },
  data() {
    return {
      creatorMenu: false,
      view: {
        atTopOfPage: true,
      },
      creatorRecords: [],
      tableViewSearchQuery: '',
      searchQuery: '',
      stageSearchQuery: '',
      currentRow: null,
      showContextMenu: false,
      showContactStageMenu: [],
      date: null,
      selectedCreators: [],
      /*  activeCreator: {}, */
      currentContact: [],
      editingSocialHandle: true,
      searchVisible: false,
      imageLoaded: true,
      cellActive: false,
      open: false,
      subMenuOpen: true,
      settings: [
        {
          name: 'Show Follower Counts',
          icon: 'UserGroupIcon',
          countsVisible: false,
          type: 'toggle',
        },
      ],
      columns: [
        {
          name: 'Name',
          key: 'full_name',
          icon: 'Bars3BottomLeftIcon',
          sortable: true,
          visible: true,
        },
        {
          name: 'First',
          key: 'first_name',
          icon: 'Bars3BottomLeftIcon',
          sortable: false,
          visible: false,
          breakpoint: '2xl',
          width: '18',
        },
        {
          name: 'Last',
          key: 'last_name',
          icon: 'Bars3BottomLeftIcon',
          visible: false,
          sortable: false,
          breakpoint: '2xl',
          width: '18',
        },
        {
          name: 'Title',
          key: 'title',
          icon: 'UserIcon',
          visible: false,
          breakpoint: '2xl',
        },
        {
          name: 'Company',
          key: 'employer',
          icon: 'BriefcaseIcon',
          visible: false,
          sortable: false,
          breakpoint: '2xl',
          width: '24',
        },

        {
          name: 'Email',
          key: 'emails',
          icon: 'AtSymbolIcon',
          visible: true,
          breakpoint: 'lg',
          width: '40',
        },

        {
          name: 'Social Links',
          key: 'networks',
          icon: 'LinkIcon',
          visible: true,
          width: '18',
        },
        {
          name: 'Offer',
          key: 'crm_record_by_user.offer',
          icon: 'CurrencyDollarIcon',
          sortable: false,
          visible: false,
          breakpoint: 'lg',
          width: '12',
        },
        {
          name: 'Stage',
          key: 'crm_record_by_user.stage',
          icon: 'ArrowDownCircleIcon',
          width: '24',
          sortable: true,
          visible: true,
          breakpoint: 'md',
        },
        {
          name: 'Last Contact',
          key: 'crm_record_by_user.last_contacted',
          icon: 'CalendarDaysIcon',
          sortable: false,
          visible: false,
          breakpoint: '2xl',
          width: '24',
        },
        {
          name: 'Rating',
          key: 'crm_record_by_user.rating',
          icon: 'StarIcon',
          sortable: true,
          visible: true,
          breakpoint: '2xl',
          width: '24',
        },
        {
          name: 'Lists',
          key: 'crm_record_by_user.lists',
          icon: 'ListBulletIcon',
          sortable: true,
          visible: true,
          breakpoint: '2xl',
          width: '24',
        },
      ],
      currentSort: 'asc',
      currentSortBy: '',
    };
  },
  props: [
    'userLists',
    'filters',
    'creators',
    'networks',
    'stages',
    'creatorsMeta',
    'loading',
    'archived',
    'subheader',
    'header',
    'counts',
  ],
  watch: {
    creators: function (val) {
      this.creatorRecords = val;
    },
    filters: function () {
      this.selectedCreators = [];
    },
    creatorRecords: function () {
      this.selectedCreators = [];
    },
  },
  mounted() {
    this.$mousetrap.bind('up', () => {
      this.previousContact();
    });
    this.$mousetrap.bind('/', () => {
      if (!this.searchVisible) {
        this.searchVisible = true;
        return this.$nextTick(() => {
          event.preventDefault();
          this.$refs.searchInput.focus();
        });
      } else {
        event.preventDefault();
        this.$refs.searchInput.focus();
      }
    });
    this.$mousetrap.bind('down', () => {
      this.nextContact();
    });
    this.$mousetrap.bind('space', () => {
      this.toggleContactSidebar();
    });
    //s key opens the stage menu for the current contact
    this.$mousetrap.bind('s', () => {
      if (this.currentContact.length) {
        this.showContactStageMenu = true;
      }
    });

    this.$mousetrap.bind('enter', () => {
      if (this.currentContact.length) {
        this.$router.push({
          name: 'Creator Overview',
          params: { id: this.currentContact[0].id },
        });
      }
    });
    let columns = JSON.parse(localStorage.getItem('columns'));
    if (columns) {
      this.columns = columns;
    }
    this.creatorRecords = this.creatorRecords.length
      ? this.creatorRecords
      : this.creators;
  },
  computed: {
    sidebarOpen() {
      return this.$store.state.sidebarOpen;
    },
    getTheme() {
      return localStorage.getItem('theme') || 'light';
    },
    intermediate() {
      return (
        this.selectedCreators.length > 0 &&
        this.selectedCreators.length < this.creatorRecords.length
      );
    },
    visibleFields() {
      return this.headers.filter((header) => header.visible);
    },
    filteredCreators() {
      return this.creatorRecords.filter((creator) => {
        return (
          creator.name.toLowerCase().match(this.searchQuery.toLowerCase()) ||
          creator.emails.some((email) =>
            email.toString().toLowerCase().match(this.searchQuery.toLowerCase())
          )
        );
      });
    },
    visibleColumns() {
      localStorage.setItem('columns', JSON.stringify(this.columns));
      return this.columns.map((column) => {
        if (column.visible) {
          return column.key;
        }
      });
    },
    fullNameColumn() {
      return this.columns.find((column) => column.key == 'full_name');
    },
    otherColumns() {
      return this.columns.filter((column) => column.key != 'full_name');
    },
    filteredColumnList() {
      return this.columns.filter((column) => {
        return (
          column.name.toLowerCase().includes(this.tableViewSearchQuery) &&
          column.key !== 'full_name'
        );
      });
    },
  },
  // a beforeMount call to add a listener to the window
  beforeMount() {
    window.addEventListener('scroll', this.handleScroll);
  },
  methods: {
    toggleContactStageMenu(index) {
      this.showContactStageMenu[index] = !this.showContactStageMenu[index];
    },
    focusTableColumnFilterInput() {
      //next tick
      this.$nextTick(() => {
        this.$refs.tableColumnFilterInput.focus();
      });
    },
    focusStageInput() {
      //use next tick
      this.$nextTick(() => {
        this.$refs.stageInput.$el.focus();
      });
    },
    openContextMenu(index, creator) {
      //toggel open
      //if the selected creator is this creator then show the context menu

      this.showContextMenu = true;
      //only opnt the menu if there are selected creators
    },
    sortData({ sortBy, sortOrder }) {
      this.columns = this.columns.map((column) => {
        if (column.key == sortBy) {
          column.sortOrder = sortOrder == 'asc' ? 'desc' : 'asc';
        } else {
          delete column.sortOrder;
        }
        return column;
      });
      if (sortBy.split('.')[1]) {
        sortBy = sortBy.split('.')[1];
      }
      this.$emit('setOrder', { sortBy, sortOrder });

      if (this.creatorRecords.length > 50) {
        this.$emit('pageChanged', { page: this.creatorsMeta.current_page });
      } else {
        this.creatorRecords = this.creatorRecords.sort((a, b) => {
          let modifier = 1;
          if (sortOrder === 'desc') {
            modifier = -1;
          }
          if (['first_name', 'last_name', 'full_name'].includes(sortBy)) {
            let sortByC = sortBy == 'full_name' ? 'name' : sortOrder;
            return a.meta[sortByC].localeCompare(b.meta[sortByC]) * modifier;
          } else {
            if (a.crm_record_by_user[sortBy] < b.crm_record_by_user[sortBy]) {
              return -1 * modifier;
            }
            if (a.crm_record_by_user[sortBy] > b.crm_record_by_user[sortBy]) {
              return modifier;
            }
          }
          return 0;
        });
      }
    },
    handleScroll() {
      // when the user scrolls, check the pageYOffset
      if (window.pageYOffset > 0) {
        // user is scrolled
        if (this.view.atTopOfPage) this.view.atTopOfPage = false;
      } else {
        // user is at top of page
        if (!this.view.atTopOfPage) this.view.atTopOfPage = true;
      }
    },
    resetChecked() {
      this.selectedCreators = [];
    },
    openSidebarAndSetContact() {
      //if there is currently no contact selected, select the first one
      if (!this.currentContact) {
        this.currentContact = this.creatorRecords[0];
        console.log(this.currentContact.id);
        this.$store.state.ContactSidebarOpen = true;
      }
      //esle just open the sidebar
      else {
        this.$store.state.ContactSidebarOpen = true;
      }
    },
    exportCrmCreators() {
      //export filteredCreators to a csv file
      console.log('exporting');
      //write a function to export all contacts in the current table while accounting for filters and lists
    },
    imageLoadingError(e) {
      e.target.src = this.asset('img/noimage.webp');
    },
    createCalendarEvent(creator) {
      window.open(
        `https://calendar.google.com/calendar/r/eventedit?text=${
          this.currentUser.first_name
        } ${this.currentUser.last_name} <> ${
          creator.meta.name
        }&details=Created by ${this.currentUser.first_name} ${
          this.currentUser.last_name
        } on ${new Date().toLocaleDateString()}&location=&trp=false&sprop=&sprop=name:&dates=20200501T000000Z/20200501T000000Z&add=${
          creator.meta.emails[0] || creator.emails[0] || ''
        }&notes='Created via Jovie: https://jov.ie`
      );
    },
    emailCreator(email) {
      //go to the url mailto:creator.emails[0]
      //if email is not null
      if (email) {
        window.open('mailto:' + email);
        //else log no email found
      } else {
        console.log('No email found');
        this.$notify({
          title: 'No email found',
          message: 'This contact does not have an email address',
          type: 'warning',
          group: 'user',
        });
      }
    },
    sendTwitterDM(id) {
      //go to the url https://twitter.com/messages/compose?recipient_id=creator.twitter_id
      //if twitter_id is not null
      if (id) {
        //add text tot he message that says "Hey creator.name || creator.meta.name "
        window.open(
          'https://twitter.com/messages/compose?recipient_id=' +
            id +
            '&text=Hey ' +
            this.currentContact.meta.name +
            ','
        );
        //else log no twitter id found
      } else {
        console.log('No twitter id found');
        this.$notify({
          title: 'No twitter id found',
          message: 'This contact does not have a twitter id',
          type: 'warning',
          group: 'user',
        });
      }
    },
    callCreator(phone) {
      //go to the url tel:creator.meta.phone
      //if phone is not null
      if (phone) {
        window.open('tel:' + phone);
        //else log no phone found
      } else {
        console.log('No phone number found');
        this.$notify({
          title: 'No phone number found',
          message: 'This contact does not have a phone number',
          type: 'warning',
          group: 'user',
        });
      }
    },
    whatsappCreator(phone) {
      //go to the url tel:creator.meta.phone
      //if phone is not null
      if (phone) {
        console.log('whatsapp');
        //open whatsapp://send?text=Hello World!&phone=+phone
        window.open('whatsapp://send?text=Hey!&phone=+' + phone);
        //else log no phone found
      } else {
        console.log('No phone number found');
        this.$notify({
          title: 'No phone number found',
          message: 'This contact does not have a phone number',
          type: 'warning',
          group: 'user',
        });
      }
    },
    instagramDMContact(username) {
      if (username.includes('instagram.com')) {
        username = username.split('instagram.com/')[1];
      }
      if (username) {
        window.open('https://ig.me/m/' + username);
      } else {
        console.log('No instagram username found');
        this.$notify({
          title: 'No instagram username found',
          message: 'This contact does not have an instagram username',
          type: 'warning',
          group: 'user',
        });
      }
    },
    textCreator(phone) {
      //go to the url sms:creator.meta.phone
      //if phone is not null
      if (phone) {
        window.open('sms:' + phone);
        //else log no phone found
      } else {
        console.log('No phone number found');
        this.$notify({
          title: 'No phone number found',
          message: 'This contact does not have a phone number',
          type: 'warning',
          group: 'user',
        });
      }
    },
    generateVCF(creator) {
      let vCard = 'BEGIN:VCARD\n';
      vCard += 'VERSION:3.0\n';
      //if creator has a first name
      //if the creator has an instagram handler then set instagram to the instagram handler
      //else if the creator has a meta.instagram_handler then set instagram to the meta.instagram_handler
      //else set instagram to null

      /*       //if creator has an email
     if (creator.emails[0]) {
        vCard += 'EMAIL;TYPE=PREF,INTERNET:' + creator.emails[0] + '\n';
      } else if
      {
        vCard += 'EMAIL;TYPE=PREF,INTERNET:' + creator.meta.emails + '\n';
      } else {
        console.log('No email found');
      };
      //set employer
      if (creator.meta.employer) {
        vCard += 'ORG:' + creator.meta.employer + '\n';
      } else {
        console.log('No employer found');
      };
      //set title
      if (creator.meta.title) {
        vCard += 'TITLE:' + creator.meta.title + '\n';
      } else {
        console.log('No title found');
      };
      if (Creator.location) {
        vCard += 'ADR;TYPE=WORK:;;' + Creator.location + '\n';
      }
      //if creator.instagram_handler set instagram else if creator.meta.instagram set instagram else log no instagram found
      if (creator.instagram_handler) {
        vCard += 'URL;TYPE=WORK:' + creator.instagram_handler + '\n';
      } else if
      {
        vCard += 'URL;TYPE=WORK:' + creator.meta.instagram + '\n';
      } else {
        console.log('No instagram found');
      };
      //do the twitter and twitch and youtube and tiktok and linkedin
      if (creator.twitter_handler) {
        vCard += 'URL;TYPE=WORK:' + creator.twitter_handler + '\n';
      } else if
      {
        vCard += 'URL;TYPE=WORK:' + creator.meta.twitter + '\n';
      } else {
        console.log('No twitter found');
      };
      if (creator.twitch_handler) {
        vCard += 'URL;TYPE=WORK:' + creator.twitch_handler + '\n';
      } else if
      {
        vCard += 'URL;TYPE=WORK:' + creator.meta.twitch + '\n';
      } else {
        console.log('No twitch found');
      };
      if (creator.youtube_handler) {
        vCard += 'URL;TYPE=WORK:' + creator.youtube_handler + '\n';
      } else if
      {
        vCard += 'URL;TYPE=WORK:' + creator.meta.youtube + '\n';
      } else {
        console.log('No youtube found');
      };
      if (creator.tiktok_handler) {
        vCard += 'URL;TYPE=WORK:' + creator.tiktok_handler + '\n';
      } else if
      {
        vCard += 'URL;TYPE=WORK:' + creator.meta.tiktok + '\n';
      } else {
        console.log('No tiktok found');
      };
      if (creator.linkedin_handler) {
        vCard += 'URL;TYPE=WORK:' + creator.linkedin_handler + '\n';
      } else if {
        vCard += 'URL;TYPE=WORK:' + creator.meta.linkedin + '\n';
      } else {console.log('No linkedin found');
      }; */

      vCard += 'NOTE:Saved from Jovie\n';

      vCard += 'END:VCARD';
      return vCard;
    },
    downloadVCF(creator) {
      let vCard = this.generateVCF(creator);
      let blob = new Blob([vCard], { type: 'text/vcard' });
      let url = URL.createObjectURL(blob);
      let link = document.createElement('a');
      link.setAttribute('href', url);
      link.setAttribute('download', this.creator.meta.name + '.vcf');
      link.click();
    },
    toggleSearchVisible() {
      //if search is not visible then make it visible and focus on the search input
      if (!this.searchVisible) {
        this.searchVisible = true;
        this.$nextTick(() => {
          this.$refs.searchInput.focus();
        });
      }
      //else make it not visible
      else {
        this.searchVisible = false;
      }
    },
    setCurrentRow(row) {
      this.currentRow = row;
      console.log(this.currentRow);
    },
    toggleArchiveCreators(ids, archived) {
      this.$store
        .dispatch('toggleArchiveCreators', {
          creator_ids: ids,
          archived: archived,
        })
        .then((response) => {
          response = response.data;
          if (response.status) {
            let creatorIds = Array.isArray(ids) ? ids : [ids];
            this.creatorRecords = this.creatorRecords.filter(
              (creator) => !creatorIds.includes(creator.id)
            );
            this.$notify({
              group: 'user',
              type: 'success',
              duration: 15000,
              title: 'Successful',
              text: response.message,
            });
            this.$emit('crmCounts');
          } else {
            this.$notify({
              group: 'user',
              type: 'success',
              duration: 15000,
              title: 'Successful',
              text: response.message,
            });
          }
        })
        .catch((error) => {
          error = error.response;
          if (error.status == 422) {
            if (this.errors) {
              this.errors = error.data.errors;
            }
            this.$notify({
              group: 'user',
              type: 'success',
              duration: 15000,
              title: 'Successful',
              text: Object.values(error.data.errors)[0][0],
            });
          }
        })
        .finally((response) => {});
    },
    addCreatorsToList(id) {
      this.toggleCreatorsFromList(this.selectedCreators, id, false);
    },
    toggleCreatorsFromList(ids, list, remove) {
      this.$store
        .dispatch('toggleCreatorsFromList', {
          creator_ids: ids,
          list: list,
          remove: remove,
        })
        .then((response) => {
          response = response.data;
          if (response.status) {
            let creatorIds = Array.isArray(ids) ? ids : [ids];
            if (remove && this.filters.list == list) {
              this.creatorRecords = this.creatorRecords.filter(
                (creator) => !creatorIds.includes(creator.id)
              );
              this.$store.state.ContactSidebarOpen = false;
            }
            this.$notify({
              group: 'user',
              type: 'success',
              duration: 15000,
              title: 'Successful',
              text: response.message,
            });
            this.$emit('crmCounts');
            this.$emit('updateListCount', {
              count: creatorIds.length,
              list_id: list,
              remove: remove,
            });
          } else {
            this.$notify({
              group: 'user',
              type: 'success',
              duration: 15000,
              title: 'Successful',
              text: 'Contact has been' + response.message + 'from list',
            });
          }
        })
        .catch((error) => {
          error = error.response;
          if (error.status == 422) {
            this.errors = error.data.errors;
            this.$notify({
              group: 'user',
              type: 'success',
              duration: 15000,
              title: 'Successful',
              text: Object.values(error.data.errors)[0][0],
            });
          }
        })
        .finally((response) => {});
      this.resetChecked();
    },
    toggleContactSidebar() {
      //toggle this.$store.state.ContactSidebarOpen

      this.$store.state.ContactSidebarOpen =
        !this.$store.state.ContactSidebarOpen;
    },
    /* setActiveCreator(creator) {
      this.activeCreator = creator;
      //emit the active creator to the parent component
      this.$emit('activeCreator', creator);
      //log the id of the active creator in the console
      console.log('The active creator is ' + this.activeCreator);
    }, */
    setCurrentContact(e, creator) {
      this.currentContact = creator;

      // if (e.target.name == 'selectCreatorCheckbox') {
      //   if (this.selectedCreators.includes(creator.id)) {
      //     this.selectedCreators.splice(
      //       this.selectedCreators.indexOf(creator.id),
      //       1
      //     );
      //   } else {
      //     this.selectedCreators.push(creator.id);
      //   }
      // }
      this.$emit('setCurrentContact', creator);
    },
    nextContact() {
      const index = this.creatorRecords.indexOf(this.currentContact);
      if (index < this.creatorRecords.length - 1) {
        this.setCurrentContact(
          'setCurrentCreator',
          this.creatorRecords[index + 1]
        );
      }
    },
    previousContact() {
      const index = this.creatorRecords.indexOf(this.currentContact);
      if (index > 0) {
        this.setCurrentContact(
          'setCurrentCreator',
          this.creatorRecords[index - 1]
        );
      }
    },
    importCSV() {
      //emit the importCSV event to the parent component
      //push router to /import
      this.$router.push('/import');
    },
    refresh(creator) {
      let imports = {};
      this.networks.forEach((network) => {
        imports[network] = creator[`${network}_handler`];
      });
      if (!Object.keys(imports).length) return;
      this.adding = true;
      ImportService.import(imports)
        .then((response) => {
          response = response.data;
          if (response.status) {
            this.$notify({
              group: 'user',
              type: 'success',
              title: 'Import initiated',
              text: 'Your data is being updated.',
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
          error = error.response;
          if (error.status == 422) {
            this.errors = error.data.errors;
          }
        })
        .finally((response) => {
          this.adding = false;
        });
    },
  },
};
</script>

<style>
.dp__theme_dark {
  --dp-background-color: #191a22;
  --dp-text-color: #ffffff;
  --dp-hover-color: #484848;
  --dp-hover-text-color: #ffffff;
  --dp-hover-icon-color: #959595;
  --dp-primary-color: #005cb2;
  --dp-primary-text-color: #ffffff;
  --dp-secondary-color: #a9a9a9;
  --dp-border-color: #292b41;
  --dp-menu-border-color: #2d2d2d;
  --dp-border-color-hover: #aaaeb7;
  --dp-disabled-color: #737373;
  --dp-scroll-bar-background: #212121;
  --dp-scroll-bar-color: #484848;
  --dp-success-color: #00701a;
  --dp-success-color-disabled: #428f59;
  --dp-icon-color: #959595;
  --dp-danger-color: #e53935;
  --dp-highlight-color: rgba(80, 0, 178, 0.2);
  --dp-row_margin: 0px 0 !default;
  --dp-common_padding: 0px !default;
  --dp-font_size: 0.5rem !default;
  /* 
  --dp-font_family: -apple-system, blinkmacsystemfont, 'Segoe UI', roboto,
    oxygen, ubuntu, cantarell, 'Open Sans', 'Helvetica Neue', sans-serif !default;
  --dp-border_radius: 4px !default;
  --dp-cell_border_radius: --dp-border_radius !default;

  --dp-transition_length: 22px !default; // Passed to the translateX in animation
  --dp-transition_duration: 0.1s !default; // Transition duration

  --dp-button_height: 35px !default; // size for buttons in overlays
  --dp-month_year_row_height: 35px !default; // height of the month-year select row
  --dp-month_year_row_button_size: 25px !default; // Specific height for the next/previous buttons
  --dp-button_icon_height: 20px !default; // icon sizing in buttons
  --dp-cell_size: 35px !default; // width and height of calendar cell
  --dp-cell_padding: 5px !default; // padding in the cell
 
  --dp-input_padding: 6px 6px !default; // padding in the input
  --dp-input_icon_padding: 35px !default; // Padding on the left side of the input if icon is present
  --dp-menu_min_width: 260px !default; // Adjust the min width of the menu
  --dp-action_buttons_padding: 2px 5px !default; // Adjust padding for the action buttons in action row
 
  --dp-calendar_header_cell_padding: 0.5rem !default; // Adjust padding in calendar header cells
  --dp-two_calendars_spacing: 10px !default; // Space between two calendars if using two calendars
  --dp-overlay_col_padding: 3px !default; // Padding in the overlay column
  --dp-time_inc_dec_button_size: 32px !default; // Sizing for arrow buttons in the time picker */
  /* 
  // Font sizes
 
  --dp-preview_font_size: 0.8rem !default; // font size of the date preview in the action row
  --dp-time_font_size: 2rem !default; // font size in the time picker */
}

.dp__theme_light {
  --dp-background-color: #ffffff;
  --dp-text-color: #212121;
  --dp-hover-color: #f3f3f3;
  --dp-hover-text-color: #212121;
  --dp-hover-icon-color: #959595;
  --dp-primary-color: #1976d2;
  --dp-primary-text-color: #f8f5f5;
  --dp-secondary-color: #c0c4cc;
  --dp-border-color: #ddd;
  --dp-menu-border-color: #ddd;
  --dp-border-color-hover: #aaaeb7;
  --dp-disabled-color: #f6f6f6;
  --dp-scroll-bar-background: #f3f3f3;
  --dp-scroll-bar-color: #959595;
  --dp-success-color: #76d275;
  --dp-success-color-disabled: #a3d9b1;
  --dp-icon-color: #959595;
  --dp-danger-color: #ff6f60;
  --dp-highlight-color: rgba(80, 0, 178, 0.2);
  --dp-row_margin: 0px 0 !default;
  --dp-common_padding: 0px !default;
  --dp-font_size: 0.5rem !default;
}
</style>


how can i make this more concise


## See Also
- [[chatgpt/chatgpt_1-of-body-weight-part2]]
- [[chatgpt/chatgpt_accident-liability-and-insurance-part2]]
- [[chatgpt/chatgpt_accident-timing-and-coverage-part2]]
- [[chatgpt/chatgpt_age-field-update-issue-part2]]
- [[chatgpt/chatgpt_agentic-os-for-artists-part2]]
