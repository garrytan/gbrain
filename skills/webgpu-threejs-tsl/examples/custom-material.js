/**
 * Custom TSL Material Example
 *
 * Demonstrates creating custom shader effects using TSL:
 * - Fresnel rim lighting
 * - Animated patterns
 * - Dynamic displacement
 *
 * Based on Three.js examples (MIT License)
 * https://github.com/mrdoob/three.js
 */

import * as THREE from 'three/webgpu';
import {
  Fn,
  color,
  float,
  vec2,
  vec3,
  uniform,
  texture,
  uv,
  time,
  mix,
  smoothstep,
  sin,
  cos,
  positionLocal,
  positionWorld,
  normalLocal,
  normalWorld,
  cameraPosition
} from 'three/tsl';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

let camera, scene, renderer, controls;
let rimColor, patternScale, displacementStrength;

async function init() {
  // Setup
  camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.z = 3;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);

  // Uniforms for runtime control
  rimColor = uniform(new THREE.Color(0x00ffff));
  patternScale = uniform(5.0);
  displacementStrength = uniform(0.1);

  // Create custom material
  const material = createCustomMaterial();

  // Mesh
  const geometry = new THREE.IcosahedronGeometry(1, 64);
  const mesh = new THREE.Mesh(geometry, material);
  scene.add(mesh);

  // Renderer
  renderer = new THREE.WebGPURenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(window.devicePixelRatio);
  document.body.appendChild(renderer.domElement);
  await renderer.init();

  // Controls
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  // Events
  window.addEventListener('resize', onWindowResize);

  // GUI (optional - requires lil-gui)
  setupGUI();

  renderer.setAnimationLoop(animate);
}

function createCustomMaterial() {
  const material = new THREE.MeshStandardNodeMaterial();

  // --- Fresnel Rim Effect ---
  const fresnel = Fn(() => {
    const viewDir = cameraPosition.sub(positionWorld).normalize();
    const nDotV = normalWorld.dot(viewDir).saturate();
    return float(1.0).sub(nDotV).pow(3.0);
  });

  // --- Animated Pattern ---
  const animatedPattern = Fn(() => {
    const uvCoord = uv().mul(patternScale);
    const t = time.mul(0.5);

    // Create animated wave pattern
    const wave1 = sin(uvCoord.x.mul(10.0).add(t)).mul(0.5).add(0.5);
    const wave2 = sin(uvCoord.y.mul(10.0).sub(t.mul(1.3))).mul(0.5).add(0.5);
    const wave3 = sin(uvCoord.x.add(uvCoord.y).mul(7.0).add(t.mul(0.7))).mul(0.5).add(0.5);

    return wave1.mul(wave2).mul(wave3);
  });

  // --- Displacement ---
  const displacement = Fn(() => {
    const pattern = animatedPattern();
    return normalLocal.mul(pattern.mul(displacementStrength));
  });

  // Apply displacement
  material.positionNode = positionLocal.add(displacement());

  // --- Color ---
  const baseColor = color(0x222244);
  const highlightColor = color(0x4444ff);

  // Mix colors based on pattern
  const pattern = animatedPattern();
  const surfaceColor = mix(baseColor, highlightColor, pattern);

  material.colorNode = surfaceColor;

  // --- Rim lighting ---
  material.emissiveNode = rimColor.mul(fresnel());

  // --- PBR properties ---
  material.roughnessNode = float(0.3).add(pattern.mul(0.4));
  material.metalnessNode = float(0.1);

  return material;
}

function setupGUI() {
  // Only setup if lil-gui is available
  if (typeof window.GUI === 'undefined') {
    console.log('Add lil-gui for interactive controls');
    return;
  }

  const gui = new GUI();
  const params = {
    rimColor: '#00ffff',
    patternScale: 5.0,
    displacementStrength: 0.1
  };

  gui.addColor(params, 'rimColor').onChange((value) => {
    rimColor.value.set(value);
  });

  gui.add(params, 'patternScale', 1, 20).onChange((value) => {
    patternScale.value = value;
  });

  gui.add(params, 'displacementStrength', 0, 0.5).onChange((value) => {
    displacementStrength.value = value;
  });
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function animate() {
  controls.update();
  renderer.render(scene, camera);
}

init();
