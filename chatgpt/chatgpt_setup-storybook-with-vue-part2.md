
timwhite@tims-mbp Jovie % npm run storybook                 

> storybook
> start-storybook -p 6006

info @storybook/vue3 v6.5.15
info 
info => Loading presets
info Addon-docs: using MDX1
info => Using implicit CSS loaders
info => Using default Webpack5 setup
<i> [webpack-dev-middleware] wait until bundle finished
10% building 0/1 entries 0/0 dependencies 0/0 modules
info => Ignoring cached manager due to change in manager config
<i> [webpack-dev-middleware] wait until bundle finished
95% emitting emitassets by chunk 6.12 MiB (id hint: vendors)
  assets by status 5.9 MiB [big]
    asset vendors-node_modules_storybook_addon-actions_manager_js-node_modules_storybook_addon-backgrou-076004.manager.bundle.js 4.46 MiB [emitted] [big] (id hint: vendors)
    asset vendors-node_modules_storybook_components_dist_esm_formatter-0d5cb0eb_js.manager.bundle.js 887 KiB [emitted] [big] (id hint: vendors)
    asset vendors-node_modules_storybook_components_dist_esm_OverlayScrollbars-1355f44c_js.manager.bundle.js 295 KiB [emitted] [big] (id hint: vendors)
    asset vendors-node_modules_storybook_components_dist_esm_syntaxhighlighter-b07b042a_js.manager.bundle.js 286 KiB [emitted] [big] (id hint: vendors)
  asset vendors-node_modules_storybook_components_dist_esm_WithTooltip-167e9982_js.manager.bundle.js 126 KiB [emitted] (id hint: vendors)
  asset vendors-node_modules_storybook_components_dist_esm_Color-f953d088_js.manager.bundle.js 82.8 KiB [emitted] (id hint: vendors)
  asset vendors-node_modules_storybook_components_dist_esm_GlobalScrollAreaStyles-8793ce4a_js.manager.bundle.js 15.5 KiB [emitted] (id hint: vendors)
