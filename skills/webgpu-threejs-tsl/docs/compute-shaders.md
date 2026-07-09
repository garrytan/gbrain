# TSL Compute Shaders

Compute shaders run on the GPU for parallel processing of data. TSL makes them accessible through JavaScript.

## CRITICAL: TSL Node Property Assignment vs JS Variable Reassignment

**TSL can intercept property assignments on nodes, but NOT JavaScript variable reassignment.**

### What Works vs What Doesn't

| Pattern | Works? | Why |
|---------|--------|-----|
| `node.y = value` | ✅ | Property setter - TSL intercepts |
| `node.x.assign(value)` | ✅ | TSL method call |
| `buffer.element(i).assign(v)` | ✅ | TSL method call |
| `variable = variable.add(1)` | ❌ | JS variable reassignment - TSL can't see it |

### This WORKS (property assignment on vec3):

```javascript
// ✅ CORRECT - Property assignment on node object
const computeShader = Fn(() => {
  const result = vec3(position);

  If(result.y.greaterThan(limit), () => {
    result.y = limit;  // TSL intercepts property setters!
  });

  return result;
})();
```

### This does NOT work (JS variable reassignment):

```javascript
// ❌ WRONG - JavaScript variable reassignment inside If()
const computeShader = Fn(() => {
  let value = buffer.element(index).toFloat();  // Scalar float - no .x/.y properties

  If(condition, () => {
    value = value.add(1.0);  // JS reassigns variable to NEW node - TSL can't track this!
  });

  buffer.element(index).assign(value);  // Uses ORIGINAL node, not the add result!
})().compute(count);
```

**Why it fails:** `value = value.add(1.0)` creates a new TSL node and reassigns the JavaScript variable to point to it. But TSL can't intercept JavaScript variable assignment - it can only intercept property setters and method calls on TSL node objects. Since `value` is a scalar float (no `.x`/`.y` properties), you can't use property assignment.

### Solution 1: Use `select()` for Conditional Values

```javascript
// ✅ CORRECT - Use select() for inline conditionals
import { select } from 'three/tsl';

const computeShader = Fn(() => {
  const currentValue = buffer.element(index).toFloat();

  // select(condition, valueIfTrue, valueIfFalse)
  const newValue = select(
    condition,
    currentValue.add(1.0),  // If true
    currentValue            // If false
  );

  buffer.element(index).assign(newValue);
})().compute(count);
```

### Solution 2: Use `.assign()` Directly on Buffer Elements Inside If()

```javascript
// ✅ CORRECT - Direct buffer assignment inside If() works
const computeShader = Fn(() => {
  const element = buffer.element(index);

  If(condition, () => {
    // Direct assignment to buffer element works!
    element.assign(element.add(1.0));
  });
})().compute(count);
```

### Solution 3: Use `.toVar()` for Mutable Variables

```javascript
// ✅ CORRECT - Use .toVar() for variables that need mutation
const computeShader = Fn(() => {
  // .toVar() creates a proper GPU variable that can be reassigned
  const value = buffer.element(index).toFloat().toVar();

  If(condition, () => {
    value.assign(value.add(1.0));  // This works with .toVar()!
  });

  buffer.element(index).assign(value);
})().compute(count);
```

### Quick Reference: When to Use What

| Pattern | Use Case |
|---------|----------|
| `select(cond, a, b)` | Simple conditional value selection |
| `element.assign()` inside `If()` | Direct buffer writes |
| `.toVar()` + `assign()` | Complex logic with multiple conditionals |
| Regular `If()` with direct assigns | Multiple buffer element updates |

### Example: Correct Stamp/Fade Pattern

```javascript
// ✅ CORRECT implementation of conditional stamping
const computeShader = Fn(() => {
  const currentFoam = foamBuffer.element(index).toFloat();

  // Calculate distance
  const dist = worldPos.distance(stampPos);
  const radius = float(50.0);

  // Calculate falloff (will be 0 outside radius due to select)
  const falloff = float(1.0).sub(dist.div(radius));

  // Use select() - returns falloff if inside radius, 0 if outside
  const foamToAdd = select(dist.lessThan(radius), falloff, float(0.0));

  // Combine and write
  const newFoam = max(currentFoam, foamToAdd);
  foamBuffer.element(index).assign(clamp(newFoam, 0.0, 1.0));
})().compute(bufferSize);
```

---

## Basic Setup

```javascript
import * as THREE from 'three/webgpu';
import { Fn, instancedArray, instanceIndex, vec3 } from 'three/tsl';

// Create storage buffer
const count = 100000;
const positions = instancedArray(count, 'vec3');

// Create compute shader
const computeShader = Fn(() => {
  const position = positions.element(instanceIndex);
  position.x.addAssign(0.01);
})().compute(count);

// Initialize renderer first, then use synchronous compute
await renderer.init();
renderer.compute(computeShader);
```

### Read-Only Storage Buffers

```javascript
import { attributeArray } from 'three/tsl';

// attributeArray() creates read-only storage buffers (vs instancedArray for read-write)
const lookupTable = attributeArray(data, 'float');

// Use in compute or materials - data is read-only on GPU
const value = lookupTable.element(index);
```

## Storage Buffers

### Instanced Arrays

```javascript
import { instancedArray } from 'three/tsl';

// Create typed storage buffers
const positions = instancedArray(count, 'vec3');
const velocities = instancedArray(count, 'vec3');
const colors = instancedArray(count, 'vec4');
const indices = instancedArray(count, 'uint');
const values = instancedArray(count, 'float');
```

### Accessing Elements

```javascript
const computeShader = Fn(() => {
  // Get element at current index
  const position = positions.element(instanceIndex);
  const velocity = velocities.element(instanceIndex);

  // Read values
  const x = position.x;
  const speed = velocity.length();

  // Write values
  position.assign(vec3(0, 0, 0));
  position.x.assign(1.0);
  position.addAssign(velocity);
})().compute(count);
```

### Accessing Other Elements

```javascript
const computeShader = Fn(() => {
  const myIndex = instanceIndex;
  const neighborIndex = myIndex.add(1).mod(count);

  const myPos = positions.element(myIndex);
  const neighborPos = positions.element(neighborIndex);

  // Calculate distance to neighbor
  const dist = myPos.distance(neighborPos);
})().compute(count);
```

## Compute Shader Patterns

### Initialize Particles

```javascript
const computeInit = Fn(() => {
  const position = positions.element(instanceIndex);
  const velocity = velocities.element(instanceIndex);

  // Random positions using hash
  position.x.assign(hash(instanceIndex).mul(10).sub(5));
  position.y.assign(hash(instanceIndex.add(1)).mul(10).sub(5));
  position.z.assign(hash(instanceIndex.add(2)).mul(10).sub(5));

  // Zero velocity
  velocity.assign(vec3(0));
})().compute(count);

// Run once at startup (after await renderer.init())
renderer.compute(computeInit);
```

### Physics Update

```javascript
const gravity = uniform(-9.8);
const deltaTimeUniform = uniform(0);
const groundY = uniform(0);

const computeUpdate = Fn(() => {
  const position = positions.element(instanceIndex);
  const velocity = velocities.element(instanceIndex);
  const dt = deltaTimeUniform;

  // Apply gravity
  velocity.y.addAssign(gravity.mul(dt));

  // Update position
  position.addAssign(velocity.mul(dt));

  // Ground collision
  If(position.y.lessThan(groundY), () => {
    position.y.assign(groundY);
    velocity.y.assign(velocity.y.negate().mul(0.8)); // Bounce
    velocity.xz.mulAssign(0.95); // Friction
  });
})().compute(count);

// In animation loop
function animate() {
  deltaTimeUniform.value = clock.getDelta();
  renderer.compute(computeUpdate);
  renderer.render(scene, camera);
}
```

### Attraction to Point

```javascript
const attractorPos = uniform(new THREE.Vector3(0, 0, 0));
const attractorStrength = uniform(1.0);

const computeAttract = Fn(() => {
  const position = positions.element(instanceIndex);
  const velocity = velocities.element(instanceIndex);

  // Direction to attractor
  const toAttractor = attractorPos.sub(position);
  const distance = toAttractor.length();
  const direction = toAttractor.normalize();

  // Apply force (inverse square falloff)
  const force = direction.mul(attractorStrength).div(distance.mul(distance).add(0.1));
  velocity.addAssign(force.mul(deltaTimeUniform));
})().compute(count);
```

### Neighbor Interaction (Boids-like)

```javascript
const computeBoids = Fn(() => {
  const myPos = positions.element(instanceIndex);
  const myVel = velocities.element(instanceIndex);

  const separation = vec3(0).toVar();
  const alignment = vec3(0).toVar();
  const cohesion = vec3(0).toVar();
  const neighborCount = int(0).toVar();

  // Check nearby particles
  Loop(count, ({ i }) => {
    If(i.notEqual(instanceIndex), () => {
      const otherPos = positions.element(i);
      const otherVel = velocities.element(i);
      const dist = myPos.distance(otherPos);

      If(dist.lessThan(2.0), () => {
        // Separation
        const diff = myPos.sub(otherPos).normalize().div(dist);
        separation.addAssign(diff);

        // Alignment
        alignment.addAssign(otherVel);

        // Cohesion
        cohesion.addAssign(otherPos);

        neighborCount.addAssign(1);
      });
    });
  });

  If(neighborCount.greaterThan(0), () => {
    const n = neighborCount.toFloat();
    alignment.divAssign(n);
    cohesion.divAssign(n);
    cohesion.assign(cohesion.sub(myPos));

    myVel.addAssign(separation.mul(0.05));
    myVel.addAssign(alignment.sub(myVel).mul(0.05));
    myVel.addAssign(cohesion.mul(0.05));
  });

  // Limit speed
  const speed = myVel.length();
  If(speed.greaterThan(2.0), () => {
    myVel.assign(myVel.normalize().mul(2.0));
  });

  myPos.addAssign(myVel.mul(deltaTimeUniform));
})().compute(count);
```

## Workgroups and Synchronization

### Workgroup Size

```javascript
// Default workgroup size is typically 64 or 256
// Pass workgroup size as an array
const computeShader = Fn(() => {
  // shader code
})().compute(count, [64]);

// 2D workgroup
const compute2D = Fn(() => {
  // shader code
})().compute(width * height, [8, 8]);
```

### Compute Builtins

```javascript
import {
  globalId, localId, workgroupId, numWorkgroups, subgroupSize,
  invocationLocalIndex, invocationSubgroupIndex, subgroupIndex
} from 'three/tsl';

const computeShader = Fn(() => {
  // Global invocation ID across all workgroups
  const gid = globalId;

  // Local invocation ID within the workgroup
  const lid = localId;

  // Workgroup ID
  const wid = workgroupId;

  // Total number of workgroups
  const nwg = numWorkgroups;
})().compute(count, [64]);
```

### Barriers

```javascript
import { workgroupBarrier, storageBarrier, textureBarrier } from 'three/tsl';

const computeShader = Fn(() => {
  // Write data
  sharedData.element(localIndex).assign(value);

  // Ensure all workgroup threads reach this point
  workgroupBarrier();

  // Now safe to read data written by other threads
  const neighborValue = sharedData.element(localIndex.add(1));
})().compute(count);
```

## Atomic Operations

For thread-safe read-modify-write operations:

```javascript
import { atomicAdd, atomicSub, atomicMax, atomicMin, atomicAnd, atomicOr, atomicXor } from 'three/tsl';

const counter = instancedArray(1, 'uint');

const computeShader = Fn(() => {
  // Atomically increment counter
  atomicAdd(counter.element(0), 1);

  // Atomic max
  atomicMax(maxValue.element(0), localValue);
})().compute(count);
```

## Using Compute Results in Materials

### Instanced Mesh with Computed Positions

```javascript
// Create instanced mesh
const geometry = new THREE.SphereGeometry(0.1, 16, 16);
const material = new THREE.MeshStandardNodeMaterial();

// Use computed positions
material.positionNode = positions.element(instanceIndex);

// Optionally use computed colors
material.colorNode = colors.element(instanceIndex);

const mesh = new THREE.InstancedMesh(geometry, material, count);
scene.add(mesh);
```

### Points with Computed Positions

```javascript
const geometry = new THREE.BufferGeometry();
geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(count * 3), 3));

const material = new THREE.PointsNodeMaterial();
material.positionNode = positions.element(instanceIndex);
material.colorNode = colors.element(instanceIndex);
material.sizeNode = float(5.0);

const points = new THREE.Points(geometry, material);
scene.add(points);
```

## Execution Methods

```javascript
// IMPORTANT: Always initialize the renderer first
await renderer.init();

// Synchronous compute (preferred since r181)
renderer.compute(computeShader);

// Multiple computes
renderer.compute(computeInit);
renderer.compute(computePhysics);
renderer.compute(computeCollisions);

// Note: computeAsync() is deprecated since r181.
// Use await renderer.init() at startup, then renderer.compute() synchronously.
```

## Reading Back Data (GPU to CPU)

```javascript
// Create buffer for readback
const readBuffer = new Float32Array(count * 3);

// Read data back from GPU
await renderer.readRenderTargetPixelsAsync(
  computeTexture,
  0, 0, width, height,
  readBuffer
);
```

## Complete Example: Particle System

```javascript
import * as THREE from 'three/webgpu';
import {
  Fn, If, instancedArray, instanceIndex, uniform,
  vec3, float, hash, time
} from 'three/tsl';

// Setup
const count = 50000;
const positions = instancedArray(count, 'vec3');
const velocities = instancedArray(count, 'vec3');
const lifetimes = instancedArray(count, 'float');

// Uniforms
const emitterPos = uniform(new THREE.Vector3(0, 0, 0));
const gravity = uniform(-2.0);
const dt = uniform(0);

// Initialize
const computeInit = Fn(() => {
  const pos = positions.element(instanceIndex);
  const vel = velocities.element(instanceIndex);
  const life = lifetimes.element(instanceIndex);

  pos.assign(emitterPos);

  // Random velocity in cone
  const angle = hash(instanceIndex).mul(Math.PI * 2);
  const speed = hash(instanceIndex.add(1)).mul(2).add(1);
  vel.x.assign(angle.cos().mul(speed).mul(0.3));
  vel.y.assign(speed);
  vel.z.assign(angle.sin().mul(speed).mul(0.3));

  // Random lifetime
  life.assign(hash(instanceIndex.add(2)).mul(2).add(1));
})().compute(count);

// Update
const computeUpdate = Fn(() => {
  const pos = positions.element(instanceIndex);
  const vel = velocities.element(instanceIndex);
  const life = lifetimes.element(instanceIndex);

  // Apply gravity
  vel.y.addAssign(gravity.mul(dt));

  // Update position
  pos.addAssign(vel.mul(dt));

  // Decrease lifetime
  life.subAssign(dt);

  // Respawn dead particles
  If(life.lessThan(0), () => {
    pos.assign(emitterPos);
    const angle = hash(instanceIndex.add(time.mul(1000))).mul(Math.PI * 2);
    const speed = hash(instanceIndex.add(time.mul(1000)).add(1)).mul(2).add(1);
    vel.x.assign(angle.cos().mul(speed).mul(0.3));
    vel.y.assign(speed);
    vel.z.assign(angle.sin().mul(speed).mul(0.3));
    life.assign(hash(instanceIndex.add(time.mul(1000)).add(2)).mul(2).add(1));
  });
})().compute(count);

// Material
const material = new THREE.PointsNodeMaterial();
material.positionNode = positions.element(instanceIndex);
material.sizeNode = float(3.0);
material.colorNode = vec3(1, 0.5, 0.2);

// Geometry (dummy positions)
const geometry = new THREE.BufferGeometry();
geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(count * 3), 3));

const points = new THREE.Points(geometry, material);
scene.add(points);

// Init (after await renderer.init())
renderer.compute(computeInit);

// Animation loop
function animate() {
  dt.value = Math.min(clock.getDelta(), 0.1);
  renderer.compute(computeUpdate);
  renderer.render(scene, camera);
}
```
