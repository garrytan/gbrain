/**
 * Earth Shader Example
 *
 * Complete procedural Earth with:
 * - Day/night texture blending
 * - Atmospheric glow (fresnel)
 * - Cloud layer
 * - City lights at night
 * - Bump mapping
 *
 * Based on Three.js webgpu_tsl_earth example (MIT License)
 * https://github.com/mrdoob/three.js
 */

import * as THREE from 'three/webgpu';
import {
  Fn,
  If,
  float,
  vec2,
  vec3,
  vec4,
  color,
  uniform,
  texture,
  uv,
  time,
  mix,
  smoothstep,
  pow,
  clamp,
  normalize,
  dot,
  max,
  positionWorld,
  normalWorld,
  normalLocal,
  cameraPosition,
  bumpMap
} from 'three/tsl';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

let camera, scene, renderer, controls;
let earth, clouds, atmosphere;

// Uniforms
const sunDirection = uniform(new THREE.Vector3(1, 0.2, 0.5).normalize());
const atmosphereDayColor = uniform(new THREE.Color(0x4db2ff));
const atmosphereTwilightColor = uniform(new THREE.Color(0xbd5f1b));
const cloudSpeed = uniform(0.01);
const cityLightIntensity = uniform(1.5);

async function init() {
  // Camera
  camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(0, 0, 4);

  // Scene
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000011);

  // Load textures
  const loader = new THREE.TextureLoader();

  // Note: Replace with actual texture paths
  const earthDayTexture = loader.load('textures/earth_day.jpg');
  const earthNightTexture = loader.load('textures/earth_night.jpg');
  const earthCloudsTexture = loader.load('textures/earth_clouds.jpg');
  const earthBumpTexture = loader.load('textures/earth_bump.jpg');

  // Set texture properties
  [earthDayTexture, earthNightTexture, earthCloudsTexture, earthBumpTexture].forEach((tex) => {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
  });

  // Create Earth
  earth = createEarth(earthDayTexture, earthNightTexture, earthBumpTexture);
  scene.add(earth);

  // Create cloud layer
  clouds = createClouds(earthCloudsTexture);
  scene.add(clouds);

  // Create atmosphere glow
  atmosphere = createAtmosphere();
  scene.add(atmosphere);

  // Stars background
  createStars();

  // Renderer
  renderer = new THREE.WebGPURenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(window.devicePixelRatio);
  document.body.appendChild(renderer.domElement);
  await renderer.init();

  // Controls
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.minDistance = 2;
  controls.maxDistance = 10;

  // Events
  window.addEventListener('resize', onWindowResize);

  renderer.setAnimationLoop(animate);
}

function createEarth(dayTex, nightTex, bumpTex) {
  const geometry = new THREE.SphereGeometry(1, 64, 64);
  const material = new THREE.MeshStandardNodeMaterial();

  // Sun illumination factor
  const sunOrientation = Fn(() => {
    return normalWorld.dot(sunDirection).mul(0.5).add(0.5);
  });

  // Day/night color mixing
  material.colorNode = Fn(() => {
    const dayColor = texture(dayTex, uv());
    const nightColor = texture(nightTex, uv());

    const orientation = sunOrientation();
    const dayNight = smoothstep(0.4, 0.6, orientation);

    // Add city lights on night side
    const cityLights = nightColor.mul(cityLightIntensity).mul(
      float(1.0).sub(dayNight)
    );

    const baseColor = mix(nightColor, dayColor, dayNight);
    return baseColor.add(cityLights.mul(float(1.0).sub(orientation).pow(2.0)));
  })();

  // Bump mapping for terrain
  material.normalNode = bumpMap(texture(bumpTex, uv()), 0.03);

  // PBR properties vary with day/night
  material.roughnessNode = Fn(() => {
    const orientation = sunOrientation();
    return mix(float(0.8), float(0.4), smoothstep(0.3, 0.7, orientation));
  })();

  material.metalnessNode = float(0.0);

  // Subtle atmospheric rim on day side
  material.emissiveNode = Fn(() => {
    const viewDir = normalize(cameraPosition.sub(positionWorld));
    const fresnel = pow(float(1.0).sub(normalWorld.dot(viewDir).saturate()), 4.0);

    const orientation = sunOrientation();
    const atmosphereColor = mix(atmosphereTwilightColor, atmosphereDayColor, orientation);

    return atmosphereColor.mul(fresnel).mul(orientation).mul(0.3);
  })();

  return new THREE.Mesh(geometry, material);
}