asset runtime~main.manager.bundle.js 14.1 KiB [emitted] (name: runtime~main)
asset index.html 4.5 KiB [emitted]
asset main.manager.bundle.js 1.49 KiB [emitted] (name: main)
asset node_modules_unfetch_dist_unfetch_js.manager.bundle.js 1.26 KiB [emitted]
Entrypoint main [big] 4.48 MiB = runtime~main.manager.bundle.js 14.1 KiB vendors-node_modules_storybook_addon-actions_manager_js-node_modules_storybook_addon-backgrou-076004.manager.bundle.js 4.46 MiB main.manager.bundle.js 1.49 KiB
orphan modules 980 KiB [orphan] 126 modules
runtime modules 8.59 KiB 15 modules
modules by path ./node_modules/ 5.44 MiB 899 modules
./util.inspect (ignored) 15 bytes [built] [code generated]
manager (webpack 5.75.0) compiled successfully in 11826 ms
99% done plugins webpack-hot-middlewarewebpack built preview 63395387f3d8c9210cbd in 12415ms
WARN Force closed manager build
ModuleNotFoundError: Module not found: Error: Can't resolve 'resources/css/app.css' in '/Users/timwhite/Documents/GitHub/Jovie/.storybook'
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/webpack/lib/Compilation.js:2016:28
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/webpack/lib/NormalModuleFactory.js:798:13
    at eval (eval at create (/Users/timwhite/Documents/GitHub/Jovie/node_modules/tapable/lib/HookCodeFactory.js:33:10), <anonymous>:10:1)
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/webpack/lib/NormalModuleFactory.js:270:22
    at eval (eval at create (/Users/timwhite/Documents/GitHub/Jovie/node_modules/tapable/lib/HookCodeFactory.js:33:10), <anonymous>:9:1)
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/webpack/lib/NormalModuleFactory.js:434:22
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/webpack/lib/NormalModuleFactory.js:116:11
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/webpack/lib/NormalModuleFactory.js:670:25
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/webpack/lib/NormalModuleFactory.js:855:8
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/webpack/lib/NormalModuleFactory.js:975:5
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/neo-async/async.js:6883:13
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/webpack/lib/NormalModuleFactory.js:958:45
    at finishWithoutResolve (/Users/timwhite/Documents/GitHub/Jovie/node_modules/enhanced-resolve/lib/Resolver.js:312:11)
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/enhanced-resolve/lib/Resolver.js:386:15
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/enhanced-resolve/lib/Resolver.js:435:5
    at eval (eval at create (/Users/timwhite/Documents/GitHub/Jovie/node_modules/tapable/lib/HookCodeFactory.js:33:10), <anonymous>:16:1)
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/enhanced-resolve/lib/Resolver.js:435:5
    at eval (eval at create (/Users/timwhite/Documents/GitHub/Jovie/node_modules/tapable/lib/HookCodeFactory.js:33:10), <anonymous>:27:1)
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/enhanced-resolve/lib/DescriptionFilePlugin.js:87:43
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/enhanced-resolve/lib/Resolver.js:435:5
    at eval (eval at create (/Users/timwhite/Documents/GitHub/Jovie/node_modules/tapable/lib/HookCodeFactory.js:33:10), <anonymous>:16:1)
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/enhanced-resolve/lib/forEachBail.js:16:12
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/enhanced-resolve/lib/AliasPlugin.js:125:14
    at next (/Users/timwhite/Documents/GitHub/Jovie/node_modules/enhanced-resolve/lib/forEachBail.js:14:3)
    at forEachBail (/Users/timwhite/Documents/GitHub/Jovie/node_modules/enhanced-resolve/lib/forEachBail.js:24:9)
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/enhanced-resolve/lib/AliasPlugin.js:51:5
    at _next0 (eval at create (/Users/timwhite/Documents/GitHub/Jovie/node_modules/tapable/lib/HookCodeFactory.js:33:10), <anonymous>:8:1)
    at eval (eval at create (/Users/timwhite/Documents/GitHub/Jovie/node_modules/tapable/lib/HookCodeFactory.js:33:10), <anonymous>:30:1)
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/enhanced-resolve/lib/Resolver.js:435:5
    at eval (eval at create (/Users/timwhite/Documents/GitHub/Jovie/node_modules/tapable/lib/HookCodeFactory.js:33:10), <anonymous>:16:1)
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/enhanced-resolve/lib/Resolver.js:435:5
    at eval (eval at create (/Users/timwhite/Documents/GitHub/Jovie/node_modules/tapable/lib/HookCodeFactory.js:33:10), <anonymous>:16:1)
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/enhanced-resolve/lib/Resolver.js:435:5
    at eval (eval at create (/Users/timwhite/Documents/GitHub/Jovie/node_modules/tapable/lib/HookCodeFactory.js:33:10), <anonymous>:27:1)
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/enhanced-resolve/lib/DescriptionFilePlugin.js:87:43
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/enhanced-resolve/lib/Resolver.js:435:5
    at eval (eval at create (/Users/timwhite/Documents/GitHub/Jovie/node_modules/tapable/lib/HookCodeFactory.js:33:10), <anonymous>:16:1)
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/enhanced-resolve/lib/Resolver.js:435:5
    at eval (eval at create (/Users/timwhite/Documents/GitHub/Jovie/node_modules/tapable/lib/HookCodeFactory.js:33:10), <anonymous>:15:1)
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/enhanced-resolve/lib/DirectoryExistsPlugin.js:41:15
    at processTicksAndRejections (node:internal/process/task_queues:82:21)
resolve 'resources/css/app.css' in '/Users/timwhite/Documents/GitHub/Jovie/.storybook'
  Parsed request is a module
  using description file: /Users/timwhite/Documents/GitHub/Jovie/package.json (relative path: ./.storybook)
    Field 'browser' doesn't contain a valid alias configuration
    resolve as module
      /Users/timwhite/Documents/GitHub/Jovie/.storybook/node_modules doesn't exist or is not a directory
      looking for modules in /Users/timwhite/Documents/GitHub/Jovie/node_modules
        /Users/timwhite/Documents/GitHub/Jovie/node_modules/resources doesn't exist
      /Users/timwhite/Documents/GitHub/node_modules doesn't exist or is not a directory
      /Users/timwhite/Documents/node_modules doesn't exist or is not a directory
      /Users/timwhite/node_modules doesn't exist or is not a directory
      /Users/node_modules doesn't exist or is not a directory
      /node_modules doesn't exist or is not a directory
