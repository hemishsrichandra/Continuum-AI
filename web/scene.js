// 3D "memory constellation": nodes are fixes, lines are what they have in common, and a spark travels along a line when a
// fix is reused. Rendered with Three.js (MIT, served from this site). Paused when off-screen or the tab is hidden,
// drawn once (no animation) for reduced-motion, and removed if WebGL is unavailable.
import * as THREE from '/vendor/three.module.min.js';

function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,.6)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

export function mountScene(canvas, { reduce = false } = {}) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' });
  } catch {
    canvas.remove();
    return;
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.75));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 50);
  camera.position.z = 2.7; // closer than before: the shell fills the hero like the approved preview
  const group = new THREE.Group();
  scene.add(group);

  // Nodes on a loose shell.
  const N = 84;
  const nodes = [];
  for (let i = 0; i < N; i++) {
    const u = Math.random() * 2 - 1, t = Math.random() * Math.PI * 2, r = Math.sqrt(1 - u * u), k = 0.62 + Math.random() * 0.38;
    nodes.push(new THREE.Vector3(r * Math.cos(t) * k, u * k, r * Math.sin(t) * k));
  }
  const edges = [];
  for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) if (nodes[i].distanceTo(nodes[j]) < 0.5) edges.push([i, j]);

  const tex = glowTexture();
  const posAll = new Float32Array(N * 3);
  const posHot = [];
  nodes.forEach((n, i) => { posAll.set([n.x, n.y, n.z], i * 3); if (i % 17 === 0) posHot.push(n.x, n.y, n.z); });
  const pointsGeo = new THREE.BufferGeometry();
  pointsGeo.setAttribute('position', new THREE.BufferAttribute(posAll, 3));
  const points = new THREE.Points(pointsGeo, new THREE.PointsMaterial({ map: tex, size: 0.09, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, color: 0x9db4ff }));
  const hotGeo = new THREE.BufferGeometry();
  hotGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(posHot), 3));
  const hot = new THREE.Points(hotGeo, new THREE.PointsMaterial({ map: tex, size: 0.26, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, color: 0xb9a6ff }));
  const lineArr = new Float32Array(edges.length * 6);
  edges.forEach(([i, j], e) => lineArr.set([nodes[i].x, nodes[i].y, nodes[i].z, nodes[j].x, nodes[j].y, nodes[j].z], e * 6));
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.BufferAttribute(lineArr, 3));
  const lines = new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({ color: 0x8ca5ff, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false }));
  const sparks = Array.from({ length: 6 }, () => ({ e: Math.floor(Math.random() * edges.length), t: Math.random() }));
  const sparkGeo = new THREE.BufferGeometry();
  sparkGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(sparks.length * 3), 3));
  const sparkPoints = new THREE.Points(sparkGeo, new THREE.PointsMaterial({ map: tex, size: 0.16, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, color: 0x5ee6b0 }));
  group.add(lines, points, hot, sparkPoints);

  const palette = () => {
    const light = document.documentElement.dataset.theme === 'light';
    points.material.color.set(light ? 0x4660e6 : 0x9db4ff);
    lines.material.color.set(light ? 0x4660e6 : 0x8ca5ff);
    lines.material.opacity = light ? 0.3 : 0.22;
    hot.material.color.set(light ? 0x8b6df0 : 0xb9a6ff);
    const mode = light ? THREE.NormalBlending : THREE.AdditiveBlending;
    [points, hot, lines, sparkPoints].forEach((o) => { o.material.blending = mode; o.material.needsUpdate = true; });
  };
  palette();
  new MutationObserver(palette).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  const size = () => {
    const w = canvas.clientWidth || 1, h = canvas.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  new ResizeObserver(size).observe(canvas);
  size();

  let mx = 0, my = 0, spin = 0, visible = true, last = performance.now();
  addEventListener('pointermove', (e) => { mx = e.clientX / innerWidth - 0.5; my = e.clientY / innerHeight - 0.5; }, { passive: true });
  new IntersectionObserver((e) => { visible = e[0].isIntersecting; }).observe(canvas);

  const draw = (now) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    spin += dt * 0.24; // about one turn every 26 s (was one every 63 s)
    group.rotation.y += (spin + mx * 0.9 - group.rotation.y) * 0.08;
    group.rotation.x += (my * 0.5 - group.rotation.x) * 0.04;
    hot.material.size = 0.26 + Math.sin(now / 600) * 0.05;
    const attr = sparkGeo.attributes.position;
    sparks.forEach((s, i) => {
      s.t += dt * 0.7;
      if (s.t > 1) { s.t = 0; s.e = Math.floor(Math.random() * edges.length); }
      const [a, b] = edges[s.e];
      attr.setXYZ(i, nodes[a].x + (nodes[b].x - nodes[a].x) * s.t, nodes[a].y + (nodes[b].y - nodes[a].y) * s.t, nodes[a].z + (nodes[b].z - nodes[a].z) * s.t);
    });
    attr.needsUpdate = true;
    renderer.render(scene, camera);
  };
  if (reduce) { draw(performance.now()); return; }
  const loop = (now) => {
    if (visible && !document.hidden) draw(now);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
