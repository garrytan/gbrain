/**
 * Post-Processing Pipeline Example
 *
 * Demonstrates TSL post-processing:
 * - Bloom effect
 * - Custom vignette
 * - Color grading
 * - Effect chaining
 *
 * Based on Three.js webgpu_postprocessing examples (MIT License)
 * https://github.com/mrdoob/three.js
 */

import * as THREE from 'three/webgpu';
import {
  Fn,
  float,
  vec2,
  vec3,
  vec4,
  color,
  uniform,
  pass,
  screenUV,
  screenSize,
  time,
  oscSine,
  mix,
  smoothstep,
  texture,
  grayscale,
  saturation
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

let camera, scene, renderer, controls;
let postProcessing;

// Effect uniforms
const bloomStrength = uniform(1.0);
const bloomThreshold = uniform(0.5);
const vignetteIntensity = uniform(0.5);
const saturationAmount = uniform(1.2);
const colorTint = uniform(new THREE.Color(1.0, 0.95, 0.9));

async function init() {
  // Camera
  camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(0, 2, 8);

  // Scene
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x111111);

  // Add objects with emissive materials (for bloom)
  createScene();

  // Renderer
  renderer = new THREE.WebGPURenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(window.devicePixelRatio);
  document.body.appendChild(renderer.domElement);
  await renderer.init();

  // Create post-processing pipeline
  setupPostProcessing();

  // Controls
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.target.set(0, 1, 0);

  // Events
  window.addEventListener('resize', onWindowResize);

  renderer.setAnimationLoop(animate);
}

function createScene() {
  // Floor
  const floorGeometry = new THREE.PlaneGeometry(20, 20);
  const floorMaterial = new THREE.MeshStandardNodeMaterial({
    color: 0x222222
  });
  const floor = new THREE.Mesh(floorGeometry, floorMaterial);
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);

  // Emissive spheres (will bloom)
  const sphereGeometry = new THREE.SphereGeometry(0.5, 32, 32);

  const colors = [0xff0044, 0x00ff88, 0x4488ff, 0xffaa00, 0xff00ff];

  for (let i = 0; i < 5; i++) {
    const material = new THREE.MeshStandardNodeMaterial();

    // Base color
    material.colorNode = color(colors[i]).mul(0.3);

    // Animated emissive
    material.emissiveNode = Fn(() => {
      const pulse = oscSine(time.mul(1.0 + i * 0.2)).mul(0.5).add(0.5);
      return color(colors[i]).mul(pulse.mul(2.0).add(0.5));
    })();

    material.roughnessNode = float(0.2);
    material.metalnessNode = float(0.8);

    const sphere = new THREE.Mesh(sphereGeometry, material);
    sphere.position.set(
      Math.cos((i / 5) * Math.PI * 2) * 3,
      1 + Math.sin(i) * 0.5,
      Math.sin((i / 5) * Math.PI * 2) * 3
    );
    scene.add(sphere);
  }

  // Central reflective sphere
  const centerMaterial = new THREE.MeshStandardNodeMaterial();
  centerMaterial.colorNode = color(0x888888);
  centerMaterial.roughnessNode = float(0.1);
  centerMaterial.metalnessNode = float(1.0);

  const centerSphere = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 64), centerMaterial);
  centerSphere.position.y = 1;
  scene.add(centerSphere);

  // Lights
  const ambientLight = new THREE.AmbientLight(0x404040, 0.5);
  scene.add(ambientLight);

  const pointLight = new THREE.PointLight(0xffffff, 50);
  pointLight.position.set(5, 10, 5);
  scene.add(pointLight);
}

function setupPostProcessing() {
  // Create post-processing instance
  postProcessing = new THREE.RenderPipeline(renderer);

  // Create scene pass
  const scenePass = pass(scene, camera);
  const sceneColor = scenePass.getTextureNode('output');

  // --- Effect Chain ---

  // 1. Bloom
  const bloomPass = bloom(sceneColor);
  bloomPass.threshold = bloomThreshold;
  bloomPass.strength = bloomStrength;
  bloomPass.radius = uniform(0.5);

  // Add bloom to scene
  let output = sceneColor.add(bloomPass);

  // 2. Color Grading
  output = saturation(output, saturationAmount);
  output = output.mul(colorTint);

  // 3. Vignette (custom effect)
  const vignette = Fn(() => {
    const uv = screenUV;
    const dist = uv.sub(0.5).length();
    return float(1.0).sub(dist.mul(vignetteIntensity).pow(2.0)).saturate();
  });

  output = output.mul(vignette());

  // 4. Optional: Scanlines
  const scanlines = Fn(() => {
    const scanline = screenUV.y.mul(screenSize.y).mul(0.5).sin().mul(0.05).add(0.95);
    return scanline;
  });

  // Uncomment for CRT effect:
  // output = output.mul(scanlines());

  // Set final output
  postProcessing.outputNode = output;
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function animate() {
  controls.update();

  // Render with post-processing
  postProcessing.render();
}

init();

// Export uniforms for external control (e.g., GUI)
export { bloomStrength, bloomThreshold, vignetteIntensity, saturationAmount, colorTint };
