
To change the `age` and `height` inputs to dropdown menus, you'll need to create two dropdowns with the specified ranges. Additionally, you'll want to modify the dropdowns dynamically based on the selected measurement system (imperial or metric).

First, let's add two methods in the `_ProfileCompletionPageState` to generate `DropdownMenuItem` lists for age and height:

```dart
List<DropdownMenuItem<int>> getAgeDropdownItems() {
  return List<DropdownMenuItem<int>>.generate(82, (index) => 
    DropdownMenuItem(
      value: index + 18,
      child: Text('${index + 18}'),
    ),
  );
}

List<DropdownMenuItem<String>> getHeightDropdownItems(MeasurementSystem system) {
  if (system == MeasurementSystem.imperial) {
    // Generate height dropdown for imperial system
    return List<DropdownMenuItem<String>>.generate(
      (8 * 12 + 1) - (4 * 12 + 10), // Range from 4'10" to 8'0"
      (index) {
        int totalInches = index + (4 * 12 + 10);
        int feet = totalInches ~/ 12;
        int inches = totalInches % 12;
        return DropdownMenuItem(
          value: "$feet'$inches\"",
          child: Text("$feet'$inches\""),
        );
      },
    );
  } else {
    // Generate height dropdown for metric system
    return List<DropdownMenuItem<String>>.generate(
      251 - 147, // Range from 147cm to 250cm
      (index) => DropdownMenuItem(
        value: "${index + 147} cm",
        child: Text("${index + 147} cm"),
      ),
    );
  }
}
```

Next, you'll need to update the `DropdownButtonFormField` for height to display the correct items based on the measurement system and ensure that `_height` is stored in the correct format (you might need to convert between systems if required). You'll also need to update the dropdown for age:

```dart
// Inside the ListView of your build method:

// Age Dropdown
DropdownButtonFormField(
  value: _age,
  decoration: _inputDecoration('Age'),
  items: getAgeDropdownItems(),
  onChanged: (int? newValue) {
    setState(() {
      _age = newValue!;
    });
  },
),

SizedBox(height: 16),

// Height Dropdown
DropdownButtonFormField(
  value: _height.toString(),
  decoration: _inputDecoration('Height'),
  items: getHeightDropdownItems(_selectedSystem),
  onChanged: (String? newValue) {
    setState(() {
      _height = _selectedSystem == MeasurementSystem.imperial
        ? convertToInches(newValue!) // Implement this conversion function
        : convertToCentimeters(newValue!); // Implement this conversion function
    });
  },
),

// ... other widgets
```

Finally, you'll need to handle the conversion between the imperial and metric systems for the height. This can be a bit complex, as you need to account for the differences in how these systems represent height:

```dart
int convertToInches(String heightInFeetAndInches) {
  // Split the string by apostrophe and quote mark to get feet and inches
  List<String> parts = heightInFeetAndInches.split(RegExp(r"[']|["]"));
  int feet = int.parse(parts[0]);
  int inches = int.parse(parts[1]);
  return (feet * 12) + inches;
}

double convertToCentimeters(String heightInCentimeters) {
  // Remove 'cm' and convert to double
  return double.parse(heightInCentimeters.replaceAll(' cm', ''));
}
```

Remember to update the `MeasurementToggle` widget to use a callback that updates the `ProfileCompletionPage` with the selected measurement system, and ensure the height dropdown is rebuilt with the new measurement unit items when the toggle is switched.

The `convertToInches` and `convertToCentimeters` functions will need to be implemented based on how you want to store height data. If you store height in a standard unit internally (e.g., always in inches or centimeters), these functions will convert to and from that standard unit when displaying or receiving input from the user.


ok so give me update code for the fulle page. here it is currently:
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:superheromobile/models/user.dart';
import 'package:superheromobile/services/UserDetails.dart';
import 'package:superheromobile/theme.dart'; // Make sure you're using the same theme
import 'package:superheromobile/components/MeasurementToggle.dart';

class ProfileCompletionPage extends StatefulWidget {
  @override
  _ProfileCompletionPageState createState() => _ProfileCompletionPageState();
}