function createClouds(cloudsTex) {
  const geometry = new THREE.SphereGeometry(1.01, 64, 64);
  const material = new THREE.MeshStandardNodeMaterial();

  // Animated UV for cloud movement
  const cloudUV = Fn(() => {
    const baseUV = uv();
    const offset = time.mul(cloudSpeed);
    return vec2(baseUV.x.add(offset), baseUV.y);
  });

  // Cloud color (white with transparency)
  material.colorNode = color(0xffffff);

  // Cloud opacity from texture
  material.opacityNode = Fn(() => {
    const cloudAlpha = texture(cloudsTex, cloudUV()).r;

    // Fade clouds on night side
    const sunOrientation = normalWorld.dot(sunDirection).mul(0.5).add(0.5);
    const dayFactor = smoothstep(0.2, 0.5, sunOrientation);

    return cloudAlpha.mul(0.8).mul(dayFactor.mul(0.5).add(0.5));
  })();

  material.transparent = true;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;

  // Slight self-illumination
  material.emissiveNode = Fn(() => {
    const sunOrientation = normalWorld.dot(sunDirection).mul(0.5).add(0.5);
    return color(0xffffff).mul(sunOrientation.mul(0.1));
  })();

  return new THREE.Mesh(geometry, material);
}

function createAtmosphere() {
  const geometry = new THREE.SphereGeometry(1.15, 64, 64);
  const material = new THREE.MeshBasicNodeMaterial();

  material.colorNode = Fn(() => {
    const viewDir = normalize(cameraPosition.sub(positionWorld));
    const fresnel = pow(float(1.0).sub(normalWorld.dot(viewDir).abs()), 3.0);

    const sunOrientation = normalWorld.dot(sunDirection).mul(0.5).add(0.5);
    const atmosphereColor = mix(atmosphereTwilightColor, atmosphereDayColor, sunOrientation);

    return atmosphereColor;
  })();

  material.opacityNode = Fn(() => {
    const viewDir = normalize(cameraPosition.sub(positionWorld));
    const fresnel = pow(float(1.0).sub(normalWorld.dot(viewDir).abs()), 2.5);

    // Stronger on day side
    const sunOrientation = normalWorld.dot(sunDirection).mul(0.5).add(0.5);

    return fresnel.mul(sunOrientation.mul(0.5).add(0.3));
  })();

  material.transparent = true;
  material.depthWrite = false;
  material.side = THREE.BackSide;

  return new THREE.Mesh(geometry, material);
}

function createStars() {
  const starsGeometry = new THREE.BufferGeometry();
  const starCount = 2000;

  const positions = new Float32Array(starCount * 3);
  const colors = new Float32Array(starCount * 3);

  for (let i = 0; i < starCount; i++) {
    // Random position on sphere
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(Math.random() * 2 - 1);
    const radius = 50 + Math.random() * 50;

    positions[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = radius * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = radius * Math.cos(phi);

    // Slight color variation
    const brightness = 0.5 + Math.random() * 0.5;
    colors[i * 3] = brightness;
    colors[i * 3 + 1] = brightness;
    colors[i * 3 + 2] = brightness + Math.random() * 0.2;
  }

  starsGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  starsGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const starsMaterial = new THREE.PointsNodeMaterial();
  starsMaterial.colorNode = Fn(() => {
    return vec3(1.0);
  })();
  starsMaterial.sizeNode = float(2.0);
  starsMaterial.vertexColors = true;

  const stars = new THREE.Points(starsGeometry, starsMaterial);
  scene.add(stars);
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function animate() {
  // Rotate Earth slowly
  earth.rotation.y += 0.001;
  clouds.rotation.y += 0.0012;

  // Animate sun direction (optional - creates day/night cycle)
  // const angle = time.value * 0.1;
  // sunDirection.value.set(Math.cos(angle), 0.2, Math.sin(angle)).normalize();

  controls.update();
  renderer.render(scene, camera);
}

init();

// Export for external control
export { sunDirection, atmosphereDayColor, atmosphereTwilightColor, cloudSpeed, cityLightIntensity };
