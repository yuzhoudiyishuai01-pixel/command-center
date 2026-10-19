/* ══════════════════════════════════════════════════════════════════════════
   流动的赛博背景
   ──────────────────────────────────────────────────────────────────────────
   画三层东西，叠加出"活的"底图：

     1. 等离子雾：4 团巨大的径向渐变，用李萨如轨迹缓慢漂移（加色混合），
        它们决定整体色相流动 —— 画面永远不会是同一个颜色。
     2. 数据流：横向掠过的细光带，像总线上的数据脉冲。
     3. 透视网格：地平线在下方，网格朝观察者涌来（synthwave 的经典纵深）。

   为什么用 canvas 而不是 CSS 动画：CSS 只能做出规则运动（平移/旋转渐变），
   做不出"雾在互相渗透"的感觉；而 4 团渐变的叠加成本很低，实测 40fps 无压力。

   性能上的取舍：
   - dpr 上限 1.5（背景不需要像素级清晰，省一半填充率）
   - 目标 40fps，帧间隔不够就跳过（背景不需要和屏幕同频）
   - 标签页隐藏时停掉 rAF；系统开启"减少动态效果"时只画一帧静图
   - 数据流的光带渐变在创建时就算好，每帧只做 translate（不重复建 Gradient）
   ══════════════════════════════════════════════════════════════════════════ */

const canvas = document.getElementById("bg-canvas");
const ctx = canvas?.getContext("2d", { alpha: true });

const TARGET_FPS = 32;
const FRAME_MS = 1000 / TARGET_FPS;
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* 雾层画在半分辨率离屏画布上，最后一帧只做一次放大合成。
   6 团雾各铺满一次屏幕 = 每帧 6 × 全屏填充；放到 1/2 分辨率后填充量只剩 1/4，
   而雾本来就是模糊的大色块，放大后肉眼看不出差别。这是主线程长任务的主要来源。 */
const ORB_SCALE = 0.5;
let orbLayer = null;
let orbCtx = null;

let width = 0;
let height = 0;
let dpr = 1;

/** 漂移的色团：颜色、基准位置（相对宽高的比例）、半径比例、轨迹参数。
 *  6 团是实测的平衡点：再多颜色会糊成一片灰紫，再少就只剩两种色相在闪。 */
const ORBS = [
  { color: [255, 46, 166], x: 0.16, y: 0.22, r: 0.66, ax: 0.09, ay: 0.07, sx: 0.13, sy: 0.19, ph: 0.0 },
  { color: [34, 233, 255], x: 0.84, y: 0.16, r: 0.6, ax: 0.08, ay: 0.06, sx: 0.16, sy: 0.11, ph: 1.7 },
  { color: [139, 92, 255], x: 0.6, y: 0.76, r: 0.7, ax: 0.11, ay: 0.08, sx: 0.1, sy: 0.15, ph: 3.1 },
  { color: [184, 255, 46], x: 0.28, y: 0.88, r: 0.34, ax: 0.07, ay: 0.05, sx: 0.21, sy: 0.17, ph: 4.4 },
  { color: [255, 92, 214], x: 0.46, y: 0.44, r: 0.42, ax: 0.13, ay: 0.1, sx: 0.07, sy: 0.21, ph: 2.3 },
  { color: [90, 120, 255], x: 0.72, y: 0.56, r: 0.5, ax: 0.1, ay: 0.09, sx: 0.12, sy: 0.07, ph: 5.6 },
];

/** 鼠标视差：目标值由 pointermove 写入，实际值每帧 lerp 追过去。 */
const pointer = { tx: 0, ty: 0, x: 0, y: 0 };

const streams = [];

