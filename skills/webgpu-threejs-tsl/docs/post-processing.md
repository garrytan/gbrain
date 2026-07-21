# TSL Post-Processing

Post-processing applies effects to the rendered image. TSL provides both built-in effects and the ability to create custom effects.

> **Note:** `PostProcessing` was renamed to `RenderPipeline` in r183. `PostProcessing` still works as a compatibility wrapper but is deprecated.

## Basic Setup

```javascript
import * as THREE from 'three/webgpu';
import { pass } from 'three/tsl';

// Create renderer
const renderer = new THREE.WebGPURenderer();
await renderer.init();

// Create render pipeline (formerly PostProcessing, renamed in r183)
const renderPipeline = new THREE.RenderPipeline(renderer);

// Create scene pass
const scenePass = pass(scene, camera);
const scenePassColor = scenePass.getTextureNode('output');

// Output (passthrough)
renderPipeline.outputNode = scenePassColor;

// Render with post-processing
function animate() {
  renderPipeline.render();  // Not renderer.render()
}
```

## Built-in Effects

### Bloom

```javascript
import { bloom } from 'three/addons/tsl/display/BloomNode.js';

const scenePass = pass(scene, camera);
const scenePassColor = scenePass.getTextureNode('output');

// Add bloom
const bloomPass = bloom(scenePassColor);

// Configure
bloomPass.threshold.value = 0.5;   // Brightness threshold
bloomPass.strength.value = 1.0;    // Bloom intensity
bloomPass.radius.value = 0.5;      // Blur radius

// Combine original + bloom
renderPipeline.outputNode = scenePassColor.add(bloomPass);
```

### Gaussian Blur

```javascript
import { gaussianBlur } from 'three/addons/tsl/display/GaussianBlurNode.js';

const blurred = gaussianBlur(scenePassColor, vec2(2.0)); // Blur strength (sigma)
renderPipeline.outputNode = blurred;
```

> **Note (r177):** Sigma values were rescaled — double previous sigma values to get the same blur strength. Also, `resolution` was renamed to `resolutionScale` (now a scalar, not a Vector2) in r180.

### FXAA (Anti-aliasing)

```javascript
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';

renderPipeline.outputNode = fxaa(scenePassColor);
```

### SMAA (Anti-aliasing)

```javascript
import { smaa } from 'three/addons/tsl/display/SMAANode.js';

renderPipeline.outputNode = smaa(scenePassColor);
```

### Depth of Field

```javascript
import { dof } from 'three/addons/tsl/display/DepthOfFieldNode.js';

const scenePass = pass(scene, camera);
const colorNode = scenePass.getTextureNode('output');
const viewZNode = scenePass.getViewZNode();

// dof(colorNode, viewZNode, focusDistance, focalLength, bokehScale)
const dofPass = dof(colorNode, viewZNode, 5.0, 25.0, 1.0);

renderPipeline.outputNode = dofPass;
```

> **Note:** The DOF API was completely reimplemented in r181. The old `dof(color, depth, { focus, aperture, maxblur })` options-object signature no longer works.

### Motion Blur

```javascript
import { motionBlur } from 'three/addons/tsl/display/MotionBlurNode.js';

const scenePass = pass(scene, camera);
const velocityPass = scenePass.getTextureNode('velocity');

const motionBlurPass = motionBlur(scenePassColor, velocityPass);
renderPipeline.outputNode = motionBlurPass;
```

### Screen Space Reflections (SSR)

```javascript
import { ssr } from 'three/addons/tsl/display/SSRNode.js';

const scenePass = pass(scene, camera);
const colorNode = scenePass.getTextureNode('output');
const depthNode = scenePass.getTextureNode('depth');
const normalNode = scenePass.getTextureNode('normal');

const ssrPass = ssr(colorNode, depthNode, normalNode, camera);
renderPipeline.outputNode = ssrPass;
```

### Ambient Occlusion (SSAO)

```javascript
import { ao } from 'three/addons/tsl/display/AmbientOcclusionNode.js';

const scenePass = pass(scene, camera);
const depthNode = scenePass.getTextureNode('depth');
const normalNode = scenePass.getTextureNode('normal');

const aoPass = ao(depthNode, normalNode, camera);
renderPipeline.outputNode = scenePassColor.mul(aoPass);
```

### Film Grain

```javascript
import { film } from 'three/addons/tsl/display/FilmNode.js';

const filmPass = film(scenePassColor, {
  intensity: 0.5,
  grayscale: false
});
renderPipeline.outputNode = filmPass;
```

### Outline

```javascript
import { outline } from 'three/addons/tsl/display/OutlineNode.js';

const outlinePass = outline(scene, camera, selectedObjects, {
  edgeStrength: 3.0,
  edgeGlow: 0.0,
  edgeThickness: 1.0,
  visibleEdgeColor: new THREE.Color(0xffffff),
  hiddenEdgeColor: new THREE.Color(0x190a05)
});

renderPipeline.outputNode = scenePassColor.add(outlinePass);
```

