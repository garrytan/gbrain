# TSL Core Concepts

## Types and Constructors

### Scalar Types
```javascript
import { float, int, uint, bool } from 'three/tsl';

const f = float(1.0);
const i = int(42);
const u = uint(100);
const b = bool(true);
```

### Vector Types
```javascript
import { vec2, vec3, vec4, color } from 'three/tsl';

const v2 = vec2(1.0, 2.0);
const v3 = vec3(1.0, 2.0, 3.0);
const v4 = vec4(1.0, 2.0, 3.0, 1.0);

// Color (RGB, accepts hex or components)
const c = color(0xff0000);     // Red
const c2 = color(1, 0.5, 0);   // Orange
```

### Matrix Types
```javascript
import { mat2, mat3, mat4 } from 'three/tsl';

const m3 = mat3();
const m4 = mat4();
```

### Type Conversion
```javascript
const v = vec3(1, 2, 3);
const v4 = v.toVec4(1.0);      // vec4(1, 2, 3, 1)
const f = int(42).toFloat();   // 42.0
const c = v.toColor();         // Convert to color
```

## Vector Swizzling

Access and reorder vector components using standard notation:

```javascript
const v = vec3(1.0, 2.0, 3.0);

// Single component access
v.x  // 1.0
v.y  // 2.0
v.z  // 3.0

// Multiple components
v.xy   // vec2(1.0, 2.0)
v.xyz  // vec3(1.0, 2.0, 3.0)

// Reorder components
v.zyx  // vec3(3.0, 2.0, 1.0)
v.xxy  // vec3(1.0, 1.0, 2.0)
v.rrr  // vec3(1.0, 1.0, 1.0) - same as xxx

// Alternative accessors (all equivalent)
v.xyz  // position
v.rgb  // color
v.stp  // texture coordinates
```

## Uniforms

Uniforms pass values from JavaScript to shaders:

```javascript
import { uniform } from 'three/tsl';
import * as THREE from 'three/webgpu';

// Create uniforms
const myColor = uniform(new THREE.Color(0x0066ff));
const myFloat = uniform(0.5);
const myVec3 = uniform(new THREE.Vector3(1, 2, 3));

// Update at runtime
myColor.value.set(0xff0000);
myFloat.value = 0.8;
myVec3.value.set(4, 5, 6);

// Use in material
material.colorNode = myColor;
```

### Auto-Updating Uniforms

```javascript
// Update every frame
const animatedValue = uniform(0).onFrameUpdate((frame) => {
  return Math.sin(frame.time);
});

// Update per object render
const perObjectValue = uniform(0).onObjectUpdate((object) => {
  return object.userData.customValue;
});

// Update once per render cycle
const renderValue = uniform(0).onRenderUpdate((state) => {
  return state.delta;
});
```

## Operators

### Arithmetic
```javascript
// Method chaining (preferred)
const result = a.add(b).mul(c).sub(d).div(e);

// Individual operations
a.add(b)   // a + b
a.sub(b)   // a - b
a.mul(b)   // a * b
a.div(b)   // a / b
a.mod(b)   // a % b
a.negate() // -a
```

### Comparison
```javascript
a.equal(b)            // a == b
a.notEqual(b)         // a != b
a.lessThan(b)         // a < b
a.greaterThan(b)      // a > b
a.lessThanEqual(b)    // a <= b
a.greaterThanEqual(b) // a >= b
```

### Logical
```javascript
a.and(b)   // a && b
a.or(b)    // a || b
a.not()    // !a
a.xor(b)   // a ^ b
```

### Bitwise
```javascript
a.bitAnd(b)      // a & b
a.bitOr(b)       // a | b
a.bitXor(b)      // a ^ b
a.bitNot()       // ~a
a.shiftLeft(n)   // a << n
a.shiftRight(n)  // a >> n
```

### Assignment (for variables)
```javascript
const v = vec3(0).toVar();  // Create mutable variable

v.assign(vec3(1, 2, 3));    // v = vec3(1, 2, 3)
v.addAssign(vec3(1));       // v += vec3(1)
v.subAssign(vec3(1));       // v -= vec3(1)
v.mulAssign(2.0);           // v *= 2.0
v.divAssign(2.0);           // v /= 2.0
```

## Variables

