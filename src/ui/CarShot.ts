import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { findCar } from '../vehicle/cars';
import { loadF1Model } from '../vehicle/cars/GltfF1Visual';

/**
 * Studio shot of one team's car for the menu cards (?carshot=<car id>): the game's
 * own F1 model in the team livery, three-quarter front view, soft studio light,
 * transparent background (the card supplies the team colour). scripts/render-cars.ts
 * captures it for every team into public/menu/cars/.
 */
export async function runCarShot(carId: string, container: HTMLElement): Promise<void> {
  await loadF1Model(import.meta.env.BASE_URL);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(960, 540);
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.replaceChildren(renderer.domElement);
  document.body.style.background = 'transparent';

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  const key = new THREE.DirectionalLight(0xffffff, 2.4);
  key.position.set(-4, 7, -3);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = key.shadow.camera.bottom = -4;
  key.shadow.camera.right = key.shadow.camera.top = 4;
  key.shadow.radius = 6;
  scene.add(key, new THREE.HemisphereLight(0xffffff, 0x404048, 0.6));
  // Soft contact shadow on an invisible floor.
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), new THREE.ShadowMaterial({ opacity: 0.35 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  const car = findCar(carId);
  const visual = car.createVisual();
  visual.root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) o.castShadow = true;
  });
  // Wheels resting on the floor (no physics here): lift the body to its ride height.
  const box = new THREE.Box3().setFromObject(visual.root);
  visual.root.position.y = -box.min.y;
  scene.add(visual.root);

  // Three-quarter front view from the left, a little above, like a launch photo, framed on
  // the car's own bounds so every team's shot lines up the same in the cards.
  const bounds = new THREE.Box3().setFromObject(visual.root);
  const centre = bounds.getCenter(new THREE.Vector3());
  const radius = bounds.getSize(new THREE.Vector3()).length() / 2;
  const camera = new THREE.PerspectiveCamera(26, 960 / 540, 0.1, 100);
  const view = new THREE.Vector3(-0.72, 0.26, -0.64).normalize();
  camera.position.copy(centre).addScaledVector(view, radius / Math.sin(THREE.MathUtils.degToRad(13)) * 0.5);
  camera.lookAt(centre.x, centre.y - 0.05, centre.z);
  renderer.render(scene, camera);
  // Two frames: shadow maps and environment settle after the first.
  await new Promise((r) => requestAnimationFrame(r));
  renderer.render(scene, camera);
  (window as unknown as { carShotReady: boolean }).carShotReady = true;
}
