Keep rules prevent optimization of R8, these rules are listed in the order of
the scope of what it retains in the codebase.

## 1. Package-Wide Wildcards

The following types of keep rules prevents all the optimization of R8 in a
package, these must be avoided at any costs and must be refined to target a
specific class or classes.

    -keep class com.example.package.** { *; } - Prevents optimization of all the classess including members in the package and subpackages
    -keep class com.example.package.* { *; } - Prevents optimization of all the classes including members in the package
    -keep class **.package.** { *; } - Prevents optimization of all the classess including members in all the package containing name - package.

Depending on the package level the number of classes gets affected changes, so
if the package level is higher, more classes are affected. Suggest to refine
the keep rule

## 2. Inversion operator

Avoid using the inversion operator ! in keep rules because it will
unintentionally prevent optimization in every class in your application. So if
you have any keep rule with !operator, make sure you remove that with a narrow
and specific keep rule

    -keep class !com.example.MyClass{*;}

This keeps the entire app
other than this class. Optimization are disabled for the entire class other
than this class.

## 3. Keep Rules for both class and members

Keep rules with -keep option and wildcard(`*`) inside braces forces R8 to retain
specific classes and their members exactly as defined. These type of keep rules
prevent any optimization in the entire class and keeps the entire class

    -keep class com.example.MyClass { *; }

## 4. Keepclassmembers

Keep rules with -keepclassmembers and wildcard(`*`) inside braces option Forces
R8 to retain the members that are defined.

    -keepclassmembers class com.example.MyClass { *; }

## 5. Modifiers with Keep Specification

-Keeps the class and **all** members, but uses modifiers to allow specific
optimizations (like obfuscation). Retains significant code (members) but allows
some flexibility.

    -keep,allowobfuscation class com.example.MyClass { *; }
    -keep,allowshrinking class com.example.MyClass { *; }

### 6. Modifiers with specific method but no modifier

Keeps the class and modifier but no optimizations are enabled

    -keep class com.example.MyClass { void myMethod(); }

## 7. Class-Name Only Preservation

Keeps only the class name. R8 will remove all methods and fields if they are not
used.

    -keep class com.example.MyClass

## 8. Modifiers without Member Specification

Keeps the class entry point using modifiers, but implies no specific member
retention logic in the rule itself

    -keep,allowobfuscation class com.example.MyClass
    -keep,allowshrinking class com.example.MyClass
    -keep,allowaccessmodification class com.example.MyClass

## 9. Conditional Keep Rules

Only triggers if specific conditions are met (e.g., if class members exist).
These are the most narrow and optimization-friendly rules.

    -keepclassmembers class com.example.MyClass { <fields>; }
    -keepclasseswithmembers class * { native <methods>; }