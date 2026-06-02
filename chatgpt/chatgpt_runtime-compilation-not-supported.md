---
title: "Runtime compilation not supported."
type: note
created: 2023-05-12
updated: 2023-05-12
source: chatgpt-export
conversation_id: c0c73567-bed1-4e17-b9be-0cdf9204e4e6
message_count: 2
tags: [chatgpt, import, code]
---
# Runtime compilation not supported.

> Conversation ID: c0c73567-bed1-4e17-b9be-0cdf9204e4e6
> Created: 2023-05-12T07:47:02Z
> Updated: 2023-05-12T07:47:15Z
> Messages: 2

---

## User

 Component provided template option but runtime compilation is not supported in this build of Vue. Configure your bundler to alias "vue" to "vue/dist/vue.esm-bundler.js". 
  at <App>

---

## Assistant

The error message suggests that the current build of Vue you're using does not support runtime compilation. To resolve this issue, you need to configure your bundler to alias "vue" to "vue/dist/vue.esm-bundler.js". 

If you're using a bundler like Webpack, you can add an alias in the configuration file. Here's an example of how you can do it:

```javascript
// webpack.config.js

module.exports = {
  // ... other webpack configurations

  resolve: {
    alias: {
      'vue$': 'vue/dist/vue.esm-bundler.js'
    }
  }
};
```

By adding the alias, you're instructing the bundler to use the Vue bundler build that supports runtime compilation.

Make sure you have the correct build of Vue installed. You can check your package.json or run `npm ls vue` to see the installed version. If you have a different version, you might need to update it to the version that supports runtime compilation.

After making these changes, rebuild your application, and the error should be resolved.


## See Also
- [[chatgpt/chatgpt_core-values-compilation-part1]]
- [[chatgpt/chatgpt_core-values-compilation-part2]]
- [[chatgpt/chatgpt_inventory-list-compilation]]
- [[chatgpt/chatgpt_order-list-compilation]]
- [[chatgpt/chatgpt_contact-apis-supported]]