ModuleNotFoundError: Module not found: Error: Can't resolve 'resources/css/app.css' in '/Users/timwhite/Documents/GitHub/Jovie/.storybook'
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/webpack/lib/Compilation.js:2016:28
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/webpack/lib/NormalModuleFactory.js:798:13
    at eval (eval at create (/Users/timwhite/Documents/GitHub/Jovie/node_modules/tapable/lib/HookCodeFactory.js:33:10), <anonymous>:10:1)
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/webpack/lib/NormalModuleFactory.js:270:22
    at eval (eval at create (/Users/timwhite/Documents/GitHub/Jovie/node_modules/tapable/lib/HookCodeFactory.js:33:10), <anonymous>:9:1)
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/webpack/lib/NormalModuleFactory.js:434:22
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/webpack/lib/NormalModuleFactory.js:116:11
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/webpack/lib/NormalModuleFactory.js:670:25
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/webpack/lib/NormalModuleFactory.js:855:8
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/webpack/lib/NormalModuleFactory.js:975:5
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/neo-async/async.js:6883:13
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/webpack/lib/NormalModuleFactory.js:958:45
    at finishWithoutResolve (/Users/timwhite/Documents/GitHub/Jovie/node_modules/enhanced-resolve/lib/Resolver.js:312:11)
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/enhanced-resolve/lib/Resolver.js:386:15
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/enhanced-resolve/lib/Resolver.js:435:5
    at eval (eval at create (/Users/timwhite/Documents/GitHub/Jovie/node_modules/tapable/lib/HookCodeFactory.js:33:10), <anonymous>:16:1)
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/enhanced-resolve/lib/Resolver.js:435:5
    at eval (eval at create (/Users/timwhite/Documents/GitHub/Jovie/node_modules/tapable/lib/HookCodeFactory.js:33:10), <anonymous>:27:1)
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/enhanced-resolve/lib/DescriptionFilePlugin.js:87:43
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/enhanced-resolve/lib/Resolver.js:435:5
    at eval (eval at create (/Users/timwhite/Documents/GitHub/Jovie/node_modules/tapable/lib/HookCodeFactory.js:33:10), <anonymous>:16:1)
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/enhanced-resolve/lib/forEachBail.js:16:12
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/enhanced-resolve/lib/AliasPlugin.js:125:14
    at next (/Users/timwhite/Documents/GitHub/Jovie/node_modules/enhanced-resolve/lib/forEachBail.js:14:3)
    at forEachBail (/Users/timwhite/Documents/GitHub/Jovie/node_modules/enhanced-resolve/lib/forEachBail.js:24:9)
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/enhanced-resolve/lib/AliasPlugin.js:51:5
    at _next0 (eval at create (/Users/timwhite/Documents/GitHub/Jovie/node_modules/tapable/lib/HookCodeFactory.js:33:10), <anonymous>:8:1)
    at eval (eval at create (/Users/timwhite/Documents/GitHub/Jovie/node_modules/tapable/lib/HookCodeFactory.js:33:10), <anonymous>:30:1)
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/enhanced-resolve/lib/Resolver.js:435:5
    at eval (eval at create (/Users/timwhite/Documents/GitHub/Jovie/node_modules/tapable/lib/HookCodeFactory.js:33:10), <anonymous>:16:1)
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/enhanced-resolve/lib/Resolver.js:435:5
    at eval (eval at create (/Users/timwhite/Documents/GitHub/Jovie/node_modules/tapable/lib/HookCodeFactory.js:33:10), <anonymous>:16:1)
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/enhanced-resolve/lib/Resolver.js:435:5
    at eval (eval at create (/Users/timwhite/Documents/GitHub/Jovie/node_modules/tapable/lib/HookCodeFactory.js:33:10), <anonymous>:27:1)
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/enhanced-resolve/lib/DescriptionFilePlugin.js:87:43
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/enhanced-resolve/lib/Resolver.js:435:5
    at eval (eval at create (/Users/timwhite/Documents/GitHub/Jovie/node_modules/tapable/lib/HookCodeFactory.js:33:10), <anonymous>:16:1)
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/enhanced-resolve/lib/Resolver.js:435:5
    at eval (eval at create (/Users/timwhite/Documents/GitHub/Jovie/node_modules/tapable/lib/HookCodeFactory.js:33:10), <anonymous>:15:1)
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/enhanced-resolve/lib/DirectoryExistsPlugin.js:41:15
    at processTicksAndRejections (node:internal/process/task_queues:82:21)
