---
title: "Age Display Issue Fixed"
type: guide
created: 2024-01-07
updated: 2024-01-07
source: chatgpt-export
conversation_id: 511830f9-385c-4ab4-926f-9ac11b8c2247
message_count: 4
tags: [chatgpt, import, code, long-form]
---
# Age Display Issue Fixed

> Conversation ID: 511830f9-385c-4ab4-926f-9ac11b8c2247
> Created: 2024-01-07T07:02:00Z
> Updated: 2024-01-07T07:03:13Z
> Messages: 4

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
            _dataDisplayCard(
                'Age',
                user.birthday != null
                    ? _calculateAge(user.birthday!).toDouble()
                    : 0.0,
                Colors.orange,
                context),

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
        if (isMetric) {
          return '${value.toStringAsFixed(2)} m';
        } else {
          value = value * 3.281; // Convert meters to feet
          int feet = value.floor();
          double inches = (value - feet) * 12;
          return '${feet}\' ${inches.toStringAsFixed(0)}"';
        }
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


age is not displaying

---

## Assistant

In the provided code, the age is intended to be displayed in the `_dataDisplayCard` widget within the `MyHomePage` class. However, it seems like the age calculation isn't integrated properly into the widget. To fix this, you need to ensure that the age is calculated and updated correctly.

Here are a few steps to troubleshoot and fix the issue:

1. **Ensure Age Calculation is Triggered**: Verify that the `_calculateAge` method is called and returns the correct age. This method should be called whenever the user's birthday is updated.

2. **Update Age in State**: In the `_fetchHealthData` method, there's a comment `// TODO: Fetch and calculate age based on the date of birth`. Make sure you implement this part. After fetching the user's date of birth, call `_calculateAge` and update the `_age` state with the result.

3. **Display Age Correctly**: In the `GridView.count` within the `build` method of `_MyHomePageState`, there's a `_dataDisplayCard` for 'Age'. Ensure that it is displaying the `_age` variable. It should look something like this:

   ```dart
   _dataDisplayCard(
       'Age',
       _age.toDouble(),
       Colors.orange,
       context),
   ```

4. **Update UserModel**: In the `UserModel` class, make sure there's a method to update the user's birthday, and it should call `notifyListeners()` to update the UI accordingly.

5. **Settings Page Interaction**: In the `SettingsPage`, ensure that when a new birthday is selected, it updates the `UserModel` with the new birthday, which should in turn update the age displayed in `MyHomePage`.

By following these steps, you should be able to display the age correctly in your app. Remember to test each part of the code to ensure that the age calculation and display are functioning as expected.

---

## User

show me how to do 5

---

## Assistant

To implement step 5, where you update the user's birthday from the `SettingsPage` and reflect the changes in the `UserModel`, follow these steps:

1. **Implement the Birthday Update Method in `UserModel`**:
   First, ensure that there is a method in your `UserModel` class to update the birthday. This method should call `notifyListeners()` to notify all listeners (like `MyHomePage`) of the change.

   ```dart
   class UserModel extends ChangeNotifier {
       DateTime? birthday;

       // ... other properties and methods ...

       void updateBirthday(DateTime newBirthday) {
           birthday = newBirthday;
           notifyListeners();
       }
   }
   ```

2. **Invoke `updateBirthday` in `SettingsPage`**:
   In the `_SettingsPageState` class of `SettingsPage`, make sure to invoke the `updateBirthday` method of `UserModel` when a new date is picked. The `Provider.of<UserModel>(context, listen: false)` is used to access the `UserModel` instance.

   ```dart
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

       // ... rest of your code ...
   }
   ```

3. **Reflect Changes in `MyHomePage`**:
   Since `MyHomePage` uses the `UserModel`, it should automatically update when the `UserModel` notifies its listeners. Ensure that the age calculation and display are tied to the user's birthday from the `UserModel`. The `_calculateAge` method should use the birthday from `UserModel`.

   Update the `build` method in `_MyHomePageState` to use the age from the `UserModel`:

   ```dart
   @override
   Widget build(BuildContext context) {
       final user = Provider.of<UserModel>(context);
       double age = user.birthday != null ? _calculateAge(user.birthday!).toDouble() : 0.0;

       // ... rest of your build method ...
   }
   ```

With these changes, when you select a new birthday in the `SettingsPage`, it should update the `UserModel`, which in turn updates the display in `MyHomePage`. Remember to test the functionality to ensure that the age is correctly updated across the app.
