/**
 * Compute Shader Template
 *
 * A template for GPU compute shaders with:
 * - Storage buffer setup
 * - Initialize and update shaders
 * - Visualization with instanced mesh
 *
 * Usage:
 * 1. Modify PARTICLE_COUNT and buffer types
 * 2. Implement your initialization logic
 * 3. Implement your update logic
 * 4. Customize visualization
 */

import * as THREE from 'three/webgpu';
import {
  Fn,
  If,
  Loop,
  float,
  int,
  vec2,
  vec3,
  vec4,
  color,
  uniform,
  instancedArray,
  instanceIndex,
  hash,
  time,
  deltaTime,
  select,  // Use for conditional value selection
  max,
  clamp
} from 'three/tsl';

import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// ============================================
// CONFIGURATION
// ============================================

const PARTICLE_COUNT = 50000;

// ============================================
// STORAGE BUFFERS
// ============================================

// Define your storage buffers here
// Available types: 'float', 'vec2', 'vec3', 'vec4', 'int', 'uint'

const positions = instancedArray(PARTICLE_COUNT, 'vec3');
const velocities = instancedArray(PARTICLE_COUNT, 'vec3');
// Add more buffers as needed:
// const colors = instancedArray(PARTICLE_COUNT, 'vec3');
// const lifetimes = instancedArray(PARTICLE_COUNT, 'float');
// const states = instancedArray(PARTICLE_COUNT, 'uint');

// ============================================
// UNIFORMS
// ============================================

const dt = uniform(0);
// Add your uniforms here:
// const gravity = uniform(-9.8);
// const attractorPosition = uniform(new THREE.Vector3());
// const forceStrength = uniform(1.0);

// ============================================
// COMPUTE SHADERS
// ============================================

/**
 * ⚠️  CRITICAL TSL GOTCHA - READ THIS FIRST!
 *
 * TSL intercepts PROPERTY ASSIGNMENTS on nodes, but NOT JS variable reassignment.
 *
 *   // ✅ WORKS - Property assignment on vec3 node
 *   const result = vec3(position);
 *   If(result.y.greaterThan(limit), () => {
 *     result.y = limit;  // TSL intercepts property setters!
 *   });
 *
 *   // ❌ WRONG - JS variable reassignment (scalars have no .x/.y properties)
 *   let value = buffer.element(index).toFloat();
 *   If(condition, () => {
 *     value = value.add(1.0);  // JS reassignment - TSL can't see this!
 *   });
 *   buffer.element(index).assign(value);  // Uses ORIGINAL node!
 *
 * Solutions for scalars:
 *
 *   // ✅ Use select() for conditional values
 *   const newValue = select(condition, valueIfTrue, valueIfFalse);
 *
 *   // ✅ Use .toVar() for mutable scalars
 *   const value = buffer.element(index).toVar();
 *   If(condition, () => {
 *     value.assign(value.add(1.0));  // Works with .toVar()!
 *   });
 *
 *   // ✅ Use direct .assign() on buffer elements
 *   If(condition, () => {
 *     element.assign(element.add(1.0));
 *   });
 */

/**
 * Initialize particles
 * Called once at startup
 */
const computeInit = Fn(() => {
  const position = positions.element(instanceIndex);
  const velocity = velocities.element(instanceIndex);

  // ========================================
  // IMPLEMENT YOUR INITIALIZATION HERE
  // ========================================

  // Example: Random positions in a cube
  position.x.assign(hash(instanceIndex).sub(0.5).mul(10));
  position.y.assign(hash(instanceIndex.add(1)).sub(0.5).mul(10));
  position.z.assign(hash(instanceIndex.add(2)).sub(0.5).mul(10));

  // Example: Zero velocity
  velocity.assign(vec3(0));
})().compute(PARTICLE_COUNT);

/**
 * Update particles each frame
 * Called every frame in animation loop
 */
const computeUpdate = Fn(() => {
  const position = positions.element(instanceIndex);
  const velocity = velocities.element(instanceIndex);

  // ========================================
  // IMPLEMENT YOUR UPDATE LOGIC HERE
  // ========================================

  // Example: Simple gravity
  velocity.y.addAssign(float(-9.8).mul(dt));

  // Example: Update position
  position.addAssign(velocity.mul(dt));

  // Example: Ground bounce
  If(position.y.lessThan(0), () => {
    position.y.assign(0);
    velocity.y.assign(velocity.y.negate().mul(0.8));
  });

  // Example: Boundary wrapping
  // If(position.x.abs().greaterThan(5), () => {
  //   position.x.assign(position.x.negate());
  // });
})().compute(PARTICLE_COUNT);