resolve 'resources/css/app.css' in '/Users/timwhite/Documents/GitHub/Jovie/.storybook'
  Parsed request is a module
  using description file: /Users/timwhite/Documents/GitHub/Jovie/package.json (relative path: ./.storybook)
    Field 'browser' doesn't contain a valid alias configuration
    resolve as module
      /Users/timwhite/Documents/GitHub/Jovie/.storybook/node_modules doesn't exist or is not a directory
      looking for modules in /Users/timwhite/Documents/GitHub/Jovie/node_modules
        /Users/timwhite/Documents/GitHub/Jovie/node_modules/resources doesn't exist
      /Users/timwhite/Documents/GitHub/node_modules doesn't exist or is not a directory
      /Users/timwhite/Documents/node_modules doesn't exist or is not a directory
      /Users/timwhite/node_modules doesn't exist or is not a directory
      /Users/node_modules doesn't exist or is not a directory
      /node_modules doesn't exist or is not a directory

WARN Broken build, fix the error above.
WARN You may need to refresh the browser.

info => Loading presets
95% emitting emit%        


It seems there is an issue with the path of the file 'resources/css/app.css', The error message is saying that it can't resolve the path of the file in the directory '/Users/timwhite/Documents/GitHub/Jovie/.storybook'. It could be that the path is not correct or the file is missing or not placed in the correct directory. You might want to check the path and make sure the file 'resources/css/app.css' is present in the correct directory.