class _ProfileCompletionPageState extends State<ProfileCompletionPage> {
  final _formKey = GlobalKey<FormState>();
  late String _name;
  late int _age;
  late double _height;
  late String _gender;

  @override
  void initState() {
    super.initState();
    final userModel = Provider.of<UserModel>(context, listen: false);
    _name = userModel.currentUser?.name ?? '';
    _age = userModel.currentUser?.age ?? 0;
    _height = userModel.currentUser?.height ?? 0.0;
    _gender = userModel.currentUser?.gender ?? 'unknown';
  }

  void _saveProfile() async {
    if (_formKey.currentState!.validate()) {
      _formKey.currentState!.save();

      final userModel = Provider.of<UserModel>(context, listen: false);
      // Update the userModel with the new values
      // ... (User update logic)

      bool success = await updateUserDetails(userModel.currentUser!);
      if (success) {
        Navigator.of(context).pop(true);
      } else {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text('Failed to update profile. Please try again.'),
        ));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Theme(
      data: buildDarkTheme(), // Use the same theme as LoginPage
      child: Scaffold(
        backgroundColor: Colors.black, // Match the background color
        appBar: AppBar(
          centerTitle: true,
          leading: IconButton(
            icon: Icon(Icons.arrow_back),
            onPressed: () => Navigator.of(context).pop(),
          ),
          title: Text('Complete Your Profile'),
        ),
        body: Padding(
          padding: const EdgeInsets.all(16.0),
          child: Form(
            key: _formKey,
            child: ListView(
              children: [
                // Name Field
                TextFormField(
                  initialValue: _name,
                  decoration: _inputDecoration('Name'),
                  style: TextStyle(color: Colors.white),
                  validator: (value) =>
                      value!.isEmpty ? 'Name is required' : null,
                  onSaved: (value) => _name = value!,
                ),
                SizedBox(height: 16),

                // Age Field
                TextFormField(
                  initialValue: _age.toString(),
                  decoration: _inputDecoration('Age'),
                  keyboardType: TextInputType.number,
                  style: TextStyle(color: Colors.white),
                  validator: (value) =>
                      value!.isEmpty ? 'Age is required' : null,
                  onSaved: (value) => _age = int.parse(value!),
                ),
                SizedBox(height: 16),

                // Height Field
                TextFormField(
                  initialValue: _height.toString(),
                  decoration: _inputDecoration('Height'),
                  keyboardType: TextInputType.number,
                  style: TextStyle(color: Colors.white),
                  validator: (value) =>
                      value!.isEmpty ? 'Height is required' : null,
                  onSaved: (value) => _height = double.parse(value!),
                ),
                SizedBox(height: 16),

                //Add a toggle for metric/imperial
                MeasurementToggle(),
                SizedBox(height: 16),

                // Gender Dropdown
                DropdownButtonFormField(
                  value: _gender,
                  decoration: _inputDecoration('Gender'),
                  style: TextStyle(color: Colors.white),
                  dropdownColor: Colors.grey[850],
                  items: ['male', 'female', 'unknown']
                      .map((label) => DropdownMenuItem(
                            child: Text(label,
                                style: TextStyle(color: Colors.white)),
                            value: label,
                          ))
                      .toList(),
                  onChanged: (value) {
                    setState(() {
                      _gender = value as String;
                    });
                  },
                ),
                SizedBox(height: 20),

                // Save Profile Button
                ElevatedButton(
                  child: Text('Save Profile'),
                  onPressed: _saveProfile,
                  style: ButtonStyle(
                    backgroundColor: MaterialStateProperty.resolveWith<Color>(
                      (Set<MaterialState> states) {
                        return Colors.white; // Button background color
                      },
                    ),
                    foregroundColor: MaterialStateProperty.resolveWith<Color>(
                      (Set<MaterialState> states) {
                        return Colors.black; // Button text color
                      },
                    ),
                    shape: MaterialStateProperty.all<RoundedRectangleBorder>(
                      RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(8.0),
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  InputDecoration _inputDecoration(String label) {
    return InputDecoration(
      labelText: label,
      filled: true,
      fillColor: Colors.grey[850],
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(8.0),
      ),
      labelStyle: TextStyle(color: Colors.grey),
    );
  }
}



Here is the updated `ProfileCompletionPage` with `age` and `height` as dropdown menus, and the height options change dynamically based on the selected measurement system:

```dart
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:superheromobile/models/user.dart';
import 'package:superheromobile/services/UserDetails.dart';
import 'package:superheromobile/theme.dart';
import 'package:superheromobile/components/MeasurementToggle.dart';

enum MeasurementSystem { imperial, metric }

class ProfileCompletionPage extends StatefulWidget {
  @override
  _ProfileCompletionPageState createState() => _ProfileCompletionPageState();
}

class _ProfileCompletionPageState extends State<ProfileCompletionPage> {
  final _formKey = GlobalKey<FormState>();
  late String _name;
  late int _age;
  late String _height; // Changed to String to handle the formatted height
  late String _gender;
  MeasurementSystem _measurementSystem = MeasurementSystem.metric; // Default system

  @override
  void initState() {
    super.initState();
    final userModel = Provider.of<UserModel>(context, listen: false);
    _name = userModel.currentUser?.name ?? '';
   


```dart
    _age = userModel.currentUser?.age ?? 18; // Default to 18 if not set
    _height = userModel.currentUser?.height?.toString() ?? (_measurementSystem == MeasurementSystem.metric ? '170' : "5'7\""); // Default height based on the system
    _gender = userModel.currentUser?.gender ?? 'unknown';
  }

  void _saveProfile() async {
    if (_formKey.currentState!.validate()) {
      _formKey.currentState!.save();
      final userModel = Provider.of<UserModel>(context, listen: false);
      // Update the userModel with the new values
      userModel.updateUserDetails(
        name: _name,
        age: _age,
        height: _measurementSystem == MeasurementSystem.metric ? _height : convertFeetAndInchesToCentimeters(_height),
        gender: _gender,
      );
      bool success = await updateUserDetails(userModel.currentUser!);
      if (success) {
        Navigator.of(context).pop(true);
      } else {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Failed to update profile. Please try again.')),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    // ... Rest of the build method remains the same

    // DropdownButtonFormField for Age
    DropdownButtonFormField<int>(
      value: _age,
      decoration: _inputDecoration('Age'),
      items: List<DropdownMenuItem<int>>.generate(
        82, // Range from 18 to 99
        (index) => DropdownMenuItem(
          value: index + 18,
          child: Text('${index + 18}'),
        ),
      ),
      onChanged: (int? newValue) {
        setState(() {
          _age = newValue!;
        });
      },
    ),

    SizedBox(height: 16),

    // DropdownButtonFormField for Height
    DropdownButtonFormField<String>(
      value: _height,
      decoration: _inputDecoration('Height'),
      items: _measurementSystem == MeasurementSystem.imperial
          ? getHeightDropdownItemsImperial()
          : getHeightDropdownItemsMetric(),
      onChanged: (String? newValue) {
        setState(() {
          _height = newValue!;
        });
      },
    ),

    // ... Rest of the widgets including MeasurementToggle and Save Profile Button
  }

  InputDecoration _inputDecoration(String label) {
    // ... The InputDecoration method remains the same
  }

  List<DropdownMenuItem<String>> getHeightDropdownItemsImperial() {
    // ... Implement the method to generate height items for the imperial system
  }

  List<DropdownMenuItem<String>> getHeightDropdownItemsMetric() {
    // ... Implement the method to generate height items for the metric system
  }

  String convertFeetAndInchesToCentimeters(String height) {
    // ... Implement the conversion logic
  }
}
```

To complete the implementation:

- Make sure the `UserModel` class has a method `updateUserDetails` to handle the update logic.
- Implement the `getHeightDropdownItemsImperial` and `getHeightDropdownItemsMetric` methods to generate dropdown items for height in imperial and metric systems, respectively.
- Write the `convertFeetAndInchesToCentimeters` method to handle the conversion from feet and inches to centimeters if the backend requires height in centimeters.

Remember, the above code only provides a structure and needs to be filled out with your specific logic for conversion and updating user details.


import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:superheromobile/models/user.dart';
import 'package:superheromobile/services/UserDetails.dart';
import 'package:superheromobile/theme.dart'; // Make sure you're using the same theme
import 'package:superheromobile/components/MeasurementToggle.dart';

enum MeasurementSystem { imperial, metric }

class ProfileCompletionPage extends StatefulWidget {
  @override
  _ProfileCompletionPageState createState() => _ProfileCompletionPageState();
}

class _ProfileCompletionPageState extends State<ProfileCompletionPage> {
  final _formKey = GlobalKey<FormState>();
  late String _name;
  late int _age;
  late String _height; // Changed to String to handle the formatted height
  late String _gender;
  MeasurementSystem _measurementSystem =
      MeasurementSystem.metric; // Default system

  @override
  void initState() {
    super.initState();
    final userModel = Provider.of<UserModel>(context, listen: false);
    _name = userModel.currentUser?.name ?? '';
    _age = userModel.currentUser?.age ?? 18; // Default to 18 if not set
    _height = userModel.currentUser?.height?.toString() ??
        (_measurementSystem == MeasurementSystem.metric
            ? '170'
            : "5'7\""); // Default height based on the system
    _gender = userModel.currentUser?.gender ?? 'unknown';
  }

  void _saveProfile() async {
    if (_formKey.currentState!.validate()) {
      _formKey.currentState!.save();
      final userModel = Provider.of<UserModel>(context, listen: false);
      // Update the userModel with the new values
      userModel.updateUserDetails(
        name: _name,
        age: _age,
        height: _measurementSystem == MeasurementSystem.metric
            ? _height
            : convertFeetAndInchesToCentimeters(_height),
        gender: _gender,
      );
      bool success = await updateUserDetails(userModel.currentUser!);
      if (success) {
        Navigator.of(context).pop(true);
      } else {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
              content: Text('Failed to update profile. Please try again.')),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Theme(
      data: buildDarkTheme(), // Use the same theme as LoginPage
      child: Scaffold(
        backgroundColor: Colors.black, // Match the background color
        appBar: AppBar(
          centerTitle: true,
          leading: IconButton(
            icon: Icon(Icons.arrow_back),
            onPressed: () => Navigator.of(context).pop(),
          ),
          title: Text('Complete Your Profile'),
        ),
        body: Padding(
          padding: const EdgeInsets.all(16.0),
          child: Form(
            key: _formKey,
            child: ListView(
              children: [
                // Name Field
                TextFormField(
                  initialValue: _name,
                  decoration: _inputDecoration('Name'),
                  style: TextStyle(color: Colors.white),
                  validator: (value) =>
                      value!.isEmpty ? 'Name is required' : null,
                  onSaved: (value) => _name = value!,
                ),
                SizedBox(height: 16),

                // DropdownButtonFormField for Age
                DropdownButtonFormField<int>(
                  value: _age,
                  decoration: _inputDecoration('Age'),
                  items: List<DropdownMenuItem<int>>.generate(
                    82, // Range from 18 to 99
                    (index) => DropdownMenuItem(
                      value: index + 18,
                      child: Text('${index + 18}'),
                    ),
                  ),
                  onChanged: (int? newValue) {
                    setState(() {
                      _age = newValue!;
                    });
                  },
                ),

                // DropdownButtonFormField for Height
                DropdownButtonFormField<String>(
                  value: _height,
                  decoration: _inputDecoration('Height'),
                  items: _measurementSystem == MeasurementSystem.imperial
                      ? getHeightDropdownItemsImperial()
                      : getHeightDropdownItemsMetric(),
                  onChanged: (String? newValue) {
                    setState(() {
                      _height = newValue!;
                    });
                  },
                ),

                //Add a toggle for metric/imperial
                MeasurementToggle(),
                SizedBox(height: 16),

                // Gender Dropdown
                DropdownButtonFormField(
                  value: _gender,
                  decoration: _inputDecoration('Gender'),
                  style: TextStyle(color: Colors.white),
                  dropdownColor: Colors.grey[850],
                  items: ['male', 'female', 'unknown']
                      .map((label) => DropdownMenuItem(
                            child: Text(label,
                                style: TextStyle(color: Colors.white)),
                            value: label,
                          ))
                      .toList(),
                  onChanged: (value) {
                    setState(() {
                      _gender = value as String;
                    });
                  },
                ),
                SizedBox(height: 20),

                // Save Profile Button
                ElevatedButton(
                  child: Text('Save Profile'),
                  onPressed: _saveProfile,
                  style: ButtonStyle(
                    backgroundColor: MaterialStateProperty.resolveWith<Color>(
                      (Set<MaterialState> states) {
                        return Colors.white; // Button background color
                      },
                    ),
                    foregroundColor: MaterialStateProperty.resolveWith<Color>(
                      (Set<MaterialState> states) {
                        return Colors.black; // Button text color
                      },
                    ),
                    shape: MaterialStateProperty.all<RoundedRectangleBorder>(
                      RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(8.0),
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  InputDecoration _inputDecoration(String label) {
    return InputDecoration(
      labelText: label,
      filled: true,
      fillColor: Colors.grey[850],
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(8.0),
      ),
      labelStyle: TextStyle(color: Colors.grey),
    );
  }
}



        ? getHeightDropdownItemsImperial()
                        ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
lib/screens/ProfileCompletionPage.dart:117:25: Error: The method
'getHeightDropdownItemsMetric' isn't defined for the class '_ProfileCompletionPageState'.
 - '_ProfileCompletionPageState' is from
 'package:superheromobile/screens/ProfileCompletionPage.dart'
 ('lib/screens/ProfileCompletionPage.dart').
Try correcting the name to the name of an existing method, or defining a method named
'getHeightDropdownItemsMetric'.
                      : getHeightDropdownItemsMetric(),
                        ^^^^^^^^^^^^^^^^^^^^^^^^^^^^
Performing hot reload...                                                
Try again after fixing the above error(s).


To fix the errors, you need to define the `getHeightDropdownItemsImperial` and `getHeightDropdownItemsMetric` methods within the `_ProfileCompletionPageState` class. These methods will generate the list of height options for the dropdown menus based on the selected measurement system.

Here's the updated code for your `ProfileCompletionPage`:

```dart
// ... previous imports

class ProfileCompletionPage extends StatefulWidget {
  @override
  _ProfileCompletionPageState createState() => _ProfileCompletionPageState();
}

class _ProfileCompletionPageState extends State<ProfileCompletionPage> {
  // ... other state variables

  // Add two methods to generate Dropdown items for the height
  List<DropdownMenuItem<String>> getHeightDropdownItemsImperial() {
    List<String> heights = [];
    for (int feet = 4; feet <= 8; feet++) {
      for (int inch = feet == 4 ? 10 : 0; inch < 12; inch++) {
        if (feet == 8 && inch == 0) break; // Stop at 8'0"
        heights.add("$feet'$inch\"");
      }
    }
    return heights
        .map((height) => DropdownMenuItem(value: height, child: Text(height)))
        .toList();
  }

  List<DropdownMenuItem<String>> getHeightDropdownItemsMetric() {
    List<String> heights = [];
    for (int cm = 147; cm <= 250; cm++) { // Assuming the range from 147cm to 250cm
      heights.add("$cm cm");
    }
    return heights
        .map((height) => DropdownMenuItem(value: height, child: Text(height)))
        .toList();
  }

  // ... rest of the _ProfileCompletionPageState class
}
```

Now, in the build method, you can use the dropdown menu for `height` and `age` like so:

```dart
// ... inside the build method

// Age Dropdown
DropdownButtonFormField<int>(
  value: _age,
  decoration: _inputDecoration('Age'),
  items: List<DropdownMenuItem<int>>.generate(
    82, // Range from 18 to 99
    (index) => DropdownMenuItem(
      value: index + 18,
      child: Text('${index + 18} years'),
    ),
  ),
  onChanged: (int? newValue) {
    setState(() {
      _age = newValue!;
    });
  },
),

SizedBox(height: 16),

// Height Dropdown
DropdownButtonFormField<String>(
  value: _height,
  decoration: _inputDecoration('Height'),
  items: _measurementSystem == MeasurementSystem.imperial
      ? getHeightDropdownItemsImperial()
      : getHeightDropdownItemsMetric(),
  onChanged: (String? newValue) {
    setState(() {
      _height = newValue!;
    });
  },
),

// ... rest of the widgets
```

Please note that you will also need to handle the logic for converting the height value when saving the user's profile. The `convertFeetAndInchesToCentimeters` method will be necessary if you're storing height in centimeters in your database and need to convert from feet and inches. The conversion method isn't provided here and should be implemented according to how you wish to store and handle height data.



                ^^^^^^^^^^^^^^^^^
lib/screens/ProfileCompletionPage.dart:72:15: Error: The method
'convertFeetAndInchesToCentimeters' isn't defined for the class
'_ProfileCompletionPageState'.
 - '_ProfileCompletionPageState' is from
 'package:superheromobile/screens/ProfileCompletionPage.dart'
 ('lib/screens/ProfileCompletionPage.dart').
Try correcting the name to the name of an existing method, or defining a method named
'convertFeetAndInchesToCentimeters'.
            : convertFeetAndInchesToCentimeters(_height),
              ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
Performing hot reload...                                                
Try again after fixing the above error(s).



It seems you need the `convertFeetAndInchesToCentimeters` function to convert the heights when storing them. Below is a simple implementation of this function:

```dart
double convertFeetAndInchesToCentimeters(String height) {
  var parts = height.split("'");
  var feet = int.parse(parts[0]);
  var inches = int.parse(parts[1].replaceAll('"', ''));
  var totalInches = feet * 12 + inches;
  return totalInches * 2.54; // 1 inch equals 2.54 centimeters
}
```

Please add this function inside your `_ProfileCompletionPageState` class. This function assumes that your height string is in the format "X'Y"" (e.g., "5'11"") and converts it to centimeters.

Now, ensure that when you call `_saveProfile`, it uses the correct height value based on the selected measurement system:

```dart
void _saveProfile() async {
  if (_formKey.currentState!.validate()) {
    _formKey.currentState!.save();
    final userModel = Provider.of<UserModel>(context, listen: false);

    String heightToSave = _measurementSystem == MeasurementSystem.metric
        ? _height // If the measurement system is metric, save the height as is.
        : convertFeetAndInchesToCentimeters(_height).toStringAsFixed(2); // If imperial, convert to centimeters.

    // Update the userModel with the new values
    userModel.updateUserDetails(
      name: _name,
      age: _age,
      height: heightToSave,
      gender: _gender,
    );

    bool success = await updateUserDetails(userModel.currentUser!);
    if (success) {
      Navigator.of(context).pop(true);
    } else {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Failed to update profile. Please try again.')),
      );
    }
  }
}
```

Please make sure to replace `userModel.updateUserDetails` with the actual method you have for updating the user details in your `UserModel`. The example assumes such a method exists. If it doesn't, replace it with the appropriate code to update the user's details.




lib/screens/ProfileCompletionPage.dart:81:17: Error: The method 'updateUserDetails' isn't
defined for the class 'UserModel'.
 - 'UserModel' is from 'package:superheromobile/models/user.dart' ('lib/models/user.dart').
Try correcting the name to the name of an existing method, or defining a method named
'updateUserDetails'.
      userModel.updateUserDetails(
                ^^^^^^^^^^^^^^^^^
Performing hot reload...                                                
Try again after fixing the above error(s).



It appears the error is because there isn't an `updateUserDetails` method defined in your `UserModel` class. This function should handle updating the user details in your app and potentially making the call to your API service to update the user profile.

Assuming you have a method to update user details on the server (like `updateUserDetails` from the `UserDetails.dart` service file), you should call this method with the user object that contains the updated details.

Here's an example of how you can implement a method to update user details within your `UserModel`:

```dart
class UserModel with ChangeNotifier {
  User? _currentUser;

  // ... Other fields and methods

  void setCurrentUser(User user) {
    _currentUser = user;
    notifyListeners();
  }

  Future<bool> updateUserDetails({
    required String name,
    required int age,
    required String height,
    required String gender,
  }) async {
    if (_currentUser != null) {
      // Update your _currentUser object with the new values
      _currentUser = User(
        id: _currentUser!.id,
        name: name,
        email: _currentUser!.email, // Assuming email doesn't change
        age: age,
        height: height,
        gender: gender,
        isMetric: _currentUser!.isMetric, // Assuming this doesn't change
        ffmi: _currentUser!.ffmi, // Assuming this doesn't change
        // ... Include other fields if there are any
      );

      // Call your API service to update the user details on the server
      bool success = await updateUserDetailsAPI(_currentUser!);
      notifyListeners(); // Notify listeners in case of successful update
      return success;
    }
    return false; // Return false if there's no user to update
  }

  // This method calls the updateUserDetails function in your UserDetails.dart service file
  Future<bool> updateUserDetailsAPI(User user) async {
    return await updateUserDetails(user);
  }
}
```

Now in your `_ProfileCompletionPageState`, you should replace the call to `updateUserDetails` with this new method from `UserModel`:

```dart
void _saveProfile() async {
  if (_formKey.currentState!.validate()) {
    _formKey.currentState!.save();
    final userModel = Provider.of<UserModel>(context, listen: false);

    // Prepare height to save based on the measurement system
    String heightToSave = _measurementSystem == MeasurementSystem.metric
        ? _height
        : convertFeetAndInchesToCentimeters(_height).toStringAsFixed(2);

    // Call the new updateUserDetails method with the updated values
    bool success = await userModel.updateUserDetails(
      name: _name,
      age: _age,
      height: heightToSave,
      gender: _gender,
    );

    if (success) {
      Navigator.of(context).pop(true);
    } else {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Failed to update profile. Please try again.')),
      );
    }
  }
}
```

Make sure to handle the response and errors accordingly, and update the UI based on the success of the operation. The code assumes `updateUserDetails` is a future that completes with a boolean indicating success. Adjust this as necessary to fit your API's actual behavior.


import 'package:flutter/material.dart';
import 'package:superheromobile/models/user.dart';
import 'package:superheromobile/theme.dart';

class ProfilePage extends StatelessWidget {
  final UserModel userModel;

  ProfilePage({Key? key, required this.userModel}) : super(key: key);

  @override
  Widget build(BuildContext context) {
    // Accessing the theme
    final theme = Theme.of(context);

    return Scaffold(
      appBar: AppBar(
        title: Text('Profile', style: theme.appBarTheme.titleTextStyle),
      ),
      body: Padding(
        padding: EdgeInsets.all(16.0),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            /*    Center(
              child: CircleAvatar(
                radius: 50,
                backgroundImage: NetworkImage(
                    userModel.currentUser?.avatarUrl ?? 'default_avatar_url'),
                backgroundColor: Colors.transparent,
              ),
            ), */
            SizedBox(height: 16.0),
            Text(
              userModel.currentUser?.name ?? 'N/A',
              style: theme.textTheme.headline5, // Using theme
            ),
            Divider(color: theme.dividerColor),
            _userInfoRow('Email', userModel.currentUser?.email ?? 'N/A', theme),
            _userInfoRow('Height',
                userModel.currentUser?.height.toString() ?? 'N/A', theme),
            _userInfoRow(
                'Age', userModel.currentUser?.age.toString() ?? 'N/A', theme),
            _userInfoRow(
                'Gender', userModel.currentUser?.gender ?? 'N/A', theme),
            _userInfoRow('Is Metric',
                userModel.currentUser?.isMetric.toString() ?? 'N/A', theme),
            SizedBox(height: 20.0),
          ],
        ),
      ),
    );
  }

  Widget _userInfoRow(String title, String value, ThemeData theme) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8.0),
      child: Row(
        children: [
          Text(
            '$title: ',
            style: theme.textTheme.subtitle1, // Using theme
          ),
          Text(
            value,
            style: theme.textTheme.bodyText2, // Using theme
          ),
        ],
      ),
    );
  }
}


style this to match our app and add an edit profile button that goes to the complete your pfoile page


To style the `ProfilePage` to match the rest of your app, apply the dark theme consistently, and add an 'Edit Profile' button that navigates to the `ProfileCompletionPage`, you can do the following:

1. Apply the dark theme to the entire page.
2. Add an 'Edit Profile' button at the bottom of the page.
3. Use a consistent styling for text elements and dividers as per your theme.
4. Implement the navigation logic to go to the `ProfileCompletionPage` when the 'Edit Profile' button is pressed.

Here's how you can implement it:

```dart
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:superheromobile/models/user.dart';
import 'package:superheromobile/theme.dart';
import 'package:superheromobile/screens/ProfileCompletionPage.dart';

class ProfilePage extends StatelessWidget {
  final UserModel userModel;

  ProfilePage({Key? key, required this.userModel}) : super(key: key);

  @override
  Widget build(BuildContext context) {
    // Accessing the theme
    final theme = Theme.of(context);

    return Scaffold(
      appBar: AppBar(
        title: Text('Profile', style: theme.appBarTheme.titleTextStyle),
        actions: [
          IconButton(
            icon: Icon(Icons.edit),
            onPressed: () {
              // Navigate to the ProfileCompletionPage to edit the profile
              Navigator.push(
                context,
                MaterialPageRoute(builder: (context) => ProfileCompletionPage()),
              );
            },
          ),
        ],
      ),
      body: Padding(
        padding: EdgeInsets.all(16.0),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SizedBox(height: 16.0),
            Text(
              userModel.currentUser?.name ?? 'N/A',
              style: theme.textTheme.headline5.copyWith(color: Colors.white), // Using theme
            ),
            Divider(color: theme.dividerColor),
            _userInfoRow('Email', userModel.currentUser?.email ?? 'N/A', theme),
            _userInfoRow('Height', userModel.currentUser?.getDisplayHeight() ?? 'N/A', theme), // Assuming getDisplayHeight method exists
            _userInfoRow('Age', userModel.currentUser?.age.toString() ?? 'N/A', theme),
            _userInfoRow('Gender', userModel.currentUser?.gender ?? 'N/A', theme),
            _userInfoRow('Is Metric', userModel.currentUser?.isMetric.toString() ?? 'N/A', theme),
            Spacer(), // Pushes the button to the bottom of the screen
            ElevatedButton(
              onPressed: () {
                Navigator.of(context).push(MaterialPageRoute(
                  builder: (context) => ProfileCompletionPage(),
                ));
              },
              child: Text('Edit Profile'),
              style: ElevatedButton.styleFrom(
                primary: theme.colorScheme.secondary, // Use the secondary color from the theme
                onPrimary: Colors.white, // Text color
              ),
            ),
            SizedBox(height: 20.0),
          ],
        ),
      ),
    );
  }

  Widget _userInfoRow(String title, String value, ThemeData theme) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8.0),
      child: Row(
        children: [
          Text(
            '$title: ',
            style: theme.textTheme.subtitle1.copyWith(color: Colors.grey), // Using theme
          ),
          Flexible(
            child: Text(
              value,
              style: theme.textTheme.bodyText2.copyWith(color: Colors.white), // Using theme
              overflow: TextOverflow.ellipsis,
            ),
          ),
        ],
      ),
    );
  }
}
```

In this updated `ProfilePage`:

- The 'Edit Profile' button is styled according to the app's theme and placed at the bottom of the screen.
- An edit icon is added to the AppBar, which also navigates to the `ProfileCompletionPage`.
- The text styles are now using the dark theme colors for better visibility against the dark background.
- I've added a hypothetical `getDisplayHeight` method to `UserModel`, which you may need to implement to display the height in the preferred format based on the metric/imperial setting.

This will navigate the user to the `ProfileCompletionPage` when they wish to edit their profile, where they can update their details as needed.


**Topic:** [[chatgpt-clusters/coding_mobile]]
