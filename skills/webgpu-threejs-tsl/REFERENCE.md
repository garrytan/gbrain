# TSL Quick Reference

## Imports

```javascript
// WebGPU Three.js
import * as THREE from 'three/webgpu';

// Core TSL
import {
  float, int, uint, bool,
  vec2, vec3, vec4, color,
  mat2, mat3, mat4,
  uniform, texture, uv,
  Fn, If, Loop, Break, Continue,
  time, deltaTime
} from 'three/tsl';
```

## Types

| TSL | WGSL | Example |
|-----|------|---------|
| `float(1.0)` | `f32` | Scalar float |
| `int(1)` | `i32` | Signed integer |
| `uint(1)` | `u32` | Unsigned integer |
| `bool(true)` | `bool` | Boolean |
| `vec2(x, y)` | `vec2<f32>` | 2D vector |
| `vec3(x, y, z)` | `vec3<f32>` | 3D vector |
| `vec4(x, y, z, w)` | `vec4<f32>` | 4D vector |
| `color(0xff0000)` | `vec3<f32>` | RGB color |
| `uniform(value)` | uniform | Dynamic value |

## Operators

| Operation | TSL | GLSL Equivalent |
|-----------|-----|-----------------|
| Add | `a.add(b)` | `a + b` |
| Subtract | `a.sub(b)` | `a - b` |
| Multiply | `a.mul(b)` | `a * b` |
| Divide | `a.div(b)` | `a / b` |
| Modulo | `a.mod(b)` | `mod(a, b)` |
| Negate | `a.negate()` | `-a` |
| Less Than | `a.lessThan(b)` | `a < b` |
| Greater Than | `a.greaterThan(b)` | `a > b` |
| Equal | `a.equal(b)` | `a == b` |
| And | `a.and(b)` | `a && b` |
| Or | `a.or(b)` | `a \|\| b` |
| Assign | `a.assign(b)` | `a = b` |
| Add Assign | `a.addAssign(b)` | `a += b` |

## Swizzling

```javascript
const v = vec3(1, 2, 3);
v.x        // 1
v.xy       // vec2(1, 2)
v.zyx      // vec3(3, 2, 1)
v.rgb      // same as xyz
```

## Math Functions

| Function | Description |
|----------|-------------|
| `abs(x)` | Absolute value |
| `sign(x)` | Sign (-1, 0, 1) |
| `floor(x)` | Round down |
| `ceil(x)` | Round up |
| `fract(x)` | Fractional part |
| `min(a, b)` | Minimum |
| `max(a, b)` | Maximum |
| `clamp(x, lo, hi)` | Clamp to range |
| `mix(a, b, t)` | Linear interpolation |
| `step(edge, x)` | Step function |
| `smoothstep(a, b, x)` | Smooth step |
| `sin(x)`, `cos(x)` | Trigonometry |
| `pow(x, y)` | Power |
| `sqrt(x)` | Square root |
| `length(v)` | Vector length |
| `distance(a, b)` | Distance |
| `dot(a, b)` | Dot product |
| `cross(a, b)` | Cross product |
| `normalize(v)` | Unit vector |
| `reflect(i, n)` | Reflection |

## Geometry Nodes

| Node | Description |
|------|-------------|
| `positionLocal` | Model space position |
| `positionWorld` | World space position |
| `positionView` | Camera space position |
| `normalLocal` | Model space normal |
| `normalWorld` | World space normal |
| `normalView` | Camera space normal |
| `uv()` | UV coordinates |
| `uv(1)` | Secondary UVs |
| `tangentLocal` | Tangent vector |
| `vertexColor()` | Vertex colors |

## Camera Nodes

| Node | Description |
|------|-------------|
| `cameraPosition` | Camera world position |
| `cameraNear` | Near plane |
| `cameraFar` | Far plane |
| `cameraViewMatrix` | View matrix |
| `cameraProjectionMatrix` | Projection matrix |
| `screenUV` | Screen UV (0-1) |
| `screenSize` | Screen dimensions |

## Time

| Node | Description |
|------|-------------|
| `time` | Seconds since start |
| `deltaTime` | Frame delta |
| `oscSine(t)` | Sine wave (0-1) |
| `oscSquare(t)` | Square wave |
| `oscTriangle(t)` | Triangle wave |
| `oscSawtooth(t)` | Sawtooth wave |

## Material Properties

```javascript
const mat = new THREE.MeshStandardNodeMaterial();

// Basic
mat.colorNode = color(0xff0000);
mat.opacityNode = float(0.8);
mat.alphaTestNode = float(0.5);

// PBR
mat.roughnessNode = float(0.5);
mat.metalnessNode = float(0.0);
mat.emissiveNode = color(0x000000);
mat.normalNode = normalMap(tex);

// Physical (MeshPhysicalNodeMaterial)
mat.clearcoatNode = float(1.0);
mat.transmissionNode = float(0.9);
mat.iridescenceNode = float(1.0);
mat.sheenNode = float(1.0);

// Vertex
mat.positionNode = displaced;
```

## Control Flow

```javascript
// If-Else
If(condition, () => {
  // true
}).ElseIf(other, () => {
  // other true
}).Else(() => {
  // false
});

// Select (ternary)
const result = select(condition, trueVal, falseVal);

// Loop
Loop(10, ({ i }) => {
  // i = 0 to 9
});

// Loop control
Break();
Continue();
Discard();  // Fragment only
```

## Custom Functions

