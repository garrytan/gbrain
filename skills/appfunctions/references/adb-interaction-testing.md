Provides commands to interact with AppFunctions on a connected device or
emulator using ADB for AppFunction testing and debugging.

## Instructions

### Scenario 1: Listing App Functions

If a user wants to see which App Functions are registered on the device.

1. **List All Functions** : Use `adb shell cmd app_function list-app-functions` to see all registered App Functions for the current user in JSON format.
2. **Filter by Package** : To see functions for a specific package, pipe the output to grep or a JSON processor: `adb shell cmd app_function
   list-app-functions | grep <package_name>`.

### Scenario 2: Invoking App Functions

If a user wants to test the execution of an App Function.

1. **Analyze Description** : Before invoking, you MUST read the `description` field for the function in the `list-app-functions` output. This often contains critical usage constraints, required workflows, or disambiguation rules.
2. **Follow Constraints**: Rigorously follow any instructions found in the description (e.g., "ask the user to disambiguate", "call another tool first").
3. **Format Parameters** : The `--parameters` argument must be a valid JSON string representing the function's input arguments.
4. **Execute Function** : Use `adb shell cmd app_function execute-app-function
   --package <PACKAGE_NAME> --function <FUNCTION_ID> --parameters
   '<PARAMETERS_JSON>'`.
5. **Handle Response** : The result will be returned as a JSON string. Use `--brief-yaml` for a more concise output if preferred.

### Scenario 3: Managing Function State

If a function needs to be enabled or disabled for testing.

1. **Set Enabled State** : Use `adb shell cmd app_function set-enabled --package
   <PACKAGE_NAME> --function <FUNCTION_ID> --state <enable|disable|default>`.

## Critical Constraints

### Follow Metadata Descriptions

**MANDATORY** : The `description` field in the AppFunction metadata is a set of
instructions for the LLM. If a description says to "disambiguate with the user"
or "call another function first," you MUST perform those steps before execution.

### JSON Escaping

**CRITICAL** : When passing JSON using `adb shell`, always wrap the JSON string
in single quotes to prevent the shell from interpreting special characters or
spaces. Example: `--parameters '{"key": "value"}'`.

### Device Availability

The `app_function` service must be available on the device. If `cmd: Can't find
service: app_function` is returned, the device does not support this feature.

## Examples

### Example 1: Verify AppFunctions service availability on connected Device

    adb shell cmd app_function help

If executing the preceding command returns a help page, use the commands and
parameters provided to guide the ADB interaction testing tool interactions.

### Example 2: List all registered App Functions

    adb shell cmd app_function list-app-functions

### Example 3: Execute a "send message" function

    adb shell cmd app_function execute-app-function \
      --package com.example.messaging --function sendMessage \
      --parameters '{"recipient": "Alice", "message": "Hello!"}'

### Example 4: Disable a specific function

    adb shell cmd app_function set-enabled --package com.example.app \
      --function someFunction --state disable

## Troubleshooting

### Error: "Unknown command"

**Cause**: You are likely using an older version of the instructions.

**Solution**: Look up supported commands using "Example 1".

### Error: "Function not found"

**Cause**: The function ID or package name is incorrect.

**Solution** : Run `list-app-functions` and search for the relevant identifiers
in the JSON output.