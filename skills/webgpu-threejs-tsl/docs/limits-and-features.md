# WebGPU Limits and Features

## Why This Matters

WebGPU devices have **default limits** (guaranteed minimums) that may be lower than what your application needs. For example, the default `maxBufferSize` is 256 MiB — if you create a large compute buffer, you'll silently get errors unless you request a higher limit. Similarly, optional **features** like `float32-filterable` must be explicitly enabled.

## Limits

Limits define numeric constraints on resources. Every WebGPU implementation guarantees a set of minimum values, but most GPUs support much higher limits.

Common limits you may need to increase:

| Limit | Default | When to Increase |
|-------|---------|------------------|
| `maxBufferSize` | 268435456 (256 MiB) | Large storage/vertex buffers |
| `maxStorageBufferBindingSize` | 134217728 (128 MiB) | Large compute storage buffers |
| `maxStorageBuffersPerShaderStage` | 8 | Many storage buffers in one shader |
| `maxComputeWorkgroupSizeX` | 128 | Large workgroup dimensions |
| `maxComputeInvocationsPerWorkgroup` | 128 | Dense compute workgroups |
| `maxColorAttachments` | 8 | Many render targets |

### Querying Adapter Limits

```javascript
const adapter = await navigator.gpu?.requestAdapter();
console.log(adapter.limits.maxBufferSize);
console.log(adapter.limits.maxStorageBufferBindingSize);
```

### Requesting Increased Limits

You must request higher limits when creating the device — otherwise you get the defaults, not the adapter's maximums.

**Raw WebGPU:**
```javascript
const adapter = await navigator.gpu?.requestAdapter();
const device = await adapter.requestDevice({
  requiredLimits: {
    maxBufferSize: 1024 * 1024 * 1024,            // 1 GiB
    maxStorageBufferBindingSize: 1024 * 1024 * 512, // 512 MiB
  },
});
```

**Three.js WebGPURenderer:**

Three.js accepts `requiredLimits` as a renderer constructor option, which gets passed through to `requestDevice()`:

```javascript
const renderer = new THREE.WebGPURenderer({
  requiredLimits: {
    maxBufferSize: 1024 * 1024 * 1024,            // 1 GiB
    maxStorageBufferBindingSize: 1024 * 1024 * 512, // 512 MiB
  },
});
await renderer.init();
```

If the adapter doesn't support the requested limit, `requestDevice()` (or `renderer.init()`) will fail.

### Safe Pattern: Check Before Requesting

```javascript
const adapter = await navigator.gpu?.requestAdapter();

const desiredBufferSize = 1024 * 1024 * 1024; // 1 GiB
const requiredLimits = {};

if (adapter.limits.maxBufferSize >= desiredBufferSize) {
  requiredLimits.maxBufferSize = desiredBufferSize;
} else {
  console.warn('Adapter does not support 1 GiB buffers, using default');
}

const renderer = new THREE.WebGPURenderer({ requiredLimits });
await renderer.init();
```

## Features

Features are optional capabilities that vary by GPU. Unlike limits, features are either present or absent — there's no numeric value to adjust.

### How Three.js Handles Features

Three.js automatically requests **all features supported by the adapter**. You generally don't need to manage features manually when using Three.js.

### Querying Available Features (Raw WebGPU)

```javascript
const adapter = await navigator.gpu?.requestAdapter();
// adapter.features is a Set
console.log(adapter.features.has('float32-filterable'));
console.log(adapter.features.has('shader-f16'));
```

### Common Optional Features

| Feature | Purpose |
|---------|---------|
| `float32-filterable` | Linear filtering on float32 textures |
| `float32-blendable` | Blending on float32 render targets |
| `shader-f16` | 16-bit floats in shaders |
| `texture-compression-bc` | BC (desktop) texture compression |
| `texture-compression-etc2` | ETC2 (mobile) texture compression |
| `texture-compression-astc` | ASTC (mobile) texture compression |
| `timestamp-query` | GPU timing measurements |
| `depth-clip-control` | Disable depth clipping |
| `dual-source-blending` | Two blend sources from one shader |
| `subgroups` | Subgroup operations in compute |
| `clip-distances` | Custom clip planes in vertex shader |

## Best Practices

1. **Only request limits you actually need** — requesting maximums hides portability issues where your app works on your GPU but fails on weaker ones
2. **Check adapter limits before requesting** — gracefully degrade when limits aren't available
3. **Don't forget storage buffer binding size** — `maxStorageBufferBindingSize` is often the bottleneck, not `maxBufferSize`
4. **Use [webgpureport.org](https://webgpureport.org)** to check what limits/features different GPUs support

## Debugging

If you're hitting buffer size errors or validation failures:

```javascript
// Log all adapter limits
const adapter = await navigator.gpu?.requestAdapter();
for (const [key, value] of Object.entries(Object.getPrototypeOf(adapter.limits))) {
  if (typeof value !== 'function') {
    console.log(`${key}: ${adapter.limits[key]}`);
  }
}
```

Check Chrome DevTools console for WebGPU validation errors — they often mention which limit was exceeded.
