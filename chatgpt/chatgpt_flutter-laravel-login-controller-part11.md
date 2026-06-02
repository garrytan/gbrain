
Based on the `UserModel` class you provided from the `user.dart` file, it looks like the `ProfilePage` expects an instance of `UserModel`, not `User`. The `ProfilePage` should be modified to use the `UserModel` instance to access the current user's details. 

Here's how you can modify the `ProfilePage` to correctly use the `UserModel`:

1. Update the `ProfilePage` class to accept `UserModel` and use its properties:

   ```dart
   class ProfilePage extends StatelessWidget {
     final UserModel userModel;

     ProfilePage({Key? key, required this.userModel}) : super(key: key);

     @override
     Widget build(BuildContext context) {
       return Scaffold(
         appBar: AppBar(
           title: Text('Profile'),
         ),
         body: Padding(
           padding: EdgeInsets.all(16.0),
           child: Column(
             crossAxisAlignment: CrossAxisAlignment.start,
             children: [
               Text(
                 userModel.currentUser?.name ?? 'N/A',
                 style: TextStyle(
                   fontWeight: FontWeight.bold,
                   fontSize: 24.0,
                 ),
               ),
               SizedBox(height: 16.0),
               Text('Email: ${userModel.currentUser?.email ?? 'N/A'}'),
               SizedBox(height: 8.0),
               Text('Height: ${userModel.currentUser?.height.toString() ?? 'N/A'}'),
               // Add more user details here
             ],
           ),
         ),
       );
     }
   }
   ```

2. In your `main.dart` file, ensure you're passing the `UserModel` instance to `ProfilePage`:

   ```dart
   void _onItemTapped(int index) {
     setState(() {
       _selectedIndex = index;
     });

     if (index == 2) {
       UserModel userModel = Provider.of<UserModel>(context, listen: false);
       Navigator.push(
         context,
         MaterialPageRoute(
           builder: (context) => ProfilePage(userModel: userModel),
         ),
       );
     } else if (index == 1) {
       // Other navigation logic
     }
   }
   ```

By passing the `UserModel` instance to the `ProfilePage`, you can ensure that the user's details are available for display. Make sure that the `UserModel` instance is correctly populated with the user data so that it reflects on the profile page.


here is my profile page now

import 'package:flutter/material.dart';
import 'user.dart';

class ProfilePage extends StatelessWidget {
  final UserModel userModel;

  ProfilePage({Key? key, required this.userModel}) : super(key: key);

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text('Profile'),
      ),
      body: Padding(
        padding: EdgeInsets.all(16.0),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              userModel.currentUser?.name ?? 'N/A',
              style: TextStyle(
                fontWeight: FontWeight.bold,
                fontSize: 24.0,
              ),
            ),
            SizedBox(height: 16.0),
            Text('Email: ${userModel.currentUser?.email ?? 'N/A'}'),
            SizedBox(height: 8.0),
            Text(
                'Height: ${userModel.currentUser?.height.toString() ?? 'N/A'}'),
            // Add more user details here
          ],
        ),
      ),
    );
  }
}


i still get the error


The error you are encountering seems to be related to how you're passing the `userModel` to the `ProfilePage`. To resolve this, we need to ensure that you're correctly passing the `UserModel` instance from the place where you're navigating to `ProfilePage`.

1. **Ensure `UserModel` is provided in the widget tree**: If you're using `Provider` to manage state, `UserModel` should be accessible in the widget tree where `ProfilePage` is used. 

2. **Correctly pass `UserModel` in navigation**: When navigating to `ProfilePage`, you need to pass the `UserModel` instance. Here is how you can do this in your `_onItemTapped` method:

   ```dart
   void _onItemTapped(int index) {
     setState(() {
       _selectedIndex = index;
     });

     if (index == 2) {
       // Access UserModel instance from the Provider
       UserModel userModel = Provider.of<UserModel>(context, listen: false);

       // Navigate to ProfilePage with the userModel
       Navigator.push(
         context,
         MaterialPageRoute(
           builder: (context) => ProfilePage(userModel: userModel),
         ),
       );
     } else if (index == 1) {
       // Logic for other indices
     }
   }
   ```

