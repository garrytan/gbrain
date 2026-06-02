

lib/utils.dart:54:1: Error: Directives must appear before any declarations.
Try moving the directive before any declarations.
import 'dart:convert';
^^^^^^
lib/utils.dart:55:1: Error: Directives must appear before any declarations.
Try moving the directive before any declarations.
import 'package:flutter/material.dart';
^^^^^^
lib/utils.dart:56:1: Error: Directives must appear before any declarations.
Try moving the directive before any declarations.
import 'package:http/http.dart' as http;
^^^^^^
lib/screens/ProfileCompletionPage.dart:33:34: Error: The method '_getToken' isn't defined for
the class '_ProfileCompletionPageState'.
 - '_ProfileCompletionPageState' is from
 'package:superheromobile/screens/ProfileCompletionPage.dart'
 ('lib/screens/ProfileCompletionPage.dart').
Try correcting the name to the name of an existing method, or defining a method named
'_getToken'.
      final String token = await _getToken();
                                 ^^^^^^^^^
Performing hot reload...                                                
Try again after fixing the above error(s).


The errors you're encountering indicate two separate issues:

1. The import statements in `lib/utils.dart` are not at the top of the file. In Dart, all import directives must appear before any code declarations.
2. The `_getToken` method is called in `lib/screens/ProfileCompletionPage.dart` but is not defined in the `_ProfileCompletionPageState` class.

Here's how you can resolve these issues:

### 1. Correct the import order in `lib/utils.dart`
Make sure your `lib/utils.dart` file has the import statements at the top, before any other code:

```dart
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

// Rest of your utils.dart file...
```

### 2. Define the `_getToken` method
You need to define a method called `_getToken` that retrieves the authentication token. This is typically stored in secure storage or in your app's state management solution. For example, if you're using `flutter_secure_storage` to store the token, the `_getToken` method might look like this:

```dart
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

// Inside the _ProfileCompletionPageState class
Future<String> _getToken() async {
  const storage = FlutterSecureStorage();
  String? token = await storage.read(key: 'authToken');
  return token ?? ''; // Return an empty string if the token is null
}
```

Include this method in your `_ProfileCompletionPageState` class where you're trying to use `_getToken`.

After making these corrections, try running your app again. If there are still issues, ensure that all methods and variables are correctly defined and that the import statements are correctly placed at the top of your Dart files.


the get token function is in the /services/Auth.dart file

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:superheromobile/models/user.dart';
import 'package:superheromobile/services/UserDetails.dart';
import 'package:superheromobile/theme.dart';
import 'package:superheromobile/services/Auth.dart';

class ProfileCompletionPage extends StatefulWidget {
  @override
  _ProfileCompletionPageState createState() => _ProfileCompletionPageState();
}

class _ProfileCompletionPageState extends State<ProfileCompletionPage> {
  //we need to get the token from secure storage using the _getToken() function from the Auth.dart file
  

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
      // Get the auth token from secure storage or wherever it is stored
      final String token = await _getToken();

      bool success = await updateUserDetails(
          token,
          User(
            id: userModel.currentUser!.id,
            name: _name,
            email: userModel.currentUser!.email,
            age: _age,
            height: _height,
            gender: _gender,
            isMetric: userModel.currentUser!.isMetric,
            ffmi: userModel.currentUser!.ffmi,
          ));

