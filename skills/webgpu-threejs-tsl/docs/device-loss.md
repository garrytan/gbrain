# WebGPU Device Loss Handling

## What Is Device Loss?

Device loss occurs when the GPU driver cannot continue processing commands. Causes include:

- Driver crashes
- Extreme resource pressure
- Long-running shaders (GPU watchdog triggers after ~10 seconds)
- Driver updates
- Significant device configuration changes

When a device is lost, the `GPUDevice` object and **all objects created with it become unusable**. All buffers, textures, pipelines, and GPU memory are discarded.

## Listening for Device Loss

Detect loss by attaching a callback to the device's `lost` promise:

```javascript
const adapter = await navigator.gpu.requestAdapter();
if (!adapter) { return; }
const device = await adapter.requestDevice();

device.lost.then((info) => {
  console.error('WebGPU device lost:', info.message);
  // Handle recovery
});
```

**Important:** Don't `await` this promise directly - it will block indefinitely if loss never occurs.

### Device Loss Information

The `GPUDeviceLostInfo` object provides:

| Property | Description |
|----------|-------------|
| `reason` | `'destroyed'` (intentional via `destroy()`) or `'unknown'` (unexpected) |
| `message` | Human-readable debugging info (don't parse programmatically) |

```javascript
device.lost.then((info) => {
  if (info.reason === 'unknown') {
    // Unexpected loss - attempt recovery
    handleUnexpectedDeviceLoss();
  } else {
    // Intentional destruction - expected behavior
  }
});
```

### Devices Starting Lost

`adapter.requestDevice()` always returns a `GPUDevice`, but it may already be lost if creation failed. This occurs when the adapter was "consumed" (used previously) or "expired."

**Best practice:** Always get a new adapter right before requesting a device.

## Recovery Strategies

### Minimal Recovery (Page Reload)

For simple applications:

```javascript
device.lost.then((info) => {
  if (info.reason === 'unknown') {
    // Warn user before reload
    alert('Graphics error occurred. The page will reload.');
    location.reload();
  }
});
```

### Restart GPU Content Only (Recommended for Three.js)

Recreate the device and reconfigure the canvas without full page reload:

```javascript
import * as THREE from 'three/webgpu';

let renderer;
let scene, camera;

async function initWebGPU() {
  renderer = new THREE.WebGPURenderer();
  await renderer.init();

  // Access the underlying WebGPU device
  const device = renderer.backend.device;

  device.lost.then((info) => {
    console.error('Device lost:', info.message);
    if (info.reason === 'unknown') {
      // Dispose current renderer
      renderer.dispose();
      // Reinitialize
      initWebGPU();
    }
  });

  // Configure canvas
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.body.appendChild(renderer.domElement);

  // Recreate scene content
  setupScene();
}

function setupScene() {
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
  // ... add meshes, lights, etc.
}

initWebGPU();
```

### Restore with Application State

For applications with user progress or configuration:

```javascript
let appState = {
  cameraPosition: { x: 0, y: 5, z: 10 },
  settings: {},
  // Don't save transient data like particle positions
};

// Save state periodically
function saveState() {
  appState.cameraPosition = {
    x: camera.position.x,
    y: camera.position.y,
    z: camera.position.z
  };
  localStorage.setItem('appState', JSON.stringify(appState));
}

// Restore on recovery
async function initWebGPU() {
  renderer = new THREE.WebGPURenderer();
  await renderer.init();

  const savedState = localStorage.getItem('appState');
  if (savedState) {
    appState = JSON.parse(savedState);
  }

  setupScene();

  // Restore camera position
  camera.position.set(
    appState.cameraPosition.x,
    appState.cameraPosition.y,
    appState.cameraPosition.z
  );

  renderer.backend.device.lost.then((info) => {
    if (info.reason === 'unknown') {
      saveState();
      renderer.dispose();
      initWebGPU();
    }
  });
}
```

## When Recovery Fails

If `requestAdapter()` returns `null` after device loss, the OS or browser has blocked GPU access:

```javascript
async function initWebGPU() {
  const adapter = await navigator.gpu.requestAdapter();

  if (!adapter) {
    // Check if this is initial failure or post-loss failure
    if (hadPreviousDevice) {
      showMessage('GPU access lost. Please restart your browser.');
    } else {
      showMessage('WebGPU is not supported on this device.');
    }
    return;
  }

  // Continue with device creation...
}
```

## Testing Device Loss

### Using destroy()

Call `device.destroy()` to simulate loss:

```javascript
let simulatedLoss = false;

function simulateDeviceLoss() {
  simulatedLoss = true;
  renderer.backend.device.destroy();
}

// In your device.lost handler:
device.lost.then((info) => {
  if (info.reason === 'unknown' || simulatedLoss) {
    simulatedLoss = false;
    // Treat as unexpected loss for testing
    handleDeviceLoss();
  }
});

// Add debug keybinding
window.addEventListener('keydown', (e) => {
  if (e.key === 'L' && e.ctrlKey && e.shiftKey) {
    simulateDeviceLoss();
  }
});
```

**Limitations of destroy():**
- Unmaps buffers immediately (real loss doesn't)
- Always allows device recovery (real loss may not)

### Chrome GPU Process Crash Testing

Navigate to `about:gpucrash` in a **separate tab** to crash the GPU process.

Chrome enforces escalating restrictions:

| Crash | Effect |
|-------|--------|
| 1st | New adapters allowed |
| 2nd within 2 min | Adapter requests fail (resets on page refresh) |
| 3rd within 2 min | All pages blocked (reset after 2 min or browser restart) |
| 3-6 within 5 min | GPU process stops restarting; browser restart required |

### Chrome Testing Flags

Bypass crash limits for development:

```bash
# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --disable-domain-blocking-for-3d-apis \
  --disable-gpu-process-crash-limit

# Windows
chrome.exe --disable-domain-blocking-for-3d-apis --disable-gpu-process-crash-limit

# Linux
google-chrome --disable-domain-blocking-for-3d-apis --disable-gpu-process-crash-limit
```

## Complete Example

```javascript
import * as THREE from 'three/webgpu';
import { color, time, oscSine } from 'three/tsl';

let renderer, scene, camera, mesh;
let hadPreviousDevice = false;

async function init() {
  // Check WebGPU support
  if (!navigator.gpu) {
    showError('WebGPU not supported');
    return;
  }

  // Create renderer
  renderer = new THREE.WebGPURenderer({ antialias: true });

  try {
    await renderer.init();
  } catch (e) {
    if (hadPreviousDevice) {
      showError('GPU recovery failed. Please restart browser.');
    } else {
      showError('Failed to initialize WebGPU.');
    }
    return;
  }

  hadPreviousDevice = true;

  // Setup device loss handler
  const device = renderer.backend.device;
  device.lost.then(handleDeviceLoss);

  // Setup scene
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.body.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.position.z = 5;

  const geometry = new THREE.BoxGeometry();
  const material = new THREE.MeshStandardNodeMaterial();
  material.colorNode = color(0x00ff00).mul(oscSine(time));

  mesh = new THREE.Mesh(geometry, material);
  scene.add(mesh);

  const light = new THREE.DirectionalLight(0xffffff, 1);
  light.position.set(5, 5, 5);
  scene.add(light);
  scene.add(new THREE.AmbientLight(0x404040));

  animate();
}

function handleDeviceLoss(info) {
  console.error('Device lost:', info.reason, info.message);

  if (info.reason === 'unknown') {
    // Cleanup
    if (renderer) {
      renderer.domElement.remove();
      renderer.dispose();
    }

    // Attempt recovery after short delay
    setTimeout(() => {
      init();
    }, 100);
  }
}

function animate() {
  if (!renderer) return;

  requestAnimationFrame(animate);
  mesh.rotation.x += 0.01;
  mesh.rotation.y += 0.01;
  renderer.render(scene, camera);
}

function showError(message) {
  const div = document.createElement('div');
  div.textContent = message;
  div.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);padding:20px;background:#f44;color:#fff;border-radius:8px;';
  document.body.appendChild(div);
}

init();
```

## Best Practices

1. **Always listen for device loss** - Even if you just show an error message
2. **Get a fresh adapter before each device request** - The GPU hardware may have changed
3. **Don't parse the message field** - It's implementation-specific and changes between browsers
4. **Save critical application state** - Restore user progress after recovery
5. **Don't save transient state** - Particle positions, physics state can be reset
6. **Test your recovery path** - Use `destroy()` and Chrome's `about:gpucrash`
7. **Handle adapter failure gracefully** - Distinguish between initial failure and post-loss failure
8. **Add a short delay before recovery** - Give the system time to stabilize