99% done plugins webpack-hot-middlewarewebpack built preview a6776cb82df0aaa91874 in 8980ms
ModuleNotFoundError: Module not found: Error: Can't resolve 'tailwind/tailwind.css' in '/Users/timwhite/Documents/GitHub/Jovie/.storybook'
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/webpack/lib/Compilation.js:2016:28
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/webpack/lib/NormalModuleFactory.js:798:13
    at eval (eval at create (/Users/timwhite/Documents/GitHub/Jovie/node_modules/tapable/lib/HookCodeFactory.js:33:10), <anonymous>:10:1)
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/webpack/lib/NormalModuleFactory.js:270:22
    at eval (eval at create (/Users/timwhite/Documents/GitHub/Jovie/node_modules/tapable/lib/HookCodeFactory.js:33:10), <anonymous>:9:1)
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/webpack/lib/NormalModuleFactory.js:434:22
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/webpack/lib/NormalModuleFactory.js:116:11
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/webpack/lib/NormalModuleFactory.js:670:25
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/webpack/lib/NormalModuleFactory.js:855:8
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/webpack/lib/NormalModuleFactory.js:975:5
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/neo-async/async.js:6883:13
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/webpack/lib/NormalModuleFactory.js:958:45
    at finishWithoutResolve (/Users/timwhite/Documents/GitHub/Jovie/node_modules/enhanced-resolve/lib/Resolver.js:312:11)
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/enhanced-resolve/lib/Resolver.js:386:15
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/enhanced-resolve/lib/Resolver.js:435:5
    at eval (eval at create (/Users/timwhite/Documents/GitHub/Jovie/node_modules/tapable/lib/HookCodeFactory.js:33:10), <anonymous>:16:1)
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/enhanced-resolve/lib/Resolver.js:435:5
    at eval (eval at create (/Users/timwhite/Documents/GitHub/Jovie/node_modules/tapable/lib/HookCodeFactory.js:33:10), <anonymous>:27:1)
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/enhanced-resolve/lib/DescriptionFilePlugin.js:87:43
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/enhanced-resolve/lib/Resolver.js:435:5
    at eval (eval at create (/Users/timwhite/Documents/GitHub/Jovie/node_modules/tapable/lib/HookCodeFactory.js:33:10), <anonymous>:16:1)
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/enhanced-resolve/lib/forEachBail.js:16:12
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/enhanced-resolve/lib/AliasPlugin.js:125:14
    at next (/Users/timwhite/Documents/GitHub/Jovie/node_modules/enhanced-resolve/lib/forEachBail.js:14:3)
    at forEachBail (/Users/timwhite/Documents/GitHub/Jovie/node_modules/enhanced-resolve/lib/forEachBail.js:24:9)
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/enhanced-resolve/lib/AliasPlugin.js:51:5
    at _next0 (eval at create (/Users/timwhite/Documents/GitHub/Jovie/node_modules/tapable/lib/HookCodeFactory.js:33:10), <anonymous>:8:1)
    at eval (eval at create (/Users/timwhite/Documents/GitHub/Jovie/node_modules/tapable/lib/HookCodeFactory.js:33:10), <anonymous>:30:1)
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/enhanced-resolve/lib/Resolver.js:435:5
    at eval (eval at create (/Users/timwhite/Documents/GitHub/Jovie/node_modules/tapable/lib/HookCodeFactory.js:33:10), <anonymous>:16:1)
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/enhanced-resolve/lib/Resolver.js:435:5
    at eval (eval at create (/Users/timwhite/Documents/GitHub/Jovie/node_modules/tapable/lib/HookCodeFactory.js:33:10), <anonymous>:16:1)
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/enhanced-resolve/lib/Resolver.js:435:5
    at eval (eval at create (/Users/timwhite/Documents/GitHub/Jovie/node_modules/tapable/lib/HookCodeFactory.js:33:10), <anonymous>:27:1)
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/enhanced-resolve/lib/DescriptionFilePlugin.js:87:43
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/enhanced-resolve/lib/Resolver.js:435:5
    at eval (eval at create (/Users/timwhite/Documents/GitHub/Jovie/node_modules/tapable/lib/HookCodeFactory.js:33:10), <anonymous>:16:1)
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/enhanced-resolve/lib/Resolver.js:435:5
    at eval (eval at create (/Users/timwhite/Documents/GitHub/Jovie/node_modules/tapable/lib/HookCodeFactory.js:33:10), <anonymous>:15:1)
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/enhanced-resolve/lib/DirectoryExistsPlugin.js:41:15
    at processTicksAndRejections (node:internal/process/task_queues:82:21)
resolve 'tailwind/tailwind.css' in '/Users/timwhite/Documents/GitHub/Jovie/.storybook'
  Parsed request is a module
  using description file: /Users/timwhite/Documents/GitHub/Jovie/package.json (relative path: ./.storybook)
    Field 'browser' doesn't contain a valid alias configuration
    resolve as module
      /Users/timwhite/Documents/GitHub/Jovie/.storybook/node_modules doesn't exist or is not a directory
      looking for modules in /Users/timwhite/Documents/GitHub/Jovie/node_modules
        /Users/timwhite/Documents/GitHub/Jovie/node_modules/tailwind doesn't exist
      /Users/timwhite/Documents/GitHub/node_modules doesn't exist or is not a directory
      /Users/timwhite/Documents/node_modules doesn't exist or is not a directory
      /Users/timwhite/node_modules doesn't exist or is not a directory
      /Users/node_modules doesn't exist or is not a directory
      /node_modules doesn't exist or is not a directory