function makeStream(initial = false) {
  const palette = [
    [255, 46, 166],
    [34, 233, 255],
    [139, 92, 255],
    [184, 255, 46],
  ];
  const rgb = palette[(Math.random() * palette.length) | 0];
  const len = 70 + Math.random() * 280;
  const stream = {
    rgb,
    len,
    y: Math.random(),
    speed: 50 + Math.random() * 220,
    alpha: 0.1 + Math.random() * 0.3,
    width: Math.random() < 0.78 ? 1 : 2,
    // 起点随机分布，避免开场时全部从左边一起冲出来
    x: initial ? Math.random() * (width + len * 2) - len : -len,
  };
  return stream;
}

function buildStreamGradient(stream) {
  // 每个流一条"透明 → 亮 → 透明"的横向渐变；长度变化时才重建
  const grad = ctx.createLinearGradient(0, 0, stream.len, 0);
  const [r, g, b] = stream.rgb;
  grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0)`);
  grad.addColorStop(0.55, `rgba(${r}, ${g}, ${b}, ${stream.alpha})`);
  grad.addColorStop(0.85, `rgba(${r}, ${g}, ${b}, ${stream.alpha * 0.55})`);
  grad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
  return grad;
}

function resize() {
  if (!canvas || !ctx) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  dpr = Math.min(window.devicePixelRatio || 1, 1.35);
  width = w;
  height = h;
  canvas.width = Math.max(1, Math.round(w * dpr));
  canvas.height = Math.max(1, Math.round(h * dpr));
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  resizeOrbLayer();

  // 光带数量随窗口面积走：小窗口别画太多，大屏别太空
  const want = Math.min(110, Math.max(34, Math.round((w * h) / 22000)));
  streams.length = 0;
  for (let i = 0; i < want; i += 1) {
    const stream = makeStream(true);
    stream.grad = buildStreamGradient(stream);
    streams.push(stream);
  }

  if (!particleSprites) makeParticleSprites();
  seedParticles();
}

function resizeOrbLayer() {
  orbLayer = document.createElement("canvas");
  orbLayer.width = Math.max(1, Math.round(width * ORB_SCALE));
  orbLayer.height = Math.max(1, Math.round(height * ORB_SCALE));
  orbCtx = orbLayer.getContext("2d", { alpha: true });
  // 逻辑坐标仍是 CSS 像素，由变换负责缩到离屏分辨率
  orbCtx.setTransform(ORB_SCALE, 0, 0, ORB_SCALE, 0, 0);
}

function drawOrbs(time) {
  if (!orbCtx) return;
  orbCtx.clearRect(0, 0, width, height);
  orbCtx.globalCompositeOperation = "lighter";
  const minSide = Math.min(width, height);
  for (const orb of ORBS) {
    const cx =
      (orb.x + Math.sin(time * orb.sx + orb.ph) * orb.ax) * width +
      pointer.x * (orb.r * 26);
    const cy =
      (orb.y + Math.cos(time * orb.sy + orb.ph) * orb.ay) * height +
      pointer.y * (orb.r * 20);
    const radius = orb.r * minSide * 1.2;
    // 色团的生命周期亮度：缓慢呼吸，让画面有"能量在呼吸"的感觉。
    // 面板都是半透明玻璃，这里的亮度直接决定界面"活"到什么程度——
    // 太低像纯黑皮肤，太高正文会失去对比度，0.26~0.6 是实测的甜点区（v2 调高过）。
    const breathe = 0.5 + 0.5 * Math.sin(time * 0.45 + orb.ph * 1.7);
    const alpha = 0.26 + breathe * 0.3;
    const [r, g, b] = orb.color;
    const grad = orbCtx.createRadialGradient(cx, cy, 0, cx, cy, radius);
    grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${alpha})`);
    grad.addColorStop(0.42, `rgba(${r}, ${g}, ${b}, ${alpha * 0.42})`);
    grad.addColorStop(0.72, `rgba(${r}, ${g}, ${b}, ${alpha * 0.1})`);
    grad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
    orbCtx.fillStyle = grad;
    // 只铺渐变的外接矩形：圆外全是全透明像素，铺满整屏是纯浪费。
    const x0 = Math.max(0, cx - radius);
    const y0 = Math.max(0, cy - radius);
    const x1 = Math.min(width, cx + radius);
    const y1 = Math.min(height, cy + radius);
    if (x1 > x0 && y1 > y0) orbCtx.fillRect(x0, y0, x1 - x0, y1 - y0);
  }
  orbCtx.globalCompositeOperation = "source-over";

  // 一次性放大合成到主画布（加色，保持和原来逐团叠加一致的观感）
  ctx.globalCompositeOperation = "lighter";
  ctx.drawImage(orbLayer, 0, 0, width, height);
  ctx.globalCompositeOperation = "source-over";
}

