---
title: "Health Data Tracker App"
type: guide
created: 2024-01-07
updated: 2024-01-07
source: chatgpt-export
conversation_id: 0eb9d000-8492-470c-b509-91425a339d63
message_count: 6
tags: [chatgpt, import, code, long-form]
---
# Health Data Tracker App

> Conversation ID: 0eb9d000-8492-470c-b509-91425a339d63
> Created: 2024-01-07T06:48:33Z
> Updated: 2024-01-07T06:51:34Z
> Messages: 6

---

## User

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
          .dark, //Always use the dark mode (if available) regardless of system preference.
      darkTheme: ThemeData(
        brightness: Brightness.dark,
        scaffoldBackgroundColor: Colors.black, // Set background color to black
      ),
      home: const MyHomePage(title: 'Superhero Mode'),
    );
  }
}

class MyHomePage extends StatefulWidget {
  const MyHomePage({super.key, required this.title});

  final String title;

  @override
  State<MyHomePage> createState() => _MyHomePageState();
}

class _MyHomePageState extends State<MyHomePage> {
  int _selectedIndex = 0; // Add this line to track the selected index
  int _stepCount = 0;
  double _latestWeight = 0.0;
  double _height = 0.0;
  double _bodyFatPercentage = 0.0; // Add this line

  int _age = 0; // Placeholder for age

  int _calculateAge(DateTime birthday) {
    final currentDate = DateTime.now();
    int age = currentDate.year - birthday.year;
    if (birthday.month > currentDate.month ||
        (birthday.month == currentDate.month &&
            birthday.day > currentDate.day)) {
      age--;
    }
    return age;
  }

  @override
  void initState() {
    super.initState();
    _fetchHealthData();
  }

  Future<void> _fetchHealthData() async {
    DateTime endDate = DateTime.now();
    DateTime startDate = DateTime(endDate.year, endDate.month, endDate.day);
    DateTime heightStartDate = DateTime(endDate.year - 1, endDate.month,
        endDate.day); // Fetch height data from a year ago

    HealthFactory health = HealthFactory();

    // Request authorization for steps, weight, and height
    List<HealthDataType> types = [
      HealthDataType.STEPS,
      HealthDataType.WEIGHT,
      HealthDataType.HEIGHT,
      HealthDataType.BODY_FAT_PERCENTAGE // Ensure this is included
    ];
    bool accessGranted = await health.requestAuthorization(types);

    if (accessGranted) {
      try {
        // Fetch steps
        List<HealthDataPoint> stepData = await health
            .getHealthDataFromTypes(startDate, endDate, [HealthDataType.STEPS]);
        int steps = stepData.fold<int>(0, (sum, item) {
          if (item.value is NumericHealthValue) {
            NumericHealthValue numericValue = item.value as NumericHealthValue;
            return sum + numericValue.numericValue.toInt();
          } else {
            print("Unexpected value type for steps: ${item.value.runtimeType}");
            return sum;
          }
        });

        // Fetch the most recent weight entry
        List<HealthDataPoint> weightData = await health.getHealthDataFromTypes(
            startDate, endDate, [HealthDataType.WEIGHT]);
        double latestWeight = weightData.isNotEmpty
            ? ((weightData.last.value as NumericHealthValue)
                .numericValue
                .toDouble())
            : 0.0;

        // Fetch the most recent body fat percentage entry
        List<HealthDataPoint> bodyFatData = await health.getHealthDataFromTypes(
            startDate, endDate, [HealthDataType.BODY_FAT_PERCENTAGE]);
        double latestBodyFatPercentage = bodyFatData.isNotEmpty
            ? ((bodyFatData.last.value as NumericHealthValue)
                    .numericValue
                    .toDouble() *
                100) // Multiply by 100
            : 0.0;

        // Fetch the most recent height entry over a longer time span
        List<HealthDataPoint> heightData = await health.getHealthDataFromTypes(
            heightStartDate, endDate, [HealthDataType.HEIGHT]);
        double latestHeight = heightData.isNotEmpty
            ? ((heightData.last.value as NumericHealthValue)
                .numericValue
                .toDouble())
            : 0.0;

        // TODO: Fetch and calculate age based on the date of birth

        setState(() {
          _stepCount = steps;
          _latestWeight = latestWeight;
          _height = latestHeight; // Update height
          _bodyFatPercentage = latestBodyFatPercentage; // Add this line

          // Update age state as well (once age calculation is implemented)
        });
      } catch (error) {
        print("An error occurred fetching health data: $error");
      }
    } else {
      print("Health data access not granted");
    }
  }

  @override
  Widget build(BuildContext context) {
    final user = Provider.of<UserModel>(context);
    bool isMetric = user.isMetric;
    double ffmi = user.calculateFFMI();

    return Scaffold(
      appBar: AppBar(
        backgroundColor: Colors.black,
        title: Align(
          alignment: Alignment.centerLeft,
          child: Text(
            widget.title,
            style: TextStyle(
              fontWeight: FontWeight.bold,
              fontSize: 24,
              color: Colors.white,
            ),
          ),
        ),
        actions: <Widget>[
          IconButton(
            icon: Icon(Icons.settings),
            onPressed: () {
              Navigator.push(
                context,
                MaterialPageRoute(builder: (context) => SettingsPage()),
              );
            },
          ),
        ],
      ),
      body: RefreshIndicator(
        color: Colors.grey,
        onRefresh: _fetchHealthData,
        child: GridView.count(
          crossAxisCount: 2, // Adjust the number of columns
          childAspectRatio: 1.3, // Adjust the aspect ratio
          children: <Widget>[
            _featuredStatCard(
                'FFMI', ffmi, Colors.blue, context), // Add this line
            _dataDisplayCard(
                'Steps', _stepCount.toDouble(), Colors.blue, context),
            _dataDisplayCard('Weight', _latestWeight, Colors.green, context),
            _dataDisplayCard('Height', _height, Colors.purple, context),
            _dataDisplayCard('Age', _calculateAge(user.birthday).toDouble(),
                Colors.orange, context),
            _dataDisplayCard(
                'Body Fat', _bodyFatPercentage, Colors.red, context)
          ],
        ),
      ),
      bottomNavigationBar: BottomNavigationBar(
        backgroundColor: Colors.black,
        items: const <BottomNavigationBarItem>[
          BottomNavigationBarItem(
            icon: Icon(Icons.home),
            label: 'Home',
          ),
          BottomNavigationBarItem(
            icon: Icon(Icons.settings),
            label: 'Settings',
          ),
        ],
        currentIndex: _selectedIndex,
        onTap: _onItemTapped,
      ),
    );
  }

  void updateHeight(double newHeight) {
    setState(() {
      _height = newHeight;
    });
  }

  void _onItemTapped(int index) {
    setState(() {
      _selectedIndex = index;
      // Add your navigation logic here
    });
  }

  Widget _dataDisplayCard(
      String label, double value, Color color, BuildContext context) {
    String displayValue;

    if (label == 'Steps') {
      displayValue = formatLargeNumber(value);
    } else {
      displayValue = _getFormattedValue(label, value, context);
    }

    return Card(
      color: Colors.grey[950],
      margin: EdgeInsets.all(8.0),
      child: Container(
        padding: EdgeInsets.all(16.0),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          crossAxisAlignment: CrossAxisAlignment.start, // Add this line

          children: <Widget>[
            Text(
              label,
              style: TextStyle(
                  fontSize: 14,
                  fontWeight: FontWeight.normal,
                  color: Colors.grey[400]),
            ),
            SizedBox(height: 8.0),
            Text(
              displayValue,
              style: TextStyle(
                  fontSize: 32,
                  color: Colors.white,
                  fontWeight: FontWeight.bold),
            ),
          ],
        ),
      ),
    );
  }

  Widget _featuredStatCard(
      String label, double value, Color color, BuildContext context) {
    String displayValue = _getFormattedValue(label, value, context);

    return Card(
      margin: EdgeInsets.all(8.0),
      child: Container(
        padding: EdgeInsets.all(16.0),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start, // Add this line

          mainAxisAlignment: MainAxisAlignment.center,
          children: <Widget>[
            Text(
              label,
              style: TextStyle(
                  fontSize: 16,
                  fontWeight: FontWeight.bold,
                  color: Colors.white),
            ),
            SizedBox(height: 8.0),
            Text(
              displayValue,
              style: TextStyle(
                  fontSize: 48,
                  color: Colors.white,
                  fontWeight: FontWeight.bold),
            ),
          ],
        ),
      ),
    );
  }

  String _getFormattedValue(String label, double value, BuildContext context) {
    final isMetric = Provider.of<UserModel>(context, listen: false).isMetric;

    switch (label) {
      case 'Weight':
        return isMetric
            ? '${value.toStringAsFixed(2)} kg'
            : '${(value * 2.20462).toStringAsFixed(2)} lbs';
      case 'Height':
        return isMetric
            ? '${value.toStringAsFixed(2)} m'
            : '${(value * 3.28084).toStringAsFixed(2)} ft';
      case 'Body Fat':
        return '${value.toStringAsFixed(2)}%';
      case 'Age': // Add this case for 'Age'
        return value.round().toString();
      default:
        return value.toStringAsFixed(2);
    }
  }

// ... Rest of your code
}

class SettingsPage extends StatefulWidget {
  @override
  _SettingsPageState createState() => _SettingsPageState();
}

class _SettingsPageState extends State<SettingsPage> {
  DateTime? _birthday;

  Future<void> _selectDate(BuildContext context) async {
    final DateTime? picked = await showDatePicker(
      context: context,
      initialDate: _birthday ?? DateTime.now(),
      firstDate: DateTime(1900),
      lastDate: DateTime.now(),
    );
    if (picked != null && picked != _birthday) {
      setState(() {
        _birthday = picked;
      });
      // Update the birthday in the UserModel
      Provider.of<UserModel>(context, listen: false).updateBirthday(picked);
    }
  }

  @override
  Widget build(BuildContext context) {
    // Fetch the user model using Provider
    final user = Provider.of<UserModel>(context);
    return Scaffold(
      appBar: AppBar(
        title: Text('Settings'),
      ),
      body: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: <Widget>[
            Text('Birthday: ${_birthday?.toIso8601String() ?? "Not set"}'),
            ElevatedButton(
              onPressed: () => _selectDate(context),
              child: Text('Select your birthday'),
            ),
            SwitchListTile(
              title: Text('Use metric units'),
              value: user.isMetric,
              onChanged: (bool value) {
                user.toggleUnitPreference();
              },
            ),
          ],
        ),
      ),
    );
  }
}

class UserModel extends ChangeNotifier {
  DateTime? birthday;
  double? weight;
  double? height;
  double? bodyFatPercentage;
  double calculateFFMI() {
    if (weight == null || bodyFatPercentage == null || height == null) {
      return 0.0; // Return a default value if any of the properties is null
    }

    double leanBodyMass = weight! * (1 - (bodyFatPercentage! / 100));
    double heightInMeters = isMetric ? height! : height! * 0.3048;
    return (leanBodyMass / (heightInMeters * heightInMeters)) +
        6.1 * (1.8 - heightInMeters);
  }

  bool isMetric = true; // Add this line

  void updateBirthday(DateTime newBirthday) {
    birthday = newBirthday;
    notifyListeners();
  }

  void updateWeight(double newWeight) {
    weight = newWeight;
    notifyListeners();
  }

  void updateHeight(double newHeight) {
    height = newHeight;
    notifyListeners();
  }

  void updateBodyFatPercentage(double newBodyFatPercentage) {
    bodyFatPercentage = newBodyFatPercentage;
    notifyListeners();
  }

  void toggleUnitPreference() {
    // Add this method
    isMetric = !isMetric;
    notifyListeners();
  }
}


---

## Assistant

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

---

## User


lib/main.dart:206:56: Error: The argument type 'DateTime?' can't be assigned to the parameter type 'DateTime' because 'DateTime?' is
nullable and 'DateTime' isn't.
 - 'DateTime' is from 'dart:core'.
            _dataDisplayCard('Age', _calculateAge(user.birthday).toDouble(),
                                                       ^
Performing hot reload...                                                
Try again after fixing the above error(s).


---

## Assistant

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

---

## User

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


---

## Assistant

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


**Topic:** [[chatgpt-clusters/jovie_music]]
