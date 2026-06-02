---
title: "Convert to Composition API"
type: note
created: 2022-12-22
updated: 2022-12-22
source: chatgpt-export
conversation_id: f49c48a5-4019-43a3-9473-ea3788232071
message_count: 2
tags: [chatgpt, import, code]
---
# Convert to Composition API

> Conversation ID: f49c48a5-4019-43a3-9473-ea3788232071
> Created: 2022-12-22T01:50:02Z
> Updated: 2022-12-22T01:50:02Z
> Messages: 2

---

## User

convert this to the composition api and make the function use async setup


<script>
import axios from 'axios';
import AdminStatCard from './../components/AdminStatCard.vue';
import JovieLogo from './../components/JovieLogo.vue';
import { ArrowPathIcon } from '@heroicons/vue/24/solid';
//import

export default {
  components: {
    AdminStatCard,
    JovieLogo,
    ArrowPathIcon,
  },
  data() {
    return {
      stats: {},
      cashBalance: 0,
    };
  },
  mounted() {
    this.getNewStats();

    /* axios.get('/api/admin-stats').then((response) => {
      this.stats = response.data;
    }); */
    //use mouse trap to creat keyboard shortcuts
  },
  methods: {
    getNewStats() {
      axios.get('/api/admin-stats').then((response) => {
        if (response.status === 200) {
          this.stats = response.data;
        } else {
          //show error message
          this.$notify({
            group: 'user',
            title: 'Somethign went wrong',

            type: 'error',
            text: 'There was an error getting the stats',
          });
        }
      });
      axios.get('/api/account-balance').then((response) => {
        if (response.status === 200) {
          this.cashBalance = response.data.cashBalance;
        } else {
          //show error message
          this.$notify({
            group: 'user',
            title: 'Somethign went wrong',

            type: 'error',
            text: 'There was an error getting the stats',
          });
        }
      });
      this.$notify({
        group: 'user',
        title: 'Stats Updated',
        type: 'success',
        text: 'The stats have been updated',
      });
    },
  },
};
</script>

---

## Assistant

Here is an example of how you could convert the code above to use the composition api and async setup:

```
import { ref, computed } from 'vue';
import axios from 'axios';
import AdminStatCard from './../components/AdminStatCard.vue';
import JovieLogo from './../components/JovieLogo.vue';
import { ArrowPathIcon } from '@heroicons/vue/24/solid';

export default {
  components: {
    AdminStatCard,
    JovieLogo,
    ArrowPathIcon,
  },
  setup() {
    const stats = ref({});
    const cashBalance = ref(0);

    const getNewStats = async () => {
      try {
        const response = await axios.get('/api/admin-stats');
        if (response.status === 200) {
          stats.value = response.data;
        } else {
          throw new Error('There was an error getting the stats');
        }
      } catch (error) {
        this.$notify({
          group: 'user',
          title: 'Something went wrong',
          type: 'error',
          text: error.message,
        });
      }

      try {
        const response = await axios.get('/api/account-balance');
        if (response.status === 200) {
          cashBalance.value = response.data.cashBalance;
        } else {
          throw new Error('There was an error getting the stats');
        }
      } catch (error) {
        this.$notify({
          group: 'user',
          title: 'Something went wrong',
          type: 'error',
          text: error.message,
        });
      }

      this.$notify({
        group: 'user',
        title: 'Stats Updated',
        type: 'success',
        text: 'The stats have been updated',
      });
    };

    return {
      stats,
      cashBalance,
      getNewStats,
    };
  },
  async setup() {
    await getNewStats();
  }
};
```

Note that the `this` keyword will not be accessible inside the `getNewStats` function as it is not bound to the component instance. To access component properties and methods, you can use the `$notify` method provided by the `vue-notification` package. You will also need to make sure that the package is installed and properly configured in your project.



## See Also
- [[chatgpt/chatgpt_convert-component-to-composition-api]]
- [[chatgpt/chatgpt_convert-to-composition-api]]
- [[chatgpt/chatgpt_convert-code-to-emit-event]]
- [[chatgpt/chatgpt_convert-heic-to-jpg]]
- [[chatgpt/chatgpt_convert-height-to-feet]]