/**
 * Optional: Additional compute pass (e.g., for interactions)
 */
const computeInteraction = Fn(() => {
  const position = positions.element(instanceIndex);
  const velocity = velocities.element(instanceIndex);

  // ========================================
  // IMPLEMENT INTERACTION LOGIC HERE
  // ========================================

  // Example: Attract to point
  // const toTarget = attractorPosition.sub(position);
  // const dist = toTarget.length();
  // const force = toTarget.normalize().mul(forceStrength).div(dist.add(0.1));
  // velocity.addAssign(force.mul(dt));
})().compute(PARTICLE_COUNT);

// ============================================
// VISUALIZATION
// ============================================

function createVisualization(scene) {
  // Choose visualization type:
  // - Points (fastest, simplest)
  // - Instanced Mesh (more control)

  // Option 1: Points
  // return createPointsVisualization(scene);

  // Option 2: Instanced Mesh
  return createInstancedVisualization(scene);
}

function createPointsVisualization(scene) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(new Float32Array(PARTICLE_COUNT * 3), 3)
  );

  const material = new THREE.PointsNodeMaterial();

  // Position from compute buffer
  material.positionNode = positions.element(instanceIndex);

  // ========================================
  // CUSTOMIZE POINT APPEARANCE HERE
  // ========================================

  material.sizeNode = float(3.0);

  material.colorNode = Fn(() => {
    // Example: Color based on velocity
    const velocity = velocities.element(instanceIndex);
    const speed = velocity.length();
    return mix(color(0x0066ff), color(0xff6600), speed.div(5).saturate());
  })();

  const points = new THREE.Points(geometry, material);
  scene.add(points);
  return points;
}

function createInstancedVisualization(scene) {
  // Geometry for each instance
  const geometry = new THREE.SphereGeometry(0.05, 8, 8);
  // Or use simpler geometry for better performance:
  // const geometry = new THREE.IcosahedronGeometry(0.05, 0);

  const material = new THREE.MeshStandardNodeMaterial();

  // Position from compute buffer
  material.positionNode = positions.element(instanceIndex);

  // ========================================
  // CUSTOMIZE MESH APPEARANCE HERE
  // ========================================

  material.colorNode = Fn(() => {
    // Example: Color based on position
    const position = positions.element(instanceIndex);
    return color(0x0088ff).add(position.mul(0.05));
  })();

  material.roughnessNode = float(0.5);
  material.metalnessNode = float(0.2);

  const mesh = new THREE.InstancedMesh(geometry, material, PARTICLE_COUNT);
  scene.add(mesh);
  return mesh;
}

// ============================================
// MAIN SETUP
// ============================================

let camera, scene, renderer, controls;
let visualization;

async function init() {
  // Scene
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x111122);

  // Camera
  camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(0, 5, 15);

  // Lights
  const ambientLight = new THREE.AmbientLight(0x404040);
  scene.add(ambientLight);

  const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
  directionalLight.position.set(5, 10, 5);
  scene.add(directionalLight);

  // Optional: Ground plane
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(20, 20),
    new THREE.MeshStandardNodeMaterial({ color: 0x333333 })
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  // Renderer
  renderer = new THREE.WebGPURenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  document.body.appendChild(renderer.domElement);
  await renderer.init();

  // Initialize particles (renderer already initialized above)
  renderer.compute(computeInit);

  // Create visualization
  visualization = createVisualization(scene);

  // Controls
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.target.set(0, 2, 0);

  // Events
  window.addEventListener('resize', onWindowResize);

  // Start
  renderer.setAnimationLoop(animate);
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

const clock = new THREE.Clock();

function animate() {
  // Update delta time uniform
  dt.value = Math.min(clock.getDelta(), 0.1);

  // Run compute shaders
  renderer.compute(computeUpdate);
  // renderer.compute(computeInteraction);

  // Update controls
  controls.update();

  // Render
  renderer.render(scene, camera);
}

init().catch(console.error);

// Export for external control
export {
  positions,
  velocities,
  dt,
  computeInit,
  computeUpdate,
  computeInteraction
};