```javascript
// Basic function
const myFn = Fn(([a, b]) => {
  return a.add(b);
});

// With defaults
const myFn = Fn(([a = 1.0, b = 2.0]) => {
  return a.add(b);
});

// Usage
myFn(x, y);
myFn();  // uses defaults
```

## Compute Shaders

```javascript
// Storage buffers (read-write)
const positions = instancedArray(count, 'vec3');
const values = instancedArray(count, 'float');

// Read-only storage buffers
const lookupTable = attributeArray(data, 'float');

// Compute shader
const compute = Fn(() => {
  const pos = positions.element(instanceIndex);
  pos.addAssign(vec3(0.01, 0, 0));
})().compute(count);

// Execute (after await renderer.init())
renderer.compute(compute);

// Workgroup size
const compute2 = Fn(() => { /* ... */ })().compute(count, [64]);
```

## Post-Processing

```javascript
import { pass } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';

// Setup (RenderPipeline replaced PostProcessing in r183)
const renderPipeline = new THREE.RenderPipeline(renderer);
const scenePass = pass(scene, camera);
const color = scenePass.getTextureNode('output');

// Apply effects
const bloomPass = bloom(color);
renderPipeline.outputNode = color.add(bloomPass);

// Render
renderPipeline.render();
```

## Common Patterns

### Fresnel

```javascript
const viewDir = cameraPosition.sub(positionWorld).normalize();
const fresnel = float(1).sub(normalWorld.dot(viewDir).saturate()).pow(3);
```

### Animated UV

```javascript
const animUV = uv().add(vec2(time.mul(0.1), 0));
```

### Noise Hash

```javascript
const noise = fract(position.dot(vec3(12.9898, 78.233, 45.543)).sin().mul(43758.5453));
```

### Dissolve

```javascript
const noise = hash(positionLocal.mul(50));
If(noise.lessThan(threshold), () => Discard());
```

### Color Gradient

```javascript
const gradient = mix(colorA, colorB, positionLocal.y.mul(0.5).add(0.5));
```

## Node Materials

| Material | Use Case |
|----------|----------|
| `MeshBasicNodeMaterial` | Unlit |
| `MeshStandardNodeMaterial` | PBR |
| `MeshPhysicalNodeMaterial` | Advanced PBR |
| `MeshPhongNodeMaterial` | Phong shading |
| `MeshToonNodeMaterial` | Cel shading |
| `PointsNodeMaterial` | Point clouds |
| `LineBasicNodeMaterial` | Lines |
| `SpriteNodeMaterial` | Sprites |

## Device Loss Handling

```javascript
// Listen for device loss
renderer.backend.device.lost.then((info) => {
  if (info.reason === 'unknown') {
    // Unexpected loss - recover
    renderer.dispose();
    initWebGPU();  // Reinitialize
  }
});

// Simulate loss for testing
renderer.backend.device.destroy();
```

| Loss Reason | Meaning |
|-------------|---------|
| `'destroyed'` | Intentional via `destroy()` |
| `'unknown'` | Unexpected (driver crash, timeout, etc.) |

**Recovery tips:**
- Always get fresh adapter before new device
- Save/restore application state (not transient data)
- Use Chrome `about:gpucrash` to test real GPU crashes

## Compute Shader Built-ins

| Node | Description |
|------|-------------|
| `instanceIndex` | Current instance/invocation index |
| `vertexIndex` | Current vertex index |
| `drawIndex` | Current draw call index |
| `globalId` | Global invocation position (uvec3) |
| `localId` | Local workgroup position (uvec3) |
| `workgroupId` | Workgroup index (uvec3) |
| `numWorkgroups` | Number of workgroups dispatched (uvec3) |
| `subgroupSize` | Size of the subgroup |

## Device Limits

WebGPU devices use **default minimums** unless you request higher limits. This is critical for large buffers.

```javascript
// Three.js: pass requiredLimits to the renderer
const renderer = new THREE.WebGPURenderer({
  requiredLimits: {
    maxBufferSize: 1024 * 1024 * 1024,            // 1 GiB
    maxStorageBufferBindingSize: 1024 * 1024 * 512, // 512 MiB
  },
});
await renderer.init();
```

| Limit | Default | Common Need |
|-------|---------|-------------|
| `maxBufferSize` | 256 MiB | Large vertex/storage buffers |
| `maxStorageBufferBindingSize` | 128 MiB | Large compute buffers |
| `maxStorageBuffersPerShaderStage` | 8 | Many storage buffers |

**Check before requesting:**
```javascript
const adapter = await navigator.gpu?.requestAdapter();
if (adapter.limits.maxBufferSize >= desiredSize) {
  // Safe to request
}
```

See `docs/limits-and-features.md` for full details.

## Version Notes

**r178+:**
- `PI2` is deprecated → use `TWO_PI`
- `transformedNormalView` → use `normalView`
- `transformedNormalWorld` → use `normalWorld`

**r171+:**
- Recommended minimum version for stable TSL
- Requires separate `three/webgpu` import map entry

## Resources

- [TSL Wiki](https://github.com/mrdoob/three.js/wiki/Three.js-Shading-Language)
- [TSL Docs](https://threejs.org/docs/pages/TSL.html)
- [WebGPU Examples](https://github.com/mrdoob/three.js/tree/master/examples)
- [Three.js Docs](https://threejs.org/docs/)
- [WebGPU Best Practices - Device Loss](https://toji.dev/webgpu-best-practices/device-loss)
