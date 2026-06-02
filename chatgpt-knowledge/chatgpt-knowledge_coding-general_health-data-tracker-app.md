---
title: "Health Data Tracker App"
type: guide
created: 2024-01-07
updated: 2024-01-07
source: chatgpt-export
topic: coding-general
message_count: 6
tags: [chatgpt, knowledge, coding-general]
---
**Topic:** [[chatgpt-knowledge/_topics/coding-general]]

# Health Data Tracker App

> **Source:** ChatGPT conversation
> **Date:** 2024-01-07T06:48:33Z
> **Messages:** 6
> **Topic:** coding-general

## Question

import 'package:flutter/material.dart';
import 'package:health/health.dart';
import 'package:provider/provider.dart';

void main() {
  runApp(
    ChangeNotifierProvider(
      create: (context) => UserModel(),
      child: MyApp(),
    ),
  );
}

String formatLargeNumber(double number) {
  if (number >= 1000000000) {
    return '${(number / 1000000000).toStringAsFixed(1)}b';
  } else if (number >= 1000000) {
    return '${(number / 1000000).toStringAsFixed(1)}m';
  } else if (number >= 1000) {
    return '${(number / 1000).toStringAsFixed(1)}k';
  } else {
    return number.toStringAsFixed(1);
  }
}

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Superhero Mode',
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: Colors.blue),
        useMaterial3: true,
      ),
      themeMode: ThemeMode
          .dark, //Always use the dark mode (if available) rega

## Answer

This Flutter application appears to be a health and fitness tracker. It integrates with the Health package to fetch user health data like steps, weight, height, and body fat percentage. The app uses a `ChangeNotifierProvider` to manage state across widgets. Here are some insights about the code and suggestions for improvement:

1. **Health Data Access**: The app requests authorization for health data and then fetches steps, weight, height, and body fat percentage. It's good practice to handle scenarios where users deny permission or when data is not available.

2. **Data Formatting**: The `formatLargeNumber` function is used to format large numbers in a readable format. This is useful for displaying data like step counts.

3. **UI Components**: The app uses `GridView` to display health data in a card layout. This makes the information accessible and visually appealing.

4. **Age Calculation**: The `_calculateAge` function computes the user's age based on their birthday. Ensure that the user's birthday is obtained and stored securely.

5. **FFMI Calculation**: The `calculateFFMI` function in `UserModel` calculates the Fat-Free Mass Index. It's important to validate the input data to avoid incorrect calculations.

6. **Metric and Imperial Units**: The app allows users to toggle between metric and imperial units, which is a user-friendly feature for a global audience.

7. **Settings Page**: Users can set their birthday and toggle unit preferences. Consider adding more user-customizable settings like goals or reminders.

8. **Error Handling**: It's crucial to add error handling, especially when dealing with health data and external packages. Ensure the app handles exceptions gracefully.

9. **UI/UX Enhancements**: Consider adding more interactive elements like charts or graphs for better data visualization. Also, ensure the app is responsive and accessible.

10. **Testing and Performance**: Make sure to thoroughly test the app, especially the health data fetching and calculations. Consider performance optimization for a smoother user experience.

11. **Privacy and Security**: Since the app deals with sensitive health data, ensure compliance with privacy laws and implement robust security measures.

Overall, the code is well-structured and follows Flutter's best practices. It's important to focus on user privacy, error handling, and UI/UX enhancements for a better user experience.

## Question


lib/main.dart:206:56: Error: The argument type 'DateTime?' can't be assigned to the parameter type 'DateTime' because 'DateTime?' is
nullable and 'DateTime' isn't.
 - 'DateTime' is from 'dart:core'.
            _dataDisplayCard('Age', _calculateAge(user.birthday).toDouble(),
                                                       ^
Performing hot reload...                                                
Try again after fixing the above error(s).


## Answer

The error you're encountering is due to the nullable nature of the `user.birthday` property. In Dart, a variable that can be `null` is marked as nullable by adding a `?` after the type. However, your `_calculateAge` function expects a non-nullable `DateTime` object, which is causing the type mismatch.

To fix this issue, you need to handle the case where `user.birthday` might be `null`. Here's how you can modify your `_dataDisplayCard` call to handle this:

```dart
_dataDisplayCard(
    'Age', 
    user.birthday != null ? _calculateAge(user.birthday!).toDouble() : 0.0,
    Colors.orange, 
    context
),
```

In this modification:

- `user.birthday != null` checks if `user.birthday` is not null.
- If `user.birthday` is not null, `_calculateAge(user.birthday!)` is called. The `!` operator is used to assert that `user.birthday` is not null.
- If `user.birthday` is null, `0.0` is used as a default value. You may choose to handle this differently, perhaps by displaying a placeholder or a message indicating that the birthday is not set.

This change should resolve the error and allow your app to compile and run successfully.

## Question

of 1045 libraries in 198ms (compile: 25 ms, reload: 98 ms, reassemble: 36 ms).

lib/main.dart:428:5: Error: The method 'setState' isn't defined for the class 'UserModel'.
 - 'UserModel' is from 'package:superheromobile/main.dart' ('lib/main.dart').
Try correcting the name to the name of an existing method, or defining a method named 'setState'.
    setState(() {
    ^^^^^^^^
lib/main.dart:429:7: Error: The setter 'ffmi' isn't defined for the class 'UserModel'.
 - 'UserModel' is from 'package:superheromobile/main.dart' ('lib/main.dart').
Try correcting the name to the name of an existing setter, or defining a setter or field named 'ffmi'.
      ffmi = newFFMI;
      ^^^^
Performing hot reload...                                                
Try again after fixing the above error(s).


## Answer

The error messages indicate two issues in your `UserModel` class within `lib/main.dart`:

1. **Use of `setState` in a Non-Widget Class**: The `setState` method is used to update the UI and trigger a rebuild in Flutter's stateful widgets. However, `UserModel` is not a widget; it's a model class. In Flutter, you should use `notifyListeners` to notify listeners in a `ChangeNotifier` class when the model changes. This is what triggers a rebuild of the widgets that depend on this model.

2. **Undefined `ffmi` Setter in `UserModel`**: The second error is about trying to set a value to `ffmi` in `UserModel`, but `ffmi` does not have a setter defined. If you intend to calculate `ffmi` and store it in the model, you should first declare it as a variable in your `UserModel` class and then create a setter for it.

Here is how you can address these issues:

### Fixing the `setState` Issue:

Replace `setState` with `notifyListeners` in the `UserModel` class. For example:

```dart
void updateWeight(double newWeight) {
  weight = newWeight;
  notifyListeners(); // instead of setState
}
```

### Fixing the `ffmi` Setter Issue:

First, declare `ffmi` in the `UserModel` class:

```dart
class UserModel extends ChangeNotifier {
  // ... other properties

  double _ffmi; // private variable for ffmi

  double get ffmi => _ffmi; // getter for ffmi

  set ffmi(double newValue) { // setter for ffmi
    _ffmi = newValue;
    notifyListeners();
  }

  // ... rest of the class
}
```

Then, use this setter to update `ffmi`:

```dart
user.ffmi = newFFMI; // this will automatically call notifyListeners
```

Make these changes to your code, and it should resolve the compilation errors. Remember, in Flutter, `ChangeNotifierProvider` and `notifyListeners` are used for state management in non-widget classes, while `setState` is specifically for stateful widgets.