function drawStreams(dt) {
  ctx.globalCompositeOperation = "lighter";
  ctx.lineCap = "round";
  for (const stream of streams) {
    stream.x += stream.speed * dt;
    if (stream.x > width + stream.len) {
      Object.assign(stream, makeStream(false));
      stream.grad = buildStreamGradient(stream);
    }
    ctx.save();
    ctx.translate(stream.x - stream.len, stream.y * height + pointer.y * 6);
    ctx.strokeStyle = stream.grad;
    ctx.lineWidth = stream.width;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(stream.len, 0);
    ctx.stroke();
    ctx.restore();
  }
  ctx.globalCompositeOperation = "source-over";
}

/* ── 漂浮光点：给背景一点"空间尘埃"，让静止画面也有微动 ──────────────────
   每个点用预渲染的 32px 光斑精灵（drawImage 缩放），而不是每帧建径向渐变——
   90 个径向渐变 × 40fps 会明显吃 CPU，精灵是 O(1)。 */
const PARTICLES = [];
let particleSprites = null;

function makeParticleSprites() {
  particleSprites = [
    [255, 46, 166],
    [34, 233, 255],
    [163, 130, 255],
  ].map(([r, g, b]) => {
    const size = 32;
    const sprite = document.createElement("canvas");
    sprite.width = size;
    sprite.height = size;
    const g2 = sprite.getContext("2d");
    const grad = g2.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, 1)`);
    grad.addColorStop(0.35, `rgba(${r}, ${g}, ${b}, 0.5)`);
    grad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
    g2.fillStyle = grad;
    g2.fillRect(0, 0, size, size);
    return sprite;
  });
}

function seedParticles() {
  PARTICLES.length = 0;
  const want = Math.min(90, Math.max(26, Math.round((width * height) / 22000)));
  for (let i = 0; i < want; i += 1) {
    PARTICLES.push({
      x: Math.random() * width,
      y: Math.random() * height,
      size: 1.1 + Math.random() * 2.6,
      speed: 7 + Math.random() * 26,
      drift: (Math.random() - 0.5) * 12,
      sprite: (Math.random() * 3) | 0,
      alpha: 0.16 + Math.random() * 0.5,
      phase: Math.random() * Math.PI * 2,
    });
  }
}

function drawParticles(dt, time) {
  if (!particleSprites) return;
  ctx.globalCompositeOperation = "lighter";
  for (const p of PARTICLES) {
    p.y -= p.speed * dt;
    p.x += Math.sin(time * 0.8 + p.phase) * p.drift * dt;
    if (p.y < -10) {
      p.y = height + 10;
      p.x = Math.random() * width;
    }
    if (p.x < -10) p.x = width + 10;
    else if (p.x > width + 10) p.x = -10;
    const s = p.size * 7;
    ctx.globalAlpha = p.alpha * (0.55 + 0.45 * Math.sin(time * 1.7 + p.phase));
    ctx.drawImage(particleSprites[p.sprite], p.x - s / 2, p.y - s / 2, s, s);
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
}

function drawGrid(time) {
  const horizon = height * (0.74 + pointer.y * 0.01);
  const cx = width * (0.5 + pointer.x * 0.02);
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.lineWidth = 1;

  // 纵向：从灭点向下发散的线，越靠近边缘越亮（透视里的"墙")
  const cols = 22;
  for (let i = 0; i <= cols; i += 1) {
    const t = i / cols;
    const bottomX = cx + (t - 0.5) * width * 2.4;
    const edge = Math.abs(t - 0.5) * 2;
    const alpha = 0.035 + edge * 0.085;
    ctx.strokeStyle =
      i % 2 === 0 ? `rgba(34, 233, 255, ${alpha})` : `rgba(255, 46, 166, ${alpha})`;
    ctx.beginPath();
    ctx.moveTo(cx, horizon);
    ctx.lineTo(bottomX, height);
    ctx.stroke();
  }

  // 横向：一圈圈朝观察者涌来的等距环（用指数间距近似透视）
  const rows = 16;
  const flow = (time * 0.16) % 1;
  for (let i = 0; i < rows; i += 1) {
    const k = (i + flow) / rows;
    const y = horizon + (height - horizon) * k * k;
    if (y <= horizon) continue;
    const alpha = Math.min(0.24, 0.03 + k * k * 0.21);
    ctx.strokeStyle = `rgba(163, 130, 255, ${alpha})`;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  // 地平线本身给一道亮线，把上下两块空间分开
  const line = ctx.createLinearGradient(0, 0, width, 0);
  line.addColorStop(0, "rgba(255, 46, 166, 0)");
  line.addColorStop(0.5, "rgba(255, 46, 166, 0.4)");
  line.addColorStop(1, "rgba(34, 233, 255, 0)");
  ctx.strokeStyle = line;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(0, horizon);
  ctx.lineTo(width, horizon);
  ctx.stroke();
  ctx.lineWidth = 1;

  ctx.restore();
}

function drawFrame(time, dt) {
  ctx.clearRect(0, 0, width, height);
  drawOrbs(time);
  drawGrid(time);
  drawParticles(dt, time);
  drawStreams(dt);
}

let last = 0;
let rafId = 0;
let paused = false;

function loop(now) {
  rafId = requestAnimationFrame(loop);
  if (paused || now - last < FRAME_MS) return;
  const dt = Math.min(0.12, (now - last) / 1000);
  last = now;

  // 视差缓动：鼠标不动时也会慢慢回正，不会一直偏着
  pointer.tx *= 0.985;
  pointer.ty *= 0.985;
  pointer.x += (pointer.tx - pointer.x) * 0.06;
  pointer.y += (pointer.ty - pointer.y) * 0.06;

  drawFrame(now / 1000, dt);
}

/* 调试/测量用的开关：`__ccBg.pause()` 之后整页完全静止，
   这样能单独量出"界面自身的开销"和"背景动画的开销"各占多少。 */
window.__ccBg = {
  pause() {
    paused = true;
    cancelAnimationFrame(rafId);
  },
  resume() {
    if (reduceMotion || !ctx) return;
    paused = false;
    last = 0;
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(loop);
  },
  stats() {
    return { width, height, dpr, fps: TARGET_FPS, streams: streams.length, particles: PARTICLES.length };
  },
};

function start() {
  if (!canvas || !ctx) return;
  resize();
  if (reduceMotion) {
    drawFrame(12.3, 0.016);
    return;
  }
  cancelAnimationFrame(rafId);
  last = 0;
  rafId = requestAnimationFrame(loop);
}

window.addEventListener("pointermove", (event) => {
  pointer.tx = (event.clientX / window.innerWidth - 0.5) * 2;
  pointer.ty = (event.clientY / window.innerHeight - 0.5) * 2;
});

let resizeTimer = 0;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    resize();
    if (reduceMotion) drawFrame(12.3, 0.016);
  }, 180);
});

document.addEventListener("visibilitychange", () => {
  if (reduceMotion || !ctx) return;
  if (document.hidden) {
    cancelAnimationFrame(rafId);
  } else {
    last = 0;
    rafId = requestAnimationFrame(loop);
  }
});

start();