      if (success) {
        // Pop the page and return true to indicate successful profile completion
        Navigator.of(context).pop(true);
      } else {
        // Handle error, maybe show a Snackbar with the error message
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(
        title: Text('Complete Your Profile'),
        backgroundColor: theme.primaryColor,
      ),
      body: Form(
        key: _formKey,
        child: ListView(
          padding: EdgeInsets.all(16),
          children: [
            TextFormField(
              initialValue: _name,
              decoration: InputDecoration(labelText: 'Name'),
              validator: (value) => value!.isEmpty ? 'Name is required' : null,
              onSaved: (value) => _name = value!,
            ),
            TextFormField(
              initialValue: _age.toString(),
              decoration: InputDecoration(labelText: 'Age'),
              keyboardType: TextInputType.number,
              validator: (value) => value!.isEmpty ? 'Age is required' : null,
              onSaved: (value) => _age = int.parse(value!),
            ),
            TextFormField(
              initialValue: _height.toString(),
              decoration: InputDecoration(labelText: 'Height'),
              keyboardType: TextInputType.number,
              validator: (value) =>
                  value!.isEmpty ? 'Height is required' : null,
              onSaved: (value) => _height = double.parse(value!),
            ),
            DropdownButtonFormField(
              value: _gender,
              decoration: InputDecoration(labelText: 'Gender'),
              items: ['unknown', 'male', 'female', 'other']
                  .map((label) => DropdownMenuItem(
                        child: Text(label),
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
            ElevatedButton(
              child: Text('Save Profile'),
              onPressed: _saveProfile,
            ),
          ],
        ),
      ),
    );
  }
}



If the `_getToken` function is located in the `Auth.dart` file within the `services` directory, you should import that service and use the function directly. Here's how you can update your `_saveProfile` method to use `_getToken` from `Auth.dart`:

First, make sure the `_getToken` function in `Auth.dart` is exposed correctly. It should be a static method or part of a class that's instantiated in your `ProfileCompletionPage`.

For example, in `Auth.dart` you might have:

```dart
class AuthService {
  static Future<String> getToken() async {
    // Logic to retrieve token from secure storage
  }
}
```

Then in your `ProfileCompletionPage`, you'd call it like this:

```dart
import 'package:superheromobile/services/Auth.dart';

class _ProfileCompletionPageState extends State<ProfileCompletionPage> {
  // ... other code ...

  void _saveProfile() async {
    if (_formKey.currentState!.validate()) {
      _formKey.currentState!.save();
      final userModel = Provider.of<UserModel>(context, listen: false);

      // Use the AuthService to get the token
      final String token = await AuthService.getToken();

      // ... rest of your code for saving profile ...
    }
  }

  // ... rest of your class ...
}
```

Make sure that `AuthService.getToken()` is returning the correct token from secure storage. Depending on how you've implemented secure storage access in `Auth.dart`, you may need to adjust the above code to fit your implementation.

With this change, the `ProfileCompletionPage` will use the `_getToken` method from `Auth.dart` to retrieve the token when saving the user profile details.


ok great


Excellent! If you've incorporated the `_getToken` function from your `AuthService` correctly and the rest of your code is set up to handle the user profile update, you should be able to save user details to your server now.

Remember to handle any possible exceptions that may occur during the HTTP request, and provide feedback to the user accordingly. It's also important to ensure that the user's data is being sent securely and that your server is set up to handle the update requests properly.

If you encounter any more issues or have further questions as you continue developing your application, feel free to ask. Good luck with your app development!


ok i need to test in postman. how can i get a bearer token to test


To test API requests with authentication in Postman, you need to obtain a Bearer token that you can include in the Authorization header of your requests. Here's a general process for getting a Bearer token using Laravel Sanctum for API authentication:

1. **Create a User**: Make sure you have a user in your database that you can use to authenticate.

2. **Set Up Laravel Sanctum**: Ensure Laravel Sanctum is correctly set up in your Laravel application. This typically involves publishing the Sanctum configuration and running migrations.

3. **Login Route**: Use the login route you have set up in your `routes/api.php` to obtain a token. This route should be hitting a method in your `ApiAuthController` that authenticates the user and returns a token. The method might look something like this:

   ```php
   public function login(Request $request)
   {
       $request->validate([
           'email' => 'required|email',
           'password' => 'required',
       ]);

       $user = User::where('email', $request->email)->first();

       if (!$user || !Hash::check($request->password, $user->password)) {
           return response()->json([
               'message' => 'The provided credentials are incorrect.'
           ], 401);
       }

       return $user->createToken('authToken')->plainTextToken;
   }
   ```

4. **Test Login in Postman**: Open Postman and create a new POST request to your login endpoint (e.g., `http://your-api-domain.com/api/login`). Include the user's email and password in the body of the request, set the body type to `x-www-form-urlencoded` or `raw` (with JSON payload), and send the request.

5. **Obtain the Token**: If the login is successful, the response should include the Bearer token. Copy this token.

6. **Use the Token for Authenticated Requests**: For subsequent requests that require authentication, include an Authorization header with the value `Bearer <token>`, replacing `<token>` with the token you obtained from the login response.

Here’s how to set the Authorization header in Postman:

- In Postman, go to the Headers section of your request.
- Add a new header with the key `Authorization`.
- Set the value to `Bearer <your_token_here>`, pasting the actual token you received.

Now you can send requests that require authentication in Postman. Remember to replace placeholders like `http://your-api-domain.com/api/login` with your actual API endpoint and ensure your environment is set up to handle these requests.


this is already setup

// Send login request
      var url = Uri.parse('https://superheromode.com/api/login');
      var response = await http.post(url, body: {
        'email': email,
        'password': password,
      });


works i just need to to put it in postman


Great! If you already have the login logic set up and working, you can replicate the request in Postman to obtain a Bearer token. Here's how to do it step by step:

1. **Open Postman**: Launch the Postman application.

2. **Create a New Request**:
    - Click on the "New" button or the "+" tab to create a new request tab.
    - Set the HTTP method to `POST`.
    - Enter your login URL, which in your case is `https://superheromode.com/api/login`.

3. **Enter Request Body**:
    - Go to the "Body" tab below the URL field.
    - Select `x-www-form-urlencoded` or `raw` (if you select `raw`, make sure to choose `JSON` from the dropdown that appears to the right of the options).
    - Enter the key-value pairs for `email` and `password`, with the actual credentials you want to use for the test.

4. **Send the Request**:
    - Click the "Send" button to make the request.

5. **Obtain the Token**:
    - If the credentials are correct, the response body will include the Bearer token.
    - Copy the token from the response.

6. **Use the Token for Further Requests**:
    - When creating new requests that require authentication, go to the "Authorization" tab.
    - Choose the "Bearer Token" type from the dropdown menu.
    - Paste the token you copied into the "Token" field.

7. **Send Authenticated Request**:
    - Add any other necessary headers, parameters, or body content for your authenticated request.
    - Click "Send" to make the authenticated request.

Remember to handle your credentials securely, and do not share your real credentials or tokens in public forums or where they might be compromised.
