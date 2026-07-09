/**
 * Basic WebGPU Three.js Setup
 *
 * Minimal example showing WebGPU renderer initialization
 * with a simple animated mesh using TSL.
 *
 * Based on Three.js examples (MIT License)
 * https://github.com/mrdoob/three.js
 */

import * as THREE from 'three/webgpu';
import { color, time, oscSine, positionLocal, normalWorld } from 'three/tsl';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

let camera, scene, renderer, controls;

async function init() {
  // Camera
  camera = new THREE.PerspectiveCamera(
    70,
    window.innerWidth / window.innerHeight,
    0.1,
    100
  );
  camera.position.z = 4;

  // Scene
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x111111);

  // Lighting
  const ambientLight = new THREE.AmbientLight(0x404040);
  scene.add(ambientLight);

  const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
  directionalLight.position.set(5, 5, 5);
  scene.add(directionalLight);

  // Create mesh with TSL material
  const geometry = new THREE.TorusKnotGeometry(1, 0.3, 128, 32);
  const material = new THREE.MeshStandardNodeMaterial();

  // Animated color using TSL
  material.colorNode = color(0x0088ff).mul(
    oscSine(time.mul(0.5)).mul(0.5).add(0.5)
  );

  // Add slight position wobble
  material.positionNode = positionLocal.add(
    normalWorld.mul(oscSine(time.mul(2.0).add(positionLocal.y)).mul(0.05))
  );

  const mesh = new THREE.Mesh(geometry, material);
  scene.add(mesh);

  // Renderer
  renderer = new THREE.WebGPURenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(window.devicePixelRatio);
  document.body.appendChild(renderer.domElement);

  // Initialize WebGPU
  await renderer.init();

  // Controls
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  // Handle resize
  window.addEventListener('resize', onWindowResize);

  // Start animation loop
  renderer.setAnimationLoop(animate);
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
