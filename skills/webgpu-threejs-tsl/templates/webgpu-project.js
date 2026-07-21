/**
 * WebGPU Three.js Project Template
 *
 * A complete starter template with:
 * - WebGPU renderer setup
 * - TSL material example
 * - Post-processing ready
 * - Responsive design
 * - Animation loop
 *
 * Usage:
 * 1. Copy this file to your project
 * 2. Install Three.js: npm install three
 * 3. Replace placeholder content with your scene
 */

import * as THREE from 'three/webgpu';
import {
  // Types
  float,
  vec2,
  vec3,
  vec4,
  color,
  uniform,

  // Geometry
  positionLocal,
  positionWorld,
  normalLocal,
  normalWorld,
  uv,

  // Camera
  cameraPosition,

  // Time
  time,
  deltaTime,

  // Math
  mix,
  smoothstep,
  clamp,
  sin,
  cos,

  // Texture
  texture,

  // Functions
  Fn,
  If,
  Loop,

  // Post-processing
  pass
} from 'three/tsl';

import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// ============================================
// CONFIGURATION
// ============================================

const CONFIG = {
  // Renderer
  antialias: true,
  pixelRatio: Math.min(window.devicePixelRatio, 2),

  // Camera
  fov: 60,
  near: 0.1,
  far: 1000,
  position: new THREE.Vector3(0, 2, 5),

  // Scene
  backgroundColor: 0x111111,

  // Controls
  enableDamping: true,
  dampingFactor: 0.05
};

// ============================================
// GLOBALS
// ============================================

let camera, scene, renderer, controls;
let clock;

// Add your uniforms here
const uniforms = {
  // Example: myColor: uniform(new THREE.Color(0xff0000))
};

// ============================================
// INITIALIZATION
// ============================================

async function init() {
  // Clock
  clock = new THREE.Clock();

  // Scene
  scene = new THREE.Scene();
  scene.background = new THREE.Color(CONFIG.backgroundColor);

  // Camera
  camera = new THREE.PerspectiveCamera(
    CONFIG.fov,
    window.innerWidth / window.innerHeight,
    CONFIG.near,
    CONFIG.far
  );
  camera.position.copy(CONFIG.position);

  // Renderer
  renderer = new THREE.WebGPURenderer({ antialias: CONFIG.antialias });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(CONFIG.pixelRatio);
  document.body.appendChild(renderer.domElement);

  // Initialize WebGPU
  await renderer.init();

  // Controls
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = CONFIG.enableDamping;
  controls.dampingFactor = CONFIG.dampingFactor;

  // Setup scene content
  setupLights();
  setupScene();

  // Optional: Setup post-processing
  // setupPostProcessing();

  // Events
  window.addEventListener('resize', onWindowResize);

  // Start animation loop
  renderer.setAnimationLoop(animate);
}

// ============================================
// SCENE SETUP
// ============================================

function setupLights() {
  // Ambient light
  const ambientLight = new THREE.AmbientLight(0x404040, 0.5);
  scene.add(ambientLight);

  // Directional light
  const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
  directionalLight.position.set(5, 10, 5);
  directionalLight.castShadow = true;
  scene.add(directionalLight);

  // Add more lights as needed
}

function setupScene() {
  // ========================================
  // ADD YOUR SCENE CONTENT HERE
  // ========================================

  // Example: Create a mesh with TSL material
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const material = createExampleMaterial();
  const mesh = new THREE.Mesh(geometry, material);
  scene.add(mesh);

  // Example: Add a floor
  const floorGeometry = new THREE.PlaneGeometry(10, 10);
  const floorMaterial = new THREE.MeshStandardNodeMaterial({
    color: 0x333333
  });
  const floor = new THREE.Mesh(floorGeometry, floorMaterial);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.5;
  scene.add(floor);
}

function createExampleMaterial() {
  const material = new THREE.MeshStandardNodeMaterial();

  // ========================================
  // CUSTOMIZE YOUR MATERIAL HERE
  // ========================================

  // Example: Animated color
  material.colorNode = Fn(() => {
    const t = time.mul(0.5).sin().mul(0.5).add(0.5);
    return mix(color(0x0066ff), color(0xff6600), t);
  })();

  // Example: PBR properties
  material.roughnessNode = float(0.5);
  material.metalnessNode = float(0.0);

  // Example: Simple fresnel rim
  material.emissiveNode = Fn(() => {
    const viewDir = cameraPosition.sub(positionWorld).normalize();
    const fresnel = float(1.0).sub(normalWorld.dot(viewDir).saturate()).pow(3.0);
    return color(0x00ffff).mul(fresnel).mul(0.5);
  })();

  return material;
}

// ============================================
// POST-PROCESSING (Optional)
// ============================================

let postProcessing;

function setupPostProcessing() {
  // Uncomment and customize as needed

  // postProcessing = new THREE.RenderPipeline(renderer);
  // const scenePass = pass(scene, camera);
  // const sceneColor = scenePass.getTextureNode('output');
  //
  // // Add effects here
  // postProcessing.outputNode = sceneColor;
}

// ============================================
// ANIMATION LOOP
// ============================================

function animate() {
  const delta = clock.getDelta();
  const elapsed = clock.getElapsedTime();

  // ========================================
  // UPDATE YOUR SCENE HERE
  // ========================================

  // Example: Rotate mesh
  const mesh = scene.children.find((child) => child.type === 'Mesh');
  if (mesh) {
    mesh.rotation.y += delta * 0.5;
  }

  // Update controls
  controls.update();

  // Render
  if (postProcessing) {
    postProcessing.render();
  } else {
    renderer.render(scene, camera);
  }
}

// ============================================
// EVENT HANDLERS
// ============================================

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

// ============================================
// START
// ============================================

init().catch(console.error);

// Export for external access if needed
export { scene, camera, renderer, uniforms };
