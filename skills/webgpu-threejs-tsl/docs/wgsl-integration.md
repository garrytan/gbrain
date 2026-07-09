# WGSL Integration

TSL allows embedding raw WGSL (WebGPU Shading Language) code when you need direct GPU control.

## wgslFn - Custom WGSL Functions

### Basic Usage

```javascript
import { wgslFn, float, vec3 } from 'three/tsl';

// Define WGSL function
const gammaCorrect = wgslFn(`
  fn gammaCorrect(color: vec3<f32>, gamma: f32) -> vec3<f32> {
    return pow(color, vec3<f32>(1.0 / gamma));
  }
`);

// Use in TSL
material.colorNode = gammaCorrect(inputColor, float(2.2));
```

### Function with Multiple Parameters

```javascript
const blendColors = wgslFn(`
  fn blendColors(a: vec3<f32>, b: vec3<f32>, t: f32) -> vec3<f32> {
    return mix(a, b, t);
  }
`);

material.colorNode = blendColors(colorA, colorB, blendFactor);
```

### Advanced Math Functions

```javascript
const fresnelSchlick = wgslFn(`
  fn fresnelSchlick(cosTheta: f32, F0: vec3<f32>) -> vec3<f32> {
    return F0 + (vec3<f32>(1.0) - F0) * pow(1.0 - cosTheta, 5.0);
  }
`);

const GGX = wgslFn(`
  fn distributionGGX(N: vec3<f32>, H: vec3<f32>, roughness: f32) -> f32 {
    let a = roughness * roughness;
    let a2 = a * a;
    let NdotH = max(dot(N, H), 0.0);
    let NdotH2 = NdotH * NdotH;

    let num = a2;
    let denom = (NdotH2 * (a2 - 1.0) + 1.0);
    denom = 3.14159265359 * denom * denom;

    return num / denom;
  }
`);
```

### Noise Functions

```javascript
const simplexNoise = wgslFn(`
  fn mod289(x: vec3<f32>) -> vec3<f32> {
    return x - floor(x * (1.0 / 289.0)) * 289.0;
  }

  fn permute(x: vec3<f32>) -> vec3<f32> {
    return mod289(((x * 34.0) + 1.0) * x);
  }

  fn snoise(v: vec2<f32>) -> f32 {
    let C = vec4<f32>(
      0.211324865405187,
      0.366025403784439,
      -0.577350269189626,
      0.024390243902439
    );

    var i = floor(v + dot(v, C.yy));
    let x0 = v - i + dot(i, C.xx);

    var i1: vec2<f32>;
    if (x0.x > x0.y) {
      i1 = vec2<f32>(1.0, 0.0);
    } else {
      i1 = vec2<f32>(0.0, 1.0);
    }

    var x12 = x0.xyxy + C.xxzz;
    x12 = vec4<f32>(x12.xy - i1, x12.zw);

    i = mod289(vec3<f32>(i, 0.0)).xy;
    let p = permute(permute(i.y + vec3<f32>(0.0, i1.y, 1.0)) + i.x + vec3<f32>(0.0, i1.x, 1.0));

    var m = max(vec3<f32>(0.5) - vec3<f32>(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), vec3<f32>(0.0));
    m = m * m;
    m = m * m;

    let x = 2.0 * fract(p * C.www) - 1.0;
    let h = abs(x) - 0.5;
    let ox = floor(x + 0.5);
    let a0 = x - ox;

    m = m * (1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h));

    let g = vec3<f32>(
      a0.x * x0.x + h.x * x0.y,
      a0.y * x12.x + h.y * x12.y,
      a0.z * x12.z + h.z * x12.w
    );

    return 130.0 * dot(m, g);
  }
`);

// Use noise
const noiseValue = simplexNoise(uv().mul(10.0));
```

### FBM (Fractal Brownian Motion)

```javascript
const fbm = wgslFn(`
  fn fbm(p: vec2<f32>, octaves: i32) -> f32 {
    var value = 0.0;
    var amplitude = 0.5;
    var frequency = 1.0;
    var pos = p;

    for (var i = 0; i < octaves; i = i + 1) {
      value = value + amplitude * snoise(pos * frequency);
      amplitude = amplitude * 0.5;
      frequency = frequency * 2.0;
    }

    return value;
  }
`);
```

## WGSL Types Reference