ModuleNotFoundError: Module not found: Error: Can't resolve 'tailwind/tailwind.css' in '/Users/timwhite/Documents/GitHub/Jovie/.storybook'
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/webpack/lib/Compilation.js:2016:28
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/webpack/lib/NormalModuleFactory.js:798:13
    at eval (eval at create (/Users/timwhite/Documents/GitHub/Jovie/node_modules/tapable/lib/HookCodeFactory.js:33:10), <anonymous>:10:1)
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/webpack/lib/NormalModuleFactory.js:270:22
    at eval (eval at create (/Users/timwhite/Documents/GitHub/Jovie/node_modules/tapable/lib/HookCodeFactory.js:33:10), <anonymous>:9:1)
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/webpack/lib/NormalModuleFactory.js:434:22
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/webpack/lib/NormalModuleFactory.js:116:11
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/webpack/lib/NormalModuleFactory.js:670:25
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/webpack/lib/NormalModuleFactory.js:855:8
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/webpack/lib/NormalModuleFactory.js:975:5
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/neo-async/async.js:6883:13
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/webpack/lib/NormalModuleFactory.js:958:45
    at finishWithoutResolve (/Users/timwhite/Documents/GitHub/Jovie/node_modules/enhanced-resolve/lib/Resolver.js:312:11)
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/enhanced-resolve/lib/Resolver.js:386:15
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/enhanced-resolve/lib/Resolver.js:435:5
    at eval (eval at create (/Users/timwhite/Documents/GitHub/Jovie/node_modules/tapable/lib/HookCodeFactory.js:33:10), <anonymous>:16:1)
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/enhanced-resolve/lib/Resolver.js:435:5
    at eval (eval at create (/Users/timwhite/Documents/GitHub/Jovie/node_modules/tapable/lib/HookCodeFactory.js:33:10), <anonymous>:27:1)
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/enhanced-resolve/lib/DescriptionFilePlugin.js:87:43
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/enhanced-resolve/lib/Resolver.js:435:5
    at eval (eval at create (/Users/timwhite/Documents/GitHub/Jovie/node_modules/tapable/lib/HookCodeFactory.js:33:10), <anonymous>:16:1)
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/enhanced-resolve/lib/forEachBail.js:16:12
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/enhanced-resolve/lib/AliasPlugin.js:125:14
    at next (/Users/timwhite/Documents/GitHub/Jovie/node_modules/enhanced-resolve/lib/forEachBail.js:14:3)
    at forEachBail (/Users/timwhite/Documents/GitHub/Jovie/node_modules/enhanced-resolve/lib/forEachBail.js:24:9)
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/enhanced-resolve/lib/AliasPlugin.js:51:5
    at _next0 (eval at create (/Users/timwhite/Documents/GitHub/Jovie/node_modules/tapable/lib/HookCodeFactory.js:33:10), <anonymous>:8:1)
    at eval (eval at create (/Users/timwhite/Documents/GitHub/Jovie/node_modules/tapable/lib/HookCodeFactory.js:33:10), <anonymous>:30:1)
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/enhanced-resolve/lib/Resolver.js:435:5
    at eval (eval at create (/Users/timwhite/Documents/GitHub/Jovie/node_modules/tapable/lib/HookCodeFactory.js:33:10), <anonymous>:16:1)
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/enhanced-resolve/lib/Resolver.js:435:5
    at eval (eval at create (/Users/timwhite/Documents/GitHub/Jovie/node_modules/tapable/lib/HookCodeFactory.js:33:10), <anonymous>:16:1)
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/enhanced-resolve/lib/Resolver.js:435:5
    at eval (eval at create (/Users/timwhite/Documents/GitHub/Jovie/node_modules/tapable/lib/HookCodeFactory.js:33:10), <anonymous>:27:1)
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/enhanced-resolve/lib/DescriptionFilePlugin.js:87:43
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/enhanced-resolve/lib/Resolver.js:435:5
    at eval (eval at create (/Users/timwhite/Documents/GitHub/Jovie/node_modules/tapable/lib/HookCodeFactory.js:33:10), <anonymous>:16:1)
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/enhanced-resolve/lib/Resolver.js:435:5
    at eval (eval at create (/Users/timwhite/Documents/GitHub/Jovie/node_modules/tapable/lib/HookCodeFactory.js:33:10), <anonymous>:15:1)
    at /Users/timwhite/Documents/GitHub/Jovie/node_modules/enhanced-resolve/lib/DirectoryExistsPlugin.js:41:15
    at processTicksAndRejections (node:internal/process/task_queues:82:21)