### Mutable Variables
```javascript
// Create mutable variable with toVar()
const myVar = vec3(1, 0, 0).toVar();
myVar.assign(vec3(0, 1, 0));
myVar.addAssign(vec3(0, 0, 1));

// Name the variable (useful for debugging)
const named = vec3(0).toVar('myPosition');
```

### Constants
```javascript
// Create compile-time constant
const PI_HALF = float(Math.PI / 2).toConst();
```

### Properties (named values for shader stages)
```javascript
import { property } from 'three/tsl';

// Create named property
const myProp = property('vec3', 'customColor');
myProp.assign(vec3(1, 0, 0));
```

## Control Flow

### ⚠️ CRITICAL: Property Assignment vs Variable Reassignment

**TSL intercepts property assignments on nodes, but NOT JavaScript variable reassignment.**

| Pattern | Works? | Why |
|---------|--------|-----|
| `node.y = value` | ✅ | Property setter - TSL intercepts |
| `node.x.assign(value)` | ✅ | TSL method call |
| `variable = variable.add(1)` | ❌ | JS variable reassignment |

**This WORKS (vec3 property assignment):**
```javascript
const result = vec3(position);
If(result.y.greaterThan(limit), () => {
  result.y = limit;  // ✅ Property assignment - TSL intercepts!
});
```

**This DOES NOT work (scalar variable reassignment):**
```javascript
let value = buffer.element(index).toFloat();  // Scalar - no .x/.y properties
If(condition, () => {
  value = value.add(1.0);  // ❌ JS variable reassignment - TSL can't see this!
});
return value;  // Returns ORIGINAL node!
```

**Solutions for scalars:**
```javascript
// ✅ Use select() for conditional values
const result = select(condition, valueIfTrue, valueIfFalse);

// ✅ Use .toVar() for mutable variables
const value = buffer.element(index).toVar();
If(condition, () => {
  value.assign(value.add(1.0));  // Works with .toVar()!
});

// ✅ Use direct .assign() on buffer elements
If(condition, () => {
  element.assign(element.add(1.0));  // Direct buffer writes work!
});
```

### Conditionals

```javascript
import { If, select } from 'three/tsl';

// If-ElseIf-Else (use with .toVar() or direct .assign())
const result = vec3(0).toVar();

If(value.greaterThan(0.5), () => {
  result.assign(vec3(1, 0, 0));  // Red
}).ElseIf(value.greaterThan(0.25), () => {
  result.assign(vec3(0, 1, 0));  // Green
}).Else(() => {
  result.assign(vec3(0, 0, 1));  // Blue
});

// Ternary operator (select) - PREFERRED for simple conditionals
const color = select(
  condition,           // if true
  vec3(1, 0, 0),      // return this
  vec3(0, 0, 1)       // else return this
);
```

### Switch-Case

```javascript
import { Switch } from 'three/tsl';

const col = vec3(0).toVar();

Switch(intValue)
  .Case(0, () => { col.assign(color(1, 0, 0)); })
  .Case(1, () => { col.assign(color(0, 1, 0)); })
  .Case(2, () => { col.assign(color(0, 0, 1)); })
  .Default(() => { col.assign(color(1, 1, 1)); });
```

### Loops

```javascript
import { Loop, Break, Continue } from 'three/tsl';

// Simple loop (0 to 9)
const sum = float(0).toVar();
Loop(10, ({ i }) => {
  sum.addAssign(float(i));
});

// Ranged loop with options
Loop({ start: int(0), end: int(count), type: 'int' }, ({ i }) => {
  // Loop body
});

// Nested loops
Loop(width, height, ({ i, j }) => {
  // i = outer loop index
  // j = inner loop index
});

// Loop control
Loop(100, ({ i }) => {
  If(shouldStop, () => {
    Break();  // Exit loop
  });
  If(shouldSkip, () => {
    Continue();  // Skip to next iteration
  });
});
```

### Flow Control

```javascript
import { Discard, Return } from 'three/tsl';

// Discard fragment (make transparent)
If(alpha.lessThan(0.5), () => {
  Discard();
});

// Return from function
const myFn = Fn(() => {
  If(condition, () => {
    Return(vec3(1, 0, 0));
  });
  return vec3(0, 0, 1);
});
```

## Custom Functions with Fn()