### Scalar Types
```wgsl
bool        // Boolean
i32         // 32-bit signed integer
u32         // 32-bit unsigned integer
f32         // 32-bit float
f16         // 16-bit float (if enabled)
```

### Vector Types
```wgsl
vec2<f32>   // 2D float vector
vec3<f32>   // 3D float vector
vec4<f32>   // 4D float vector
vec2<i32>   // 2D integer vector
vec2<u32>   // 2D unsigned integer vector
```

### Matrix Types
```wgsl
mat2x2<f32> // 2x2 matrix
mat3x3<f32> // 3x3 matrix
mat4x4<f32> // 4x4 matrix
mat2x3<f32> // 2 columns, 3 rows
```

### Texture Types
```wgsl
texture_2d<f32>
texture_3d<f32>
texture_cube<f32>
texture_storage_2d<rgba8unorm, write>
```

## WGSL Syntax Reference

### Variables
```wgsl
let x = 1.0;              // Immutable
var y = 2.0;              // Mutable
const PI = 3.14159;       // Compile-time constant
```

### Control Flow
```wgsl
// If-else
if (condition) {
  // ...
} else if (other) {
  // ...
} else {
  // ...
}

// For loop
for (var i = 0; i < 10; i = i + 1) {
  // ...
}

// While loop
while (condition) {
  // ...
}

// Switch
switch (value) {
  case 0: { /* ... */ }
  case 1, 2: { /* ... */ }
  default: { /* ... */ }
}
```

### Built-in Functions
```wgsl
// Math
abs(x), sign(x), floor(x), ceil(x), round(x)
fract(x), trunc(x)
min(a, b), max(a, b), clamp(x, lo, hi)
mix(a, b, t), step(edge, x), smoothstep(lo, hi, x)
sin(x), cos(x), tan(x), asin(x), acos(x), atan(x), atan2(y, x)
pow(x, y), exp(x), log(x), exp2(x), log2(x)
sqrt(x), inverseSqrt(x)

// Vector
length(v), distance(a, b)
dot(a, b), cross(a, b)
normalize(v), faceForward(n, i, nref)
reflect(i, n), refract(i, n, eta)

// Matrix
transpose(m), determinant(m)

// Texture
textureSample(t, s, coord)
textureLoad(t, coord, level)
textureStore(t, coord, value)
textureDimensions(t)
```

## Combining TSL and WGSL

### TSL Wrapper for WGSL

```javascript
import { Fn, wgslFn, float, vec2, vec3 } from 'three/tsl';

// WGSL implementation
const wgslNoise = wgslFn(`
  fn noise2d(p: vec2<f32>) -> f32 {
    return fract(sin(dot(p, vec2<f32>(12.9898, 78.233))) * 43758.5453);
  }
`);

// TSL wrapper with nice API
const noise = Fn(([position, scale = 1.0]) => {
  return wgslNoise(position.xy.mul(scale));
});

// Use
material.colorNode = vec3(noise(positionWorld, 10.0));
```

### Hybrid Approach

```javascript
// Complex math in WGSL
const complexMath = wgslFn(`
  fn complexOperation(a: vec3<f32>, b: vec3<f32>, t: f32) -> vec3<f32> {
    let blended = mix(a, b, t);
    let rotated = vec3<f32>(
      blended.x * cos(t) - blended.y * sin(t),
      blended.x * sin(t) + blended.y * cos(t),
      blended.z
    );
    return normalize(rotated);
  }
`);

// Simple logic in TSL
const finalColor = Fn(() => {
  const base = texture(diffuseMap).rgb;
  const processed = complexMath(base, vec3(1, 0, 0), time);
  return mix(base, processed, oscSine(time));
});

material.colorNode = finalColor();
```

## Performance Tips

### Avoid Branching When Possible
```wgsl
// Instead of:
if (x > 0.5) {
  result = a;
} else {
  result = b;
}

// Use:
result = mix(b, a, step(0.5, x));
```

### Use Local Variables
```wgsl
fn compute(p: vec2<f32>) -> f32 {
  // Cache repeated calculations
  let p2 = p * p;
  let p4 = p2 * p2;
  return p2.x + p2.y + p4.x * p4.y;
}
```

### Minimize Texture Samples
```wgsl
// Sample once, use multiple times
let sample = textureSample(tex, sampler, uv);
let r = sample.r;
let g = sample.g;
let b = sample.b;
```