### Chromatic Aberration

```javascript
import { chromaticAberration } from 'three/addons/tsl/display/ChromaticAberrationNode.js';

const caPass = chromaticAberration(scenePassColor, {
  offset: vec2(0.002, 0.002)
});
renderPipeline.outputNode = caPass;
```

## Color Adjustments

### Grayscale

```javascript
import { grayscale } from 'three/tsl';

renderPipeline.outputNode = grayscale(scenePassColor);
```

### Saturation

```javascript
import { saturation } from 'three/tsl';

// 0 = grayscale, 1 = normal, 2 = oversaturated
renderPipeline.outputNode = saturation(scenePassColor, 1.5);
```

### Hue Shift

```javascript
import { hue } from 'three/tsl';

// Shift hue by radians
renderPipeline.outputNode = hue(scenePassColor, time.mul(0.5));
```

### Vibrance

```javascript
import { vibrance } from 'three/tsl';

renderPipeline.outputNode = vibrance(scenePassColor, 0.5);
```

### Posterize

```javascript
import { posterize } from 'three/tsl';

// Reduce color levels
renderPipeline.outputNode = posterize(scenePassColor, 8);
```

### Sepia

```javascript
import { sepia } from 'three/addons/tsl/display/SepiaNode.js';

renderPipeline.outputNode = sepia(scenePassColor);
```

### 3D LUT

```javascript
import { lut3D } from 'three/addons/tsl/display/Lut3DNode.js';

const lutTexture = new THREE.Data3DTexture(lutData, size, size, size);
renderPipeline.outputNode = lut3D(scenePassColor, lutTexture, size);
```

## Custom Post-Processing

### Basic Custom Effect

```javascript
import { Fn, screenUV, float, vec4 } from 'three/tsl';

const customEffect = Fn(() => {
  const color = scenePassColor.toVar();

  // Invert colors
  color.rgb.assign(float(1.0).sub(color.rgb));

  return color;
});

renderPipeline.outputNode = customEffect();
```

### Vignette Effect

```javascript
const vignette = Fn(() => {
  const color = scenePassColor.toVar();

  // Distance from center
  const uv = screenUV;
  const dist = uv.sub(0.5).length();

  // Vignette falloff
  const vignette = float(1.0).sub(dist.mul(1.5)).clamp(0, 1);

  color.rgb.mulAssign(vignette);
  return color;
});

renderPipeline.outputNode = vignette();
```

### CRT/Scanline Effect

```javascript
import { viewportSharedTexture } from 'three/tsl';

const crtEffect = Fn(() => {
  const uv = screenUV;

  // Sample scene at offset UVs for RGB separation (chromatic aberration)
  const uvR = uv.add(vec2(0.002, 0));
  const uvG = uv;
  const uvB = uv.sub(vec2(0.002, 0));

  // Use viewportSharedTexture to sample at different UV coordinates
  const r = viewportSharedTexture(uvR).r;
  const g = viewportSharedTexture(uvG).g;
  const b = viewportSharedTexture(uvB).b;

  const color = vec4(r, g, b, 1.0).toVar();

  // Scanlines
  const scanline = uv.y.mul(screenSize.y).mul(0.5).sin().mul(0.1).add(0.9);
  color.rgb.mulAssign(scanline);

  // Vignette
  const dist = uv.sub(0.5).length();
  color.rgb.mulAssign(float(1.0).sub(dist.mul(0.5)));

  return color;
});

// Note: For this effect, apply after scene rendering
renderPipeline.outputNode = crtEffect();
```

### Pixelate Effect

```javascript
const pixelSize = uniform(8.0);

const pixelate = Fn(() => {
  const uv = screenUV;
  const pixelUV = uv.mul(screenSize).div(pixelSize).floor().mul(pixelSize).div(screenSize);
  return texture(scenePassColor, pixelUV);
});

renderPipeline.outputNode = pixelate();
```

### Edge Detection (Sobel)

```javascript
const sobelEdge = Fn(() => {
  const uv = screenUV;
  const texelSize = vec2(1.0).div(screenSize);

  // Sample 3x3 kernel
  const tl = luminance(texture(scenePassColor, uv.add(texelSize.mul(vec2(-1, -1)))));
  const tc = luminance(texture(scenePassColor, uv.add(texelSize.mul(vec2(0, -1)))));
  const tr = luminance(texture(scenePassColor, uv.add(texelSize.mul(vec2(1, -1)))));
  const ml = luminance(texture(scenePassColor, uv.add(texelSize.mul(vec2(-1, 0)))));
  const mr = luminance(texture(scenePassColor, uv.add(texelSize.mul(vec2(1, 0)))));
  const bl = luminance(texture(scenePassColor, uv.add(texelSize.mul(vec2(-1, 1)))));
  const bc = luminance(texture(scenePassColor, uv.add(texelSize.mul(vec2(0, 1)))));
  const br = luminance(texture(scenePassColor, uv.add(texelSize.mul(vec2(1, 1)))));

  // Sobel operators
  const gx = tl.add(ml.mul(2)).add(bl).sub(tr).sub(mr.mul(2)).sub(br);
  const gy = tl.add(tc.mul(2)).add(tr).sub(bl).sub(bc.mul(2)).sub(br);

  const edge = sqrt(gx.mul(gx).add(gy.mul(gy)));

  return vec4(vec3(edge), 1.0);
});

renderPipeline.outputNode = sobelEdge();
```

