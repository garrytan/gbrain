---
title: "Add FFMI to User"
type: guide
created: 2024-01-10
updated: 2024-01-10
source: chatgpt-export
conversation_id: 1b096efd-c4e1-41bc-bcdc-d46a3c573614
message_count: 2
tags: [chatgpt, import, code]
---
# Add FFMI to User

> Conversation ID: 1b096efd-c4e1-41bc-bcdc-d46a3c573614
> Created: 2024-01-10T02:02:50Z
> Updated: 2024-01-10T02:03:45Z
> Messages: 2

---

## User

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


lets add FFMI to this model. it will come as a number with decimals and if it is not set lets make it 99.99

---

## Assistant

To add FFMI (Fat-Free Mass Index) to the `User` model in your Flutter application, you can follow these steps:

1. Add a new field `ffmi` in the `User` class with a default value of `99.99`.
2. Modify the constructor to include this new field.
3. Adjust the `fromJson` factory method to parse and set the `ffmi` from the JSON object.

Here is the modified `User` class incorporating these changes:

```dart
class User {
  final int id;
  final String name;
  final String email;
  final int age;
  final double height;
  final String gender;
  final bool isMetric;
  final double ffmi; // New field for FFMI

  User({
    required this.id,
    required this.name,
    required this.email,
    this.age = 0,
    this.height = 0.0,
    this.gender = 'unknown',
    this.isMetric = true,
    this.ffmi = 99.99, // Default value set to 99.99
  });

  factory User.fromJson(Map<String, dynamic> json) {
    return User(
      id: json['id'],
      name: json['name'],
      email: json['email'],
      age: json['age'] != null ? int.tryParse(json['age'].toString()) ?? 0 : 0,
      height: json['height'] != null ? double.tryParse(json['height'].toString()) ?? 0.0 : 0.0,
      gender: json['gender'] ?? 'unknown',
      isMetric: json['is_metric'] ?? true,
      ffmi: json['ffmi'] != null ? double.tryParse(json['ffmi'].toString()) ?? 99.99 : 99.99, // Parsing FFMI
    );
  }

  // Rest of the class remains the same
}
```

In this modification, the `ffmi` field is set to `99.99` by default. When creating a `User` object from JSON data, if the FFMI is provided and can be parsed as a double, it will use that value; otherwise, it defaults to `99.99`. This approach ensures that `ffmi` is always a valid double and aligns with the existing design of your class for handling optional fields.