3. **Check for null `currentUser`**: In `ProfilePage`, you are correctly checking if `currentUser` is null. Make sure that `currentUser` is being properly set in `UserModel`.

If you continue to experience issues, please provide the exact error message you're receiving, and double-check how `UserModel` is managed and provided in your Flutter application. This will help in pinpointing the exact issue.


 padding: const EdgeInsets.,
              child: Align(
                alignment: Alignment.center,
                child: Text(
                  '7',
                  style: TextStyle(
                    fontSize: 48,
                    fontWeight: FontWeight.bold,
                    color: Colors.blue,
                  ),
                ),
              ),
            ),

fix this so its a giant number with lots of paddding


To create a large, centered number with substantial padding, you can modify your `Padding` widget and its child `Text` widget in Flutter like this:

```dart
Padding(
  padding: const EdgeInsets.all(50.0), // Adjust padding as needed
  child: Align(
    alignment: Alignment.center,
    child: Text(
      '7',
      style: TextStyle(
        fontSize: 100, // Increase font size for a larger number
        fontWeight: FontWeight.bold,
        color: Colors.blue,
      ),
    ),
  ),
),
```

In this snippet:

- `EdgeInsets.all(50.0)`: This applies uniform padding of `50.0` pixels on all sides of the `Text` widget. You can adjust the value to increase or decrease the padding.
- `fontSize: 100`: This sets the font size to `100` pixels, making the number significantly large. You can adjust this value according to your design requirements.

These changes will result in a large, bold number '7', centrally aligned, with substantial padding around it.


and then in small white bold text below the number write the word "score"


To add the word "score" in small, white, bold text below the large number, you can wrap the `Text` widgets inside a `Column` widget. This will arrange the number and the word "score" vertically. Here's how you can do it:

```dart
Padding(
  padding: const EdgeInsets.all(50.0), // Adjust padding as needed
  child: Column(
    mainAxisSize: MainAxisSize.min, // To keep the column size just enough for its children
    mainAxisAlignment: MainAxisAlignment.center, // Center the children vertically
    crossAxisAlignment: CrossAxisAlignment.center, // Center the children horizontally
    children: [
      Text(
        '7', // The large number
        style: TextStyle(
          fontSize: 100, // Large font size for the number
          fontWeight: FontWeight.bold,
          color: Colors.blue,
        ),
      ),
      Text(
        'Score', // The word "score"
        style: TextStyle(
          fontSize: 20, // Smaller font size for the word "score"
          fontWeight: FontWeight.bold,
          color: Colors.white,
        ),
      ),
    ],
  ),
),
```

In this code snippet:

- The `Column` widget is used to arrange its children (the two `Text` widgets) vertically.
- `mainAxisSize: MainAxisSize.min` ensures the column is as big as the sum of its children's sizes.
- `mainAxisAlignment` and `crossAxisAlignment` are set to center to align the `Text` widgets both vertically and horizontally within the column.
- The first `Text` widget is for the large number '7', and the second `Text` widget is for the word "score". Adjust the `fontSize` in the second `Text` widget's style to change the size of the word "score".


  User(
      {required this.id,
      required this.name,
      required this.email,
      required this.age,
      required this.height,
      required this.gender});

age and height and gender should not be requeied and can be null


If the `age`, `height`, and `gender` fields in your `User` class can be null and are not required, you need to modify the constructor to reflect this. Here's how you can adjust your `User` class:

```dart
class User {
  final int id;
  final String name;
  final String email;
  int? age; // Made nullable and not required
  double? height; // Made nullable and not required
  String? gender; // Made nullable and not required

  User({
    required this.id,
    required this.name,
    required this.email,
    this.age, // No longer required
    this.height, // No longer required
    this.gender, // No longer required
  });

  factory User.fromJson(Map<String, dynamic> json) {
    return User(
      id: json['id'],
      name: json['name'],
      email: json['email'],
      age: json['age'] != null ? int.tryParse(json['age'].toString()) : null, // Parsing to int
      height: json['height'] != null ? double.tryParse(json['height'].toString()) : null, // Parsing to double
      gender: json['gender'], // Assuming gender is a string
    );
  }
}
```

In this updated version:

- The `age`, `height`, and `gender` fields are marked as nullable (`int?`, `double?`, `String?`), indicating that they can hold null values.
- The constructor no longer requires these fields to be provided (`this.age`, `this.height`, `this.gender` without `required` keyword).
- The `fromJson` factory method is updated to handle possible null values and parse the `age` and `height` fields from the JSON object. The `int.tryParse` and `double.tryParse` methods return null if the conversion is not successful, making it safe for nullable fields.


add default value of 0 for height and and age and unknown for gender 


To add default values for `age`, `height`, and `gender` in your `User` class, you can modify the class as follows:

```dart
class User {
  final int id;
  final String name;
  final String email;
  int age; // Default value will be 0
  double height; // Default value will be 0.0
  String gender; // Default value will be 'unknown'

  User({
    required this.id,
    required this.name,
    required this.email,
    this.age = 0, // Set default value to 0
    this.height = 0.0, // Set default value to 0.0
    this.gender = 'unknown', // Set default value to 'unknown'
  });

  factory User.fromJson(Map<String, dynamic> json) {
    return User(
      id: json['id'],
      name: json['name'],
      email: json['email'],
      age: json['age'] != null ? int.tryParse(json['age'].toString()) ?? 0 : 0, // Default to 0 if parsing fails
      height: json['height'] != null ? double.tryParse(json['height'].toString()) ?? 0.0 : 0.0, // Default to 0.0 if parsing fails
      gender: json['gender'] ?? 'unknown', // Default to 'unknown' if null
    );
  }
}
```

In this version:

- The `age` and `height` fields are set to default to `0` and `0.0`, respectively, if they are not provided when creating a new `User` instance.
- The `gender` field defaults to `'unknown'` if not provided.
- In the `fromJson` method, if parsing the `age` and `height` from JSON fails or if the fields are not present in the JSON, they default to `0` and `0.0`, respectively. For `gender`, it defaults to `'unknown'` if the field is not present in the JSON.




lib/main.dart:287:48: Error: Method 'toDouble' cannot be called on 'double?' because it is potentially null.
Try calling using ?. instead.
                      user.currentUser?.height.toDouble() ?? 0.0,
                                               ^^^^^^^^
lib/main.dart:292:45: Error: Method 'toDouble' cannot be called on 'int?' because it is potentially null.
Try calling using ?. instead.
                      user.currentUser?.age.toDouble() ?? 0.0,
                                            ^^^^^^^^
lib/user.dart:91:63: Error: Operator '*' cannot be called on 'double?' because it is potentially null.
        _isMetric ? currentUser!.height : currentUser!.height * 0.3048;
                                                              ^
lib/user.dart:91:19: Error: A value of type 'double?' can't be assigned to a variable of type 'double' because 'double?' is nullable
and 'double' isn't.
        _isMetric ? currentUser!.height : currentUser!.height * 0.3048;
                  ^
Performing hot reload...                                                
Try again after fixing the above error(s).


To resolve these errors, you need to handle the potential nullability of the `height` and `age` fields in your `User` class. Here's how you can fix the issues in your `main.dart` and `user.dart` files:

1. **In `main.dart`**: When using the `toDouble()` method, make sure the values are not null. Since `age` and `height` are already `int` and `double` respectively, you don't need to convert them if they are not null. You can use the null-aware operator (`?.`) to handle this.

    Replace:
    ```dart
    user.currentUser?.height.toDouble() ?? 0.0,
    user.currentUser?.age.toDouble() ?? 0.0,
    ```
    With:
    ```dart
    user.currentUser?.height ?? 0.0,
    user.currentUser?.age.toDouble() ?? 0.0, // Only if age is int, otherwise just use age
    ```

2. **In `user.dart`**: When calculating `FFMI`, make sure to provide a default value for `height` if it is null. Use the null-aware operator (`??`) to assign a default value.

    Replace:
    ```dart
    _isMetric ? currentUser!.height : currentUser!.height * 0.3048;
    ```
    With:
    ```dart
    double heightInMeters = _isMetric ? (currentUser!.height ?? 0.0) : (currentUser!.height ?? 0.0) * 0.3048;
    ```

    This change ensures that `heightInMeters` always has a non-null value, defaulting to `0.0` if `currentUser!.height` is null.

Apply these changes to handle the nullability of `height` and `age` properly, and it should resolve the errors you're encountering.



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

