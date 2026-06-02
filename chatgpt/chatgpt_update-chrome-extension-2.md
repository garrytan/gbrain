---
title: "Update Chrome Extension."
type: guide
created: 2023-02-17
updated: 2023-02-17
source: chatgpt-export
conversation_id: 2393e231-97a8-4f00-af04-94af77d48973
message_count: 15
tags: [chatgpt, import, code, long-form]
---
# Update Chrome Extension.

> Conversation ID: 2393e231-97a8-4f00-af04-94af77d48973
> Created: 2023-02-17T05:09:47Z
> Updated: 2023-02-17T05:09:47Z
> Messages: 15

---

## User

name: Update Chrome Extension

on:
  push:
    tags:
      - v*.*.*
      
      jobs:
  build-chrome-extension:
    name: Build Chrome extension artifact
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v2

      - name: Build
        run: |-
          # fill in your build steps here...
          # we archive the dist folder and include SHA commit as the last step
          zip -r chrome-extension-${{ github.event.pull_request.head.sha }}.zip dist

      - name: Archive chrome-extension artifact
        uses: actions/upload-artifact@v2
        with:
          name: chrome-extension-${{ github.sha }}
          path: chrome-extension-${{ github.event.pull_request.head.sha }}.zip

walk me through setting up the above github action for my chrome extension

---

## Assistant

Sure, here's how you can set up the GitHub action for your Chrome extension:

1. Create a file named `.github/workflows/build.yml` in the root of your project directory.
2. Copy and paste the following code into the file:

```
name: Update Chrome Extension

on:
  push:
    tags:
      - v*.*.*

jobs:
  build-chrome-extension:
    name: Build Chrome extension artifact
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v2

      - name: Build
        run: |-
          # fill in your build steps here...
          # we archive the dist folder and include SHA commit as the last step
          zip -r chrome-extension-${{ github.event.pull_request.head.sha }}.zip dist

      - name: Archive chrome-extension artifact
        uses: actions/upload-artifact@v2
        with:
          name: chrome-extension-${{ github.sha }}
          path: chrome-extension-${{ github.event.pull_request.head.sha }}.zip
```

Let's walk through each part of this file:

- The `name` field is a description of the GitHub Action.
- The `on` field specifies when the action should run. In this case, it will run whenever a push is made with a tag in the format "v*.*.*".
- The `jobs` field contains a single job named `build-chrome-extension`, which will run on an Ubuntu environment.
- The `steps` field contains a series of steps to perform in the job.
- The first step checks out your code using the `actions/checkout@v2` action.
- The second step runs the build steps for your extension. You'll need to fill in the appropriate commands for your extension's build process. In this example, it creates a ZIP archive of the `dist` folder with the name `chrome-extension-{commit-sha}.zip`.
- The third step archives the built extension as an artifact using the `actions/upload-artifact@v2` action. The name of the artifact will be `chrome-extension-{commit-sha}.zip`.

3. Customize the build step to match your extension's build process. If your extension doesn't have a `dist` folder, replace it with the appropriate folder name.
4. Save the file and commit it to your repository.
5. Create a new tag in the format "v*.*.*" to trigger the action. For example, you could create a tag named "v1.0.0" using the command `git tag v1.0.0`.
6. Push the tag to your repository using the command `git push origin v1.0.0`. This will trigger the action to build your extension and create an artifact.
7. You can download the artifact by navigating to the "Actions" tab in your repository, finding the appropriate build, and clicking on the artifact name.

---

## User

my build step is npm run prod. Can you add this?

---

## Assistant

Sure! Here's an updated version of the GitHub Action with the `npm run prod` build step:

```
name: Update Chrome Extension

on:
  push:
    tags:
      - v*.*.*

jobs:
  build-chrome-extension:
    name: Build Chrome extension artifact
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v2

      - name: Install dependencies
        run: npm install

      - name: Build
        run: npm run prod

      - name: Archive chrome-extension artifact
        uses: actions/upload-artifact@v2
        with:
          name: chrome-extension-${{ github.sha }}
          path: dist
```

Here's what's changed:

- We added a step to install dependencies using the `npm install` command. Make sure to have a `package.json` file with the appropriate dependencies for your extension.
- The `Build` step now uses the `npm run prod` command to run the build process for your extension. Make sure that this command is defined in your `package.json` file and runs the necessary build steps for your extension.
- We changed the `path` field of the `actions/upload-artifact@v2` action to `dist`, assuming that your `npm run prod` command outputs the built extension files to a `dist` folder.

With these changes, the GitHub Action should now be able to build your Chrome extension using the `npm run prod` command and archive the resulting files as an artifact.

---

## User

ok ive made the file. now i need to tag a commit and push it.. show me the steps

---

## Assistant

1. Open a terminal or command prompt in your project directory.
2. Make sure you have committed all your changes to the repository using the `git add .` and `git commit -m "commit message"` commands.
3. Run the following command to create a new tag: `git tag -a v1.0.0 -m "version 1.0.0"`. Replace "v1.0.0" with the version number you want to use for the tag, and "version 1.0.0" with a description of the version.
4. Push the tag to the remote repository using the command `git push origin v1.0.0`. Replace "v1.0.0" with the tag name you just created.

These commands will create a new tag for your repository, and push it to the remote repository on GitHub. This will trigger the GitHub Action you created earlier, which will build your Chrome extension and archive the built files as an artifact. You can check the status of the action in the "Actions" tab of your repository on GitHub.

---

## User

use version 0.1.0

---

## Assistant

Sure, you can use version `0.1.0` instead of `1.0.0`. Here are the updated commands:

1. Open a terminal or command prompt in your project directory.
2. Make sure you have committed all your changes to the repository using the `git add .` and `git commit -m "commit message"` commands.
3. Run the following command to create a new tag: `git tag -a v0.1.0 -m "version 0.1.0"`.
4. Push the tag to the remote repository using the command `git push origin v0.1.0`.

These commands will create a new tag for your repository with the version number `0.1.0`, and push it to the remote repository on GitHub. This will trigger the GitHub Action you created earlier, which will build your Chrome extension and archive the built files as an artifact. You can check the status of the action in the "Actions" tab of your repository on GitHub.

---

## User

my brain is called main. should the push command still be git push origin v0.1.0

---

## Assistant

Good catch! If your repository's default branch is named `main`, then you should use the following command instead:

```
git push origin v0.1.0 main
```

This will push the `v0.1.0` tag to the `main` branch on the remote repository. 

You can also set `main` as the default branch for your repository on GitHub by going to your repository's settings and selecting `main` as the default branch. This will make `main` the default branch for all git commands, so you won't need to specify it in the `git push` command.

---

## User

great, the github action ran.

However, it got an error:
Run npm run prod
  

> jovie-extension@1.0.0 prod
> npm run production

> jovie-extension@1.0.0 production
> cross-env NODE_ENV=production node_modules/webpack/bin/webpack.js  webpack --config webpack.prod.js --progress --env=production

[webpack-cli] Unknown command or entry 'webpack'
[webpack-cli] Run 'webpack --help' to see available commands and options
Error: Process completed with exit code 2.

---

## Assistant

The error message suggests that there is an issue with the `webpack` command that is being executed as part of the `npm run production` script. 

One possible reason for this error could be that `webpack` is not installed as a dev dependency in your project. To fix this, you can try running the following command in your project directory:

```
npm install --save-dev webpack webpack-cli
```

This will install `webpack` and `webpack-cli` as dev dependencies in your project.

If `webpack` is already installed, then the error could be due to a misconfiguration in your `webpack.prod.js` configuration file. Double-check your configuration file to ensure that it is correctly configured. You can also try running the `webpack` command directly in the terminal to see if it is working correctly.

---

## User

 npm install --save-dev webpack webpack-cli
>>
npm ERR! code ERESOLVE
npm ERR! ERESOLVE could not resolve
npm ERR!
npm ERR! While resolving: jovie-extension@1.0.0
npm ERR! Found: webpack@5.65.0
npm ERR! node_modules/webpack
npm ERR!   peer webpack@"4.x.x || 5.x.x" from @webpack-cli/configtest@1.1.0
npm ERR!   node_modules/@webpack-cli/configtest
npm ERR!     @webpack-cli/configtest@"^1.1.0" from webpack-cli@4.9.1
npm ERR!     node_modules/webpack-cli
npm ERR!       peer webpack-cli@"4.x.x" from @webpack-cli/configtest@1.1.0
npm ERR!       3 more (@webpack-cli/info, @webpack-cli/serve, the root project)
npm ERR!   peer webpack@"^5.0.0" from postcss-loader@6.2.1
npm ERR!   node_modules/postcss-loader
npm ERR!     dev postcss-loader@"^6.2.1" from the root project
npm ERR!   4 more (terser-webpack-plugin, webpack-cli, the root project, copy-webpack-plugin)
npm ERR!
npm ERR! Could not resolve dependency:
npm ERR! source-map-loader@"^4.0.1" from the root project
npm ERR!
npm ERR! Conflicting peer dependency: webpack@5.75.0
npm ERR! node_modules/webpack
npm ERR!   peer webpack@"^5.72.1" from source-map-loader@4.0.1
npm ERR!   node_modules/source-map-loader
npm ERR!     source-map-loader@"^4.0.1" from the root project
npm ERR!
npm ERR! Fix the upstream dependency conflict, or retry
npm ERR! this command with --force, or --legacy-peer-deps
npm ERR! to accept an incorrect (and potentially broken) dependency resolution.
npm ERR!
npm ERR! See C:\tmp\nodejs\npm-cache\eresolve-report.txt for a full report.

npm ERR! A complete log of this run can be found in:
npm ERR!     C:\tmp\nodejs\npm-cache\_logs\2023-02-17T05_20_26_084Z-debug-0.log
PS C:\Users\Tim White\Documents\GitHub\Jovie_Chrome_Extension> 

---

## Assistant

It looks like there is a dependency conflict with the `webpack` package. The error message suggests that there are conflicting peer dependencies between `webpack@5.65.0` and `source-map-loader@4.0.1`.

You can try resolving this issue by running the `npm install` command with the `--force` or `--legacy-peer-deps` flag. 

```
npm install --save-dev webpack webpack-cli --force
```

or 

```
npm install --save-dev webpack webpack-cli --legacy-peer-deps
```

These flags will allow npm to install the package despite the conflicting dependencies.

If the above solution does not work, you can try upgrading or downgrading the conflicting dependencies to resolve the conflict.

---

## User

> jovie-extension@1.0.0 build
> npm run build:tailwind && npm run prod

> jovie-extension@1.0.0 build:tailwind
> NODE_ENV=production postcss src/tailwind.css -o dist/tailwind.dist.css

'NODE_ENV' is not recognized as an internal or external command,
operable program or batch file.
PS C:\Users\Tim White\Documents\GitHub\Jovie_Chrome_Extension>


## See Also
- [[chatgpt/chatgpt_update-chrome-extension-3]]
- [[chatgpt/chatgpt_update-chrome-extension]]
- [[chatgpt/chatgpt_chrome-extension-function-location]]
- [[chatgpt/chatgpt_chrome-extension-interaction]]
- [[chatgpt/chatgpt_chrome-extension-popup-script]]
