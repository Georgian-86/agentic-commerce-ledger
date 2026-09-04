// A hand-rolled 3D hash-chain, drawn on a 2D canvas.
//
// No library. Each "block" is a cube; blocks are strung along a gentle
// arc through space and linked by a bright edge. The whole rig rotates
// slowly and parallaxes to the pointer. When the ledger appends an
// event, addBlock() pushes a new cube at the head with a mint "seal"
// pulse that ripples back down the chain — the visual echo of each
// record's hash depending on the one before it.
//
// Respects prefers-reduced-motion: renders one static isometric frame.

const REDUCE = matchMedia("(prefers-reduced-motion: reduce)").matches;

export function createChain3D(canvas, opts = {}) {
  const ctx = canvas.getContext("2d");
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cfg = {
    count: opts.count ?? 6,
    size: opts.size ?? 0.62,
    gap: opts.gap ?? 1.5,
    arc: opts.arc ?? 0.34,
    spin: opts.spin ?? 0.0022,
    fov: opts.fov ?? 3.2,
    accent: opts.accent ?? "#A99BFF",
    accentDeep: opts.accentDeep ?? "#6D5CE0",
    mint: opts.mint ?? "#5FE9D4",
    faint: opts.faint ?? "rgba(139,124,246,0.10)",
    interactive: opts.interactive ?? true,
  };

  let W = 0, H = 0;
  let yaw = -0.5, pitch = 0.32;
  let targetYaw = yaw, targetPitch = pitch;
  let t = 0;
  const blocks = [];
  let raf = 0;
  let running = false;

  for (let i = 0; i < cfg.count; i++) blocks.push(mkBlock(i, 1));

  function mkBlock(i, life) {
    return { i, life, seal: 0 };
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    W = Math.max(1, rect.width);
    H = Math.max(1, rect.height);
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // --- 3D maths ---
  function rotY(p, a) { const c = Math.cos(a), s = Math.sin(a); return [p[0] * c + p[2] * s, p[1], -p[0] * s + p[2] * c]; }
  function rotX(p, a) { const c = Math.cos(a), s = Math.sin(a); return [p[0], p[1] * c - p[2] * s, p[1] * s + p[2] * c]; }
  function project(p) {
    let q = rotX(rotY(p, yaw), pitch);
    q = [q[0], q[1], q[2] + 8]; // camera pushback
    const z = Math.max(0.1, q[2]);
    const k = (cfg.fov * Math.min(W, H) * 0.5) / z;
    return [W / 2 + q[0] * k, H / 2 + q[1] * k, z];
  }

  function blockCenter(i, n) {
    const mid = (n - 1) / 2;
    const x = (i - mid) * cfg.gap;
    const y = Math.sin((i - mid) * 0.6) * cfg.arc;
    const z = Math.cos((i - mid) * 0.5) * cfg.arc * 1.4;
    return [x, y, z];
  }

  const CUBE = (() => {
    const v = [];
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) v.push([sx, sy, sz]);
    const faces = [
      [0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1],
      [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3],
    ];
    return { v, faces };
  })();

  function drawCube(center, s, alpha, sealGlow) {
    const verts = CUBE.v.map((p) => project([center[0] + p[0] * s, center[1] + p[1] * s, center[2] + p[2] * s]));
    const polys = CUBE.faces.map((f) => {
      const pts = f.map((i) => verts[i]);
      const zAvg = pts.reduce((a, p) => a + p[2], 0) / 4;
      return { pts, zAvg };
    }).sort((a, b) => b.zAvg - a.zAvg);

    for (let fi = 0; fi < polys.length; fi++) {
      const { pts } = polys[fi];
      const front = fi >= 3;
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < 4; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.closePath();
      ctx.fillStyle = front ? withAlpha(cfg.accent, 0.05 * alpha) : cfg.faint;
      ctx.fill();
      ctx.lineWidth = front ? 1.4 : 0.8;
      ctx.strokeStyle = sealGlow > 0.01
        ? blend(cfg.accent, cfg.mint, sealGlow)
        : withAlpha(cfg.accent, (front ? 0.9 : 0.35) * alpha);
      ctx.stroke();
    }

    if (sealGlow > 0.01) {
      const c = project(center);
      const g = ctx.createRadialGradient(c[0], c[1], 0, c[0], c[1], 60 * sealGlow);
      g.addColorStop(0, withAlpha(cfg.mint, 0.5 * sealGlow));
      g.addColorStop(1, "transparent");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(c[0], c[1], 60 * sealGlow, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawLink(a, b, glow) {
    const p1 = project(a), p2 = project(b);
    ctx.beginPath();
    ctx.moveTo(p1[0], p1[1]);
    ctx.lineTo(p2[0], p2[1]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = glow > 0.01 ? blend(cfg.accentDeep, cfg.mint, glow) : withAlpha(cfg.accentDeep, 0.55);
    ctx.stroke();

    // travelling spark
    const f = (t * 0.6) % 1;
    const sx = p1[0] + (p2[0] - p1[0]) * f;
    const sy = p1[1] + (p2[1] - p1[1]) * f;
    ctx.beginPath();
    ctx.arc(sx, sy, 2.1, 0, Math.PI * 2);
    ctx.fillStyle = withAlpha(cfg.mint, 0.9);
    ctx.fill();
  }

  function frame() {
    if (!running) return;
    t += REDUCE ? 0 : 0.016;
    if (!REDUCE) {
      targetYaw += cfg.spin;
      yaw += (targetYaw - yaw) * 0.06;
      pitch += (targetPitch - pitch) * 0.06;
    }

    ctx.clearRect(0, 0, W, H);

    // life-in / seal decay
    const n = blocks.length;
    for (const b of blocks) {
      b.life = Math.min(1, b.life + 0.05);
      b.seal = Math.max(0, b.seal - 0.02);
    }

    // links first (behind), then cubes sorted far->near
    const centers = blocks.map((b) => blockCenter(b.i, n));
    for (let i = 0; i < n - 1; i++) {
      const glow = Math.max(blocks[i].seal, blocks[i + 1].seal) * 0.8;
      drawLink(centers[i], centers[i + 1], glow);
    }
    const order = blocks.map((b, i) => ({ b, c: centers[i], z: project(centers[i])[2] }))
      .sort((a, z) => z.z - a.z);
    for (const { b, c } of order) {
      const s = cfg.size * (0.4 + 0.6 * easeOut(b.life));
      drawCube(c, s, b.life, b.seal);
    }

    raf = requestAnimationFrame(frame);
  }

  function easeOut(x) { return 1 - Math.pow(1 - x, 3); }

  // --- public ---
  function start() {
    if (running) return;
    running = true;
    resize();
    if (REDUCE) { frameOnce(); return; }
    raf = requestAnimationFrame(frame);
  }
  function frameOnce() {
    yaw = -0.6; pitch = 0.4;
    ctx.clearRect(0, 0, W, H);
    const n = blocks.length;
    const centers = blocks.map((b) => blockCenter(b.i, n));
    for (let i = 0; i < n - 1; i++) drawLink(centers[i], centers[i + 1], 0);
    centers.map((c, i) => ({ c, z: project(c)[2] })).sort((a, b) => b.z - a.z)
      .forEach(({ c }) => drawCube(c, cfg.size, 1, 0));
  }
  function stop() { running = false; cancelAnimationFrame(raf); }

  function addBlock() {
    const nextI = (blocks[blocks.length - 1]?.i ?? -1) + 1;
    blocks.push(mkBlock(nextI, 0));
    if (blocks.length > cfg.count) blocks.shift();
    // reindex so the arc formula stays centred
    blocks.forEach((b, k) => (b.i = k));
    // ripple a seal pulse from head backwards
    blocks[blocks.length - 1].seal = 1;
    let k = blocks.length - 2;
    const rip = setInterval(() => {
      if (k < 0) return clearInterval(rip);
      if (blocks[k]) blocks[k].seal = 0.7;
      k--;
    }, 70);
    if (REDUCE) frameOnce();
  }

  function onPointer(e) {
    if (!cfg.interactive || REDUCE) return;
    const r = canvas.getBoundingClientRect();
    const nx = ((e.clientX - r.left) / r.width) * 2 - 1;
    const ny = ((e.clientY - r.top) / r.height) * 2 - 1;
    targetYaw = -0.5 + nx * 0.5;
    targetPitch = 0.32 + ny * 0.3;
  }

  const ro = new ResizeObserver(() => resize());
  ro.observe(canvas);
  if (cfg.interactive) window.addEventListener("pointermove", onPointer, { passive: true });

  function destroy() {
    stop();
    ro.disconnect();
    window.removeEventListener("pointermove", onPointer);
  }

  return { start, stop, addBlock, destroy, setCount: (c) => (cfg.count = c) };
}

// --- colour utils ---
function withAlpha(hex, a) {
  const [r, g, b] = hexRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}
function blend(h1, h2, t) {
  const a = hexRgb(h1), b = hexRgb(h2);
  const m = a.map((v, i) => Math.round(v + (b[i] - v) * t));
  return `rgb(${m[0]},${m[1]},${m[2]})`;
}
function hexRgb(hex) {
  const s = hex.replace("#", "");
  const n = s.length === 3 ? s.split("").map((c) => c + c).join("") : s;
  return [parseInt(n.slice(0, 2), 16), parseInt(n.slice(2, 4), 16), parseInt(n.slice(4, 6), 16)];
}
