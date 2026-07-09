/**
 * GPU Particle System with Compute Shaders
 *
 * Demonstrates TSL compute shaders for particle simulation:
 * - Instanced array buffers
 * - Physics simulation on GPU
 * - Mouse interaction
 *
 * Based on Three.js webgpu_compute_particles example (MIT License)
 * https://github.com/mrdoob/three.js
 */

import * as THREE from 'three/webgpu';
import {
  Fn,
  If,
  uniform,
  float,
  vec3,
  color,
  instancedArray,
  instanceIndex,
  hash,
  time
} from 'three/tsl';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

let camera, scene, renderer, controls;
let computeInit, computeUpdate, computeHit;

// Particle count
const PARTICLE_COUNT = 100000;

// Storage buffers
const positions = instancedArray(PARTICLE_COUNT, 'vec3');
const velocities = instancedArray(PARTICLE_COUNT, 'vec3');

// Uniforms
const gravity = uniform(-9.8);
const bounce = uniform(0.7);
const friction = uniform(0.98);
const deltaTimeUniform = uniform(0);
const clickPosition = uniform(new THREE.Vector3());
const hitStrength = uniform(5.0);

async function init() {
  // Camera
  camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(0, 5, 15);

  // Scene
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x111122);

  // Create compute shaders
  createComputeShaders();

  // Create particle mesh
  createParticleMesh();

  // Floor
  const floorGeometry = new THREE.PlaneGeometry(30, 30);
  const floorMaterial = new THREE.MeshStandardNodeMaterial({
    color: 0x333333
  });
  const floor = new THREE.Mesh(floorGeometry, floorMaterial);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  // Lights
  const ambientLight = new THREE.AmbientLight(0x404040);
  scene.add(ambientLight);

  const pointLight = new THREE.PointLight(0xffffff, 100);
  pointLight.position.set(5, 10, 5);
  scene.add(pointLight);

  // Renderer
  renderer = new THREE.WebGPURenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(window.devicePixelRatio);
  document.body.appendChild(renderer.domElement);
  await renderer.init();

  // Initialize particles (renderer already initialized above)
  renderer.compute(computeInit);

  // Controls
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.target.set(0, 2, 0);

  // Events
  window.addEventListener('resize', onWindowResize);
  renderer.domElement.addEventListener('click', onClick);

  renderer.setAnimationLoop(animate);
}

function createComputeShaders() {
  // Grid dimensions for initialization
  const gridSize = Math.ceil(Math.sqrt(PARTICLE_COUNT));
  const spacing = 0.15;
  const offset = (gridSize * spacing) / 2;

  // Initialize particles in a grid
  computeInit = Fn(() => {
    const position = positions.element(instanceIndex);
    const velocity = velocities.element(instanceIndex);

    // Calculate grid position
    const x = instanceIndex.mod(gridSize);
    const z = instanceIndex.div(gridSize);

    // Set position
    position.x.assign(x.toFloat().mul(spacing).sub(offset));
    position.y.assign(float(5.0).add(hash(instanceIndex).mul(2.0)));
    position.z.assign(z.toFloat().mul(spacing).sub(offset));

    // Random initial velocity
    velocity.x.assign(hash(instanceIndex.add(1)).sub(0.5).mul(2.0));
    velocity.y.assign(hash(instanceIndex.add(2)).mul(-2.0));
    velocity.z.assign(hash(instanceIndex.add(3)).sub(0.5).mul(2.0));
  })().compute(PARTICLE_COUNT);

  // Physics update
  computeUpdate = Fn(() => {
    const position = positions.element(instanceIndex);
    const velocity = velocities.element(instanceIndex);
    const dt = deltaTimeUniform;

    // Apply gravity
    velocity.y.addAssign(gravity.mul(dt));

    // Update position
    position.addAssign(velocity.mul(dt));

    // Apply friction
    velocity.mulAssign(friction);

    // Ground collision
    If(position.y.lessThan(0), () => {
      position.y.assign(0);
      velocity.y.assign(velocity.y.abs().mul(bounce)); // Reverse and dampen

      // Extra friction on ground
      velocity.x.mulAssign(0.9);
      velocity.z.mulAssign(0.9);
    });

    // Boundary walls
    If(position.x.abs().greaterThan(15), () => {
      position.x.assign(position.x.sign().mul(15));
      velocity.x.assign(velocity.x.negate().mul(bounce));
    });

    If(position.z.abs().greaterThan(15), () => {
      position.z.assign(position.z.sign().mul(15));
      velocity.z.assign(velocity.z.negate().mul(bounce));
    });
  })().compute(PARTICLE_COUNT);

  // Hit/explosion effect
  computeHit = Fn(() => {
    const position = positions.element(instanceIndex);
    const velocity = velocities.element(instanceIndex);

    // Distance to click
    const toClick = position.sub(clickPosition);
    const distance = toClick.length();

    // Apply force within radius
    If(distance.lessThan(3.0), () => {
      const direction = toClick.normalize();
      const force = float(3.0).sub(distance).div(3.0).mul(hitStrength);

      // Add randomness
      const randomForce = force.mul(hash(instanceIndex.add(time.mul(1000))).mul(0.5).add(0.75));

      velocity.addAssign(direction.mul(randomForce));
      velocity.y.addAssign(randomForce.mul(0.5));
    });
  })().compute(PARTICLE_COUNT);
}

function createParticleMesh() {
  // Simple sphere geometry for each particle
  const geometry = new THREE.SphereGeometry(0.08, 8, 8);

  // Material using computed positions
  const material = new THREE.MeshStandardNodeMaterial();

  // Position from compute buffer
  material.positionNode = positions.element(instanceIndex);

  // Color based on velocity
  material.colorNode = Fn(() => {
    const velocity = velocities.element(instanceIndex);
    const speed = velocity.length();

    // Color gradient: blue (slow) -> orange (fast)
    const t = speed.div(10.0).saturate();
    return color(0x0066ff).mix(color(0xff6600), t);
  })();

  material.roughnessNode = float(0.5);
  material.metalnessNode = float(0.2);

  // Create instanced mesh
  const mesh = new THREE.InstancedMesh(geometry, material, PARTICLE_COUNT);
  scene.add(mesh);
}

function onClick(event) {
  // Raycast to find click position on floor
  const raycaster = new THREE.Raycaster();
  const mouse = new THREE.Vector2(
    (event.clientX / window.innerWidth) * 2 - 1,
    -(event.clientY / window.innerHeight) * 2 + 1
  );

  raycaster.setFromCamera(mouse, camera);

  // Intersect with floor plane (y = 0)
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const intersection = new THREE.Vector3();
  raycaster.ray.intersectPlane(plane, intersection);

  if (intersection) {
    // Raise click position slightly
    intersection.y = 0.5;
    clickPosition.value.copy(intersection);

    // Run hit compute shader
    renderer.compute(computeHit);
  }
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

const clock = new THREE.Clock();

function animate() {
  // Update delta time
  deltaTimeUniform.value = Math.min(clock.getDelta(), 0.1);

  // Run physics compute
  renderer.compute(computeUpdate);

  controls.update();
  renderer.render(scene, camera);
}

init();