resolve 'tailwind/tailwind.css' in '/Users/timwhite/Documents/GitHub/Jovie/.storybook'
  Parsed request is a module
  using description file: /Users/timwhite/Documents/GitHub/Jovie/package.json (relative path: ./.storybook)
    Field 'browser' doesn't contain a valid alias configuration
    resolve as module
      /Users/timwhite/Documents/GitHub/Jovie/.storybook/node_modules doesn't exist or is not a directory
      looking for modules in /Users/timwhite/Documents/GitHub/Jovie/node_modules
        /Users/timwhite/Documents/GitHub/Jovie/node_modules/tailwind doesn't exist
      /Users/timwhite/Documents/GitHub/node_modules doesn't exist or is not a directory
      /Users/timwhite/Documents/node_modules doesn't exist or is not a directory
      /Users/timwhite/node_modules doesn't exist or is not a directory
      /Users/node_modules doesn't exist or is not a directory
      /node_modules doesn't exist or is not a directory

WARN Broken build, fix the error above.
WARN You may need to refresh the browser.

info => Loading presets
39% building 8/15 entries 20/33 dependencies 737/18 modules%     
timwhite@tims-mbp Jovie % 


It seems that the issue is that the webpack configuration in your project is unable to find the 'tailwind/tailwind.css' file. This is likely because the path to the file is incorrect or the file itself is missing. You will need to check that the path to the file is correct and that the file exists in the specified location. Also make sure that you have imported the tailwind.css file in your main.js file. It may also be helpful to check your webpack config to ensure that it is set up to handle CSS imports correctly.



const path = require('path');

module.exports = {
  stories: ['../src/**/*.stories.mdx', '../src/**/*.stories.@(js|jsx|ts|tsx)'],
  addons: [
    '@storybook/addon-links',
    '@storybook/addon-essentials',
    '@storybook/addon-interactions',
    /* {
      name: "@storybook/addon-postcss",
      options: {
        postcssLoaderOptions: {
          implementation: require("postcss"),
        },
      },
    }, */
  ],
  framework: '@storybook/vue3',
  core: {
    builder: '@storybook/builder-webpack5',
  },
  webpackFinal: async (config) => {
    config.module.rules.push({
      test: /\.css$/,
      use: ['style-loader', 'css-loader', 'postcss-loader'],
      include: path.resolve(__dirname, '../'),
    });
    return config;
  },
};



This is a configuration file for Storybook, a tool for developing and testing UI components in isolation. 

- The `stories` property specifies the location of the component stories, which are used to create documentation and examples of the components.
- The `addons` property lists the addons that are installed and enabled for the project, such as `@storybook/addon-links` and `@storybook/addon-essentials`.
- The `framework` property specifies that the project is using Vue 3 as the framework.
- The `core` property is used to configure various core settings for Storybook. In this case, the `builder` property is set to `@storybook/builder-webpack5`.
- The `webpackFinal` property allows to make changes to the webpack config before it is used by Storybook. In this case, it's adding a rule to handle css files, and include them in the resolve path.




(1:1) /Users/timwhite/Documents/GitHub/Jovie/.storybook/tailwind.css Unknown word

> 1 | import api from "!../node_modules/style-loader/dist/runtime/injectStylesIntoStyleTag.js";
    | ^
  2 |             import content from "!!../node_modules/css-loader/dist/cjs.js!../node_modules/postcss-loader/dist/cjs.js!./tailwind.css";
  3 | 


This error message is indicating that the tailwind.css file is not being found or imported correctly in your storybook configuration. The import statement for the tailwind.css file is not pointing to the correct location. You can try to update the path in the import statement to the correct location of your tailwind.css file, then it will work fine. 
It looks like you might be trying to import tailwind.css from a location outside the storybook folder.
You can also check the location of the tailwind.css file in your project if it is correct or not.



**Topic:** [[chatgpt-clusters/coding_web_dev]]