weve now added is metric to the user model so lets adjust the code above

heres the user model now
import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart';

class User {
  final int id;
  final String name;
  final String email;
  final int age;
  final double height;
  final String gender;
  final bool isMetric;

  User({
    required this.id,
    required this.name,
    required this.email,
    this.age = 0, // Set default value to 0
    this.height = 0.0, // Set default value to 0.0
    this.gender = 'unknown', // Set default value to 'unknown'
    this.isMetric = true, // Set default value to true
  });

  factory User.fromJson(Map<String, dynamic> json) {
    return User(
      id: json['id'],
      name: json['name'],
      email: json['email'],
      age: json['age'] != null
          ? int.tryParse(json['age'].toString()) ?? 0
          : 0, // Default to 0 if parsing fails
      height: json['height'] != null
          ? double.tryParse(json['height'].toString()) ?? 0.0
          : 0.0, // Default to 0.0 if parsing fails
      gender: json['gender'] ?? 'unknown', // Default to 'unknown' if null
      isMetric: json['is_metric'] ?? true, // Default to false if null
    );
  }
}

class UserModel extends ChangeNotifier {
  User? _currentUser;
  DateTime? _birthday;
  double? _weight;
  double? _height;
  double? _bodyFatPercentage;

  User? get currentUser => _currentUser;
  DateTime? get birthday => _birthday;
  double? get weight => _weight;
  double? get height => _height;
  double? get bodyFatPercentage => _bodyFatPercentage;

  void setCurrentUser(User user) {
    _currentUser = user;
    notifyListeners();
  }

  void updateBirthday(DateTime newBirthday) {
    _birthday = newBirthday;
    notifyListeners();
  }

  void updateWeight(double newWeight) {
    _weight = newWeight;
    notifyListeners();
  }

  void updateHeight(double newHeight) {
    _height = newHeight;
    notifyListeners();
  }

  void updateBodyFatPercentage(double newBodyFatPercentage) {
    _bodyFatPercentage = newBodyFatPercentage;
    notifyListeners();
  }

  double calculateFFMI() {
    if (_weight == null ||
        _bodyFatPercentage == null ||
        currentUser?.height == 0.0) {
      return 0.0;
    }

    double leanBodyMass = _weight! * (1 - (_bodyFatPercentage! / 100));
    double heightInMeters = _currentUser!.isMetric
        ? currentUser!.height
        : currentUser!.height * 0.3048;
    return (leanBodyMass / (heightInMeters * heightInMeters)) +
        6.1 * (1.8 - heightInMeters);
  }

  // Add any other user-related methods and logic here
}



With the `isMetric` field now part of the `User` model, you can adjust the `_getFormattedValue` method in `main.dart` to use this field directly from the `currentUser`. This way, the method will use the user's preference for metric or imperial units when displaying values. Here's the updated code:

1. Modify the `_getFormattedValue` method in `main.dart`:

```dart
String _getFormattedValue(String label, double value, BuildContext context) {
  final userModel = Provider.of<UserModel>(context, listen: false);
  final isMetric = userModel.currentUser?.isMetric ?? true; // Default to true

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
```

2. Update the `User` class and the `UserModel` class in `user.dart` as you have described.

By fetching the `isMetric` value directly from the `currentUser` object, you ensure that the displayed values are always in accordance with the user's preferences. This change makes your application more user-centric and adaptable to different users' settings.


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
              value: currentUser.isMetric,
              onChanged: (bool value) {
                user.toggleUnitPreference();
              },
            ),
          ],
        ),
      ),

we need to adjust this as well


Error: A value of type 'bool?' can't be assigned to a variable of type 'bool' because 'bool?' is nullable and
'bool' isn't.
        return isMetric
               ^
lib/main.dart:441:13: Error: A value of type 'bool?' can't be assigned to a variable of type 'bool' because 'bool?' is nullable and
'bool' isn't.
        if (isMetric) {
            ^
lib/user.dart:86:43: Error: A value of type 'bool?' can't be assigned to a variable of type 'bool' because 'bool?' is nullable and
'bool' isn't.
    double heightInMeters = _currentUser!.isMetric
                                          ^
Performing hot reload...                                                
Try again after fixing the above error(s).




To adjust