### Basic Function
```javascript
import { Fn } from 'three/tsl';

const addVectors = Fn(([a, b]) => {
  return a.add(b);
});

// Usage
const result = addVectors(vec3(1, 0, 0), vec3(0, 1, 0));
```

### Default Parameters
```javascript
const oscillate = Fn(([frequency = 1.0, amplitude = 1.0]) => {
  return time.mul(frequency).sin().mul(amplitude);
});

// Call variations
oscillate();           // Uses defaults
oscillate(2.0);        // frequency = 2.0
oscillate(2.0, 0.5);   // frequency = 2.0, amplitude = 0.5
```

### Named Parameters (Object Style)
```javascript
const createGradient = Fn(({ colorA = vec3(0), colorB = vec3(1), t = 0.5 }) => {
  return mix(colorA, colorB, t);
});

// Call with named parameters
createGradient({ colorA: vec3(1, 0, 0), t: uv().x });
```

### Function with Context
```javascript
// Access shader context
const customShader = Fn(({ material, geometry, object }) => {
  if (material.userData.customColor) {
    return uniform(material.userData.customColor);
  }
  return vec3(1);
});
```

## Time and Animation

```javascript
import { time, deltaTime } from 'three/tsl';

// time - seconds since start
const rotation = time.mul(0.5);  // Half rotation per second

// deltaTime - time since last frame
const velocity = speed.mul(deltaTime);
```

### Oscillators

```javascript
import { oscSine, oscSquare, oscTriangle, oscSawtooth } from 'three/tsl';

// All oscillators return 0-1 range
oscSine(time)      // Smooth sine wave
oscSquare(time)    // Square wave (0 or 1)
oscTriangle(time)  // Triangle wave
oscSawtooth(time)  // Sawtooth wave

// Custom frequency
oscSine(time.mul(2.0))  // 2Hz oscillation
```

## Math Functions

### Basic Math
```javascript
import { abs, sign, floor, ceil, fract, mod, min, max, clamp } from 'three/tsl';

abs(x)           // Absolute value
sign(x)          // -1, 0, or 1
floor(x)         // Round down
ceil(x)          // Round up
fract(x)         // Fractional part (x - floor(x))
mod(x, y)        // Modulo
min(x, y)        // Minimum
max(x, y)        // Maximum
clamp(x, 0, 1)   // Clamp to range
```

### Trigonometry
```javascript
import { sin, cos, tan, asin, acos, atan, atan2 } from 'three/tsl';

sin(x)
cos(x)
tan(x)
asin(x)
acos(x)
atan(x)
atan2(y, x)
```

### Exponential
```javascript
import { pow, exp, log, sqrt, inverseSqrt } from 'three/tsl';

pow(x, 2.0)      // x^2
exp(x)           // e^x
log(x)           // Natural log
sqrt(x)          // Square root
inverseSqrt(x)   // 1 / sqrt(x)
```

### Interpolation
```javascript
import { mix, step, smoothstep } from 'three/tsl';

mix(a, b, 0.5)              // Linear interpolation
step(0.5, x)                // 0 if x < 0.5, else 1
smoothstep(0.0, 1.0, x)     // Smooth 0-1 transition
```

### Vector Math
```javascript
import { length, distance, dot, cross, normalize, reflect, refract } from 'three/tsl';

length(v)              // Vector length
distance(a, b)         // Distance between points
dot(a, b)              // Dot product
cross(a, b)            // Cross product (vec3 only)
normalize(v)           // Unit vector
reflect(incident, normal)
refract(incident, normal, eta)
```

### Constants
```javascript
import { PI, TWO_PI, HALF_PI, EPSILON } from 'three/tsl';

PI        // 3.14159...
TWO_PI    // 6.28318...
HALF_PI   // 1.57079...
EPSILON   // Very small number
```

## Utility Functions

```javascript
import { hash, checker, remap, range, rotate } from 'three/tsl';

// Pseudo-random hash
hash(seed)                    // Returns 0-1

// Checkerboard pattern
checker(uv())                 // Returns 0 or 1

// Remap value from one range to another
remap(x, 0, 1, -1, 1)        // Map 0-1 to -1 to 1

// Generate value in range
range(min, max)               // Random in range (per instance)

// Rotate 2D vector
rotate(vec2(1, 0), angle)
```