## Multiple Render Targets (MRT)

Access multiple buffers from the scene pass:

```javascript
import { mrt, output } from 'three/tsl';

const scenePass = pass(scene, camera);

// Set up MRT
scenePass.setMRT(mrt({
  output: output,           // Color output
  normal: normalView,       // View-space normals
  depth: depth              // Depth buffer
}));

// Access individual targets
const colorTexture = scenePass.getTextureNode('output');
const normalTexture = scenePass.getTextureNode('normal');
const depthTexture = scenePass.getTextureNode('depth');
```

### Selective Bloom with MRT

Bloom only emissive objects by rendering emissive to a separate target:

```javascript
import { pass, mrt, output, emissive } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';

const renderPipeline = new THREE.RenderPipeline(renderer);
const scenePass = pass(scene, camera);

// Render both color and emissive to separate targets
scenePass.setMRT(mrt({
  output: output,
  emissive: emissive
}));

// Get the texture nodes
const colorTexture = scenePass.getTextureNode('output');
const emissiveTexture = scenePass.getTextureNode('emissive');

// Apply bloom only to emissive
const bloomPass = bloom(emissiveTexture);
bloomPass.threshold.value = 0.0;  // Bloom all emissive
bloomPass.strength.value = 1.5;
bloomPass.radius.value = 0.5;

// Combine: original color + bloomed emissive
renderPipeline.outputNode = colorTexture.add(bloomPass);
```

This approach prevents non-emissive bright areas (like white surfaces) from blooming.

## Chaining Effects

```javascript
const scenePass = pass(scene, camera);
const color = scenePass.getTextureNode('output');

// Chain multiple effects
let output = color;

// 1. Apply bloom
const bloomPass = bloom(output);
output = output.add(bloomPass.mul(0.5));

// 2. Apply color grading
output = saturation(output, 1.2);

// 3. Apply vignette
const dist = screenUV.sub(0.5).length();
const vignette = float(1.0).sub(dist.mul(0.5));
output = output.mul(vignette);

// 4. Apply FXAA
output = fxaa(output);

renderPipeline.outputNode = output;
```

## Conditional Effects

```javascript
const effectEnabled = uniform(true);

const conditionalEffect = Fn(() => {
  const color = scenePassColor;
  return select(effectEnabled, grayscale(color), color);
});

renderPipeline.outputNode = conditionalEffect();

// Toggle at runtime
effectEnabled.value = false;
```

## Transitions

```javascript
import { transition } from 'three/addons/tsl/display/TransitionNode.js';

const scenePassA = pass(sceneA, camera);
const scenePassB = pass(sceneB, camera);

const transitionProgress = uniform(0);

const transitionPass = transition(
  scenePassA.getTextureNode('output'),
  scenePassB.getTextureNode('output'),
  transitionProgress,
  texture(transitionTexture)  // Optional transition texture
);

renderPipeline.outputNode = transitionPass;

// Animate transition
function animate() {
  transitionProgress.value = Math.sin(time) * 0.5 + 0.5;
  renderPipeline.render();
}
```

## Additional Effects (r182+)

These effects were added in recent Three.js releases:

```javascript
// Volumetric god rays (r183)
import { godrays } from 'three/addons/tsl/display/GodraysNode.js';
const godraysPass = godrays(scenePassColor, depthNode, camera, lightPosition);

// Retro/CRT effect (r183)
import { retroPass } from 'three/addons/tsl/display/RetroNode.js';

// Anamorphic lens flare
import { anamorphic } from 'three/addons/tsl/display/AnamorphicNode.js';
const anamorphicPass = anamorphic(scenePassColor);

// Lens flare
import { lensflare } from 'three/addons/tsl/display/LensflareNode.js';

// Denoising
import { denoise } from 'three/addons/tsl/display/DenoiseNode.js';

// Screen-space global illumination
import { ssgi } from 'three/addons/tsl/display/SSGINode.js';

// Temporal anti-aliasing (replaces FXAA/SMAA for better quality)
import { traa } from 'three/addons/tsl/display/TRAANode.js';

// Alternative blur modes
import { boxBlur } from 'three/addons/tsl/display/BoxBlurNode.js';       // Mobile-friendly
import { hashBlur } from 'three/addons/tsl/display/HashBlurNode.js';     // Single-pass
import { bilateralBlur } from 'three/addons/tsl/display/BilateralBlurNode.js'; // Edge-preserving

// 3D texture sampling (r182)
import { texture3DLoad, texture3DLevel } from 'three/tsl';
```
