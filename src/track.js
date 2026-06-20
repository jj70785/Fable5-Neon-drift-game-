// ============================================================================
// Tracks: Catmull-Rom centerline splines → resampled centerline → offset
// inner/outer wall polylines → wall segments in a spatial hash for cheap
// collision queries. Also: checkpoint gates (lap validation + respawn),
// Path2D render caches, and a pre-rendered minimap.
//
// Coordinates are world pixels, y-down (canvas convention).
// ============================================================================

import { CONFIG } from './config.js';
import { resolveWallHit } from './physics.js';

const HASH_CELL = 128;

// ---------------------------------------------------------------- track defs
// Handcrafted control points (closed loops). Layout notes:
//  - min corner radius must stay well above width/2 so offset walls don't fold
//  - all tracks run the same way around for consistent muscle memory
// Surface patches are circles placed on the road: {t, x, y, r}
//   ice   — grip falls off a cliff; you slide everywhere
//   mud   — heavy drag, kills drifts, scrubs speed (tempting corner-cut trap)
//   boost — green chevron pad that flings you forward
export const TRACK_DEFS = [
  {
    id: 'sunset',
    name: 'SUNSET LOOP',
    diff: 'FLOWING',
    width: 168,
    desc: 'Wide and fast. Learn the car here.',
    // medal targets: total = LAPS * length / (fraction * TOP_SPEED), see DESIGN.md
    medalSpeed: { gold: 0.62, silver: 0.54, bronze: 0.44 },
    colors: { outer: '#00f0ff', inner: '#ff2d95' },
    points: [
      [-1100, 980], [-400, 1020], [400, 1000], [1000, 920], [1300, 800],
      [1560, 560], [1680, 180], [1620, -260], [1350, -660], [940, -890],
      [380, -990], [-260, -1000], [-860, -910], [-1180, -780], [-1450, -540],
      [-1560, -240], [-1530, 80], [-1380, 380], [-1330, 660], [-1260, 870],
    ],
    surfaces: [
      { t: 'boost', x: 300, y: 1010, r: 66 },
      { t: 'ice', x: -300, y: -995, w: 160, h: 300 },
      { t: 'boost', x: -1500, y: 120, r: 64 },
    ],
  },
  {
    id: 'royale',
    name: 'CIRCUIT ROYALE',
    diff: 'TECHNICAL',
    width: 132,
    desc: 'Chicanes and a hairpin. Precision pays.',
    medalSpeed: { gold: 0.54, silver: 0.47, bronze: 0.385 },
    colors: { outer: '#00f0ff', inner: '#ffe14d' },
    points: [
      [-1300, 940], [-800, 950], [0, 950], [700, 950], [1250, 880],
      [1550, 600], [1600, 200], [1500, -150], [1250, -380], [950, -430],
      [700, -300], [450, -420], [100, -470], [-350, -480], [-800, -560],
      [-1200, -700], [-1500, -830], [-1660, -620], [-1560, -380], [-1260, -330],
      [-1000, -180], [-900, 100], [-1050, 380], [-1300, 520], [-1430, 700],
      [-1410, 870],
    ],
    surfaces: [
      { t: 'mud', x: 700, y: -300, r: 92 },
      { t: 'boost', x: 0, y: 950, r: 60 },
      { t: 'ice', x: -1050, y: 380, w: 130, h: 260 },
    ],
  },
  {
    id: 'vice',
    name: 'VICE SPIRAL',
    diff: 'DRIFT HEAVEN',
    width: 150,
    desc: 'High-speed sweepers into tight hairpins.',
    medalSpeed: { gold: 0.57, silver: 0.495, bronze: 0.405 },
    colors: { outer: '#ff2d95', inner: '#00f0ff' },
    points: [
      [-1050, 1150], [-300, 1190], [500, 1180], [1250, 1080], [1850, 800],
      [2200, 300], [2250, -300], [2000, -800], [1500, -1120], [800, -1260],
      [0, -1290], [-800, -1260], [-1350, -1080], [-1620, -750], [-1600, -480],
      [-1350, -360], [-800, -330], [-100, -340], [600, -330], [1100, -290],
      [1480, -130], [1560, 130], [1350, 320], [900, 360], [200, 350],
      [-500, 360], [-1100, 400], [-1480, 520], [-1580, 800], [-1380, 1020],
    ],
    surfaces: [
      { t: 'ice', x: 500, y: 1180, w: 150, h: 320 },
      { t: 'ice', x: 0, y: -1290, w: 150, h: 340 },
      { t: 'boost', x: 2150, y: 0, r: 74 },
      { t: 'mud', x: 200, y: 350, r: 112 },
    ],
  },
  {
    id: 'aurora',
    name: 'AURORA BAY',
    diff: 'COASTAL',
    width: 170,
    desc: 'Long neon sweepers by the water. Pure flow.',
    medalSpeed: { gold: 0.6, silver: 0.52, bronze: 0.42 },
    colors: { outer: '#22e6c8', inner: '#ff2d95' },
    points: [
      [-1500, 1100], [-700, 1200], [200, 1220], [1000, 1150], [1500, 950],
      [1750, 600], [1820, 150], [1750, -350], [1500, -750], [1050, -1000],
      [450, -1120], [-250, -1130], [-950, -1050], [-1450, -820], [-1700, -450],
      [-1780, 0], [-1700, 450], [-1550, 800],
    ],
    surfaces: [
      { t: 'boost', x: 200, y: 1220, r: 74 },
      { t: 'boost', x: 1750, y: -350, r: 72 },
      { t: 'ice', x: -1780, y: 0, w: 168, h: 320 },
    ],
  },
  {
    id: 'toxic',
    name: 'TOXIC MILE',
    diff: 'HAZARD',
    width: 142,
    desc: 'Ice, mud and boost everywhere. Pick your line.',
    medalSpeed: { gold: 0.5, silver: 0.43, bronze: 0.36 },
    colors: { outer: '#ff2d95', inner: '#ffe14d' },
    points: [
      [-1350, 850], [-650, 920], [100, 920], [750, 880], [1250, 760],
      [1500, 480], [1480, 150], [1250, -50], [950, -60], [780, -260],
      [980, -520], [1320, -640], [1480, -920], [1250, -1150], [800, -1200],
      [150, -1170], [-500, -1100], [-1050, -950], [-1400, -650], [-1500, -280],
      [-1400, 60], [-1180, 300], [-1300, 600], [-1430, 820],
    ],
    surfaces: [
      { t: 'mud', x: 820, y: -300, r: 86 },
      { t: 'ice', x: 150, y: -1170, w: 140, h: 300 },
      { t: 'boost', x: -1500, y: -280, r: 66 },
      { t: 'ice', x: -1200, y: 250, w: 138, h: 240 },
      { t: 'boost', x: 100, y: 920, r: 64 },
    ],
  },
];

// ------------------------------------------------------------------- helpers
function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
    (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

function segClosest(px, py, x1, y1, x2, y2, out) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  out.x = x1 + dx * t;
  out.y = y1 + dy * t;
}

function hexRgb(hex) {
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}
function rgba(c, a) { return `rgba(${c.r},${c.g},${c.b},${a})`; }

// segment AB crosses segment CD?
export function segsIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
  const d1 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d2 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  if ((d1 > 0 && d2 > 0) || (d1 < 0 && d2 < 0)) return false;
  const d3 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const d4 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  if ((d3 > 0 && d4 > 0) || (d3 < 0 && d4 < 0)) return false;
  return true;
}

// ---------------------------------------------------------------- Track class
export class Track {
  constructor(def, index) {
    this.def = def;
    this.index = index;
    this.name = def.name;
    this.width = def.width;
    this._build();
    this._buildPaths();
    this._buildSurfaces();
    this._buildMinimap();
    this._tmp = { x: 0, y: 0 };
  }

  // ---- surface patches (ice / mud / boost) ----
  // A patch is a circle {t,x,y,r} (mud/boost) or a rect {t,x,y,w,h} oriented
  // along the track tangent — an icy *stretch* of road (w across, h along).
  _buildSurfaces() {
    this.surfaces = (this.def.surfaces || []).map((s) => {
      // nearest centerline tangent: gives boost its shove direction and rects
      // their orientation along the road
      let best = 0, bd = 1e18;
      for (let i = 0; i < this.n; i++) {
        const dx = this.cx[i] - s.x, dy = this.cy[i] - s.y;
        const d = dx * dx + dy * dy;
        if (d < bd) { bd = d; best = i; }
      }
      const tx = this.tx[best], ty = this.ty[best];
      const p = { t: s.t, x: s.x, y: s.y, tx, ty, rect: s.w != null };
      if (p.rect) { p.w = s.w; p.h = s.h; }     // w across the road, h along it
      else { p.r = s.r; p.r2 = s.r * s.r; }
      return p;
    });
  }

  // which surface is the point on? null = plain asphalt. first match wins.
  surfaceAt(x, y) {
    const S = this.surfaces;
    for (let i = 0; i < S.length; i++) {
      const p = S[i], dx = x - p.x, dy = y - p.y;
      if (p.rect) {
        // project into the patch's local frame: along = tangent, across = normal
        const along = dx * p.tx + dy * p.ty;
        const across = -dx * p.ty + dy * p.tx;
        if (Math.abs(along) <= p.h / 2 && Math.abs(across) <= p.w / 2) return p;
      } else if (dx * dx + dy * dy <= p.r2) {
        return p;
      }
    }
    return null;
  }

  // ---- geometry ----
  _build() {
    const pts = this.def.points;
    const n = pts.length;

    // dense sampling of the closed Catmull-Rom spline
    const SUB = 24;
    const rawX = [], rawY = [];
    for (let i = 0; i < n; i++) {
      const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
      for (let j = 0; j < SUB; j++) {
        const t = j / SUB;
        rawX.push(catmullRom(p0[0], p1[0], p2[0], p3[0], t));
        rawY.push(catmullRom(p0[1], p1[1], p2[1], p3[1], t));
      }
    }

    // resample to uniform ~12 px spacing (arc length)
    const SPACING = 12;
    const m0 = rawX.length;
    let total = 0;
    const segLen = new Float64Array(m0);
    for (let i = 0; i < m0; i++) {
      const j = (i + 1) % m0;
      segLen[i] = Math.hypot(rawX[j] - rawX[i], rawY[j] - rawY[i]);
      total += segLen[i];
    }
    const count = Math.max(64, Math.round(total / SPACING));
    const step = total / count;

    const cx = new Float32Array(count), cy = new Float32Array(count);
    let acc = 0, idx = 0;
    let target = 0;
    for (let k = 0; k < count; k++) {
      target = k * step;
      while (acc + segLen[idx] < target) { acc += segLen[idx]; idx = (idx + 1) % m0; }
      const t = segLen[idx] > 0 ? (target - acc) / segLen[idx] : 0;
      const j = (idx + 1) % m0;
      cx[k] = rawX[idx] + (rawX[j] - rawX[idx]) * t;
      cy[k] = rawY[idx] + (rawY[j] - rawY[idx]) * t;
    }

    this.n = count;
    this.cx = cx; this.cy = cy;
    this.length = total;
    this.spacing = step;

    // tangents (central differences) + normals
    const tx = new Float32Array(count), ty = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const a = (i - 1 + count) % count, b = (i + 1) % count;
      let dx = cx[b] - cx[a], dy = cy[b] - cy[a];
      const d = Math.hypot(dx, dy) || 1;
      tx[i] = dx / d; ty[i] = dy / d;
    }
    this.tx = tx; this.ty = ty;

    // wall polylines (offset along left normal (-ty, tx))
    const hw = this.width / 2;
    const inX = new Float32Array(count), inY = new Float32Array(count);
    const outX = new Float32Array(count), outY = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const nx = -ty[i], ny = tx[i];
      inX[i] = cx[i] - nx * hw; inY[i] = cy[i] - ny * hw;
      outX[i] = cx[i] + nx * hw; outY[i] = cy[i] + ny * hw;
    }
    this.inX = inX; this.inY = inY; this.outX = outX; this.outY = outY;

    // wall segments: [x1,y1,x2,y2,nx,ny] with n pointing INTO the track
    const segs = new Float32Array(count * 2 * 6);
    let s = 0;
    const pushSeg = (x1, y1, x2, y2, refX, refY) => {
      let nx = -(y2 - y1), ny = (x2 - x1);
      const d = Math.hypot(nx, ny) || 1;
      nx /= d; ny /= d;
      // orient toward the centerline reference point
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      if ((refX - mx) * nx + (refY - my) * ny < 0) { nx = -nx; ny = -ny; }
      segs[s++] = x1; segs[s++] = y1; segs[s++] = x2; segs[s++] = y2;
      segs[s++] = nx; segs[s++] = ny;
    };
    for (let i = 0; i < count; i++) {
      const j = (i + 1) % count;
      pushSeg(inX[i], inY[i], inX[j], inY[j], cx[i], cy[i]);
      pushSeg(outX[i], outY[i], outX[j], outY[j], cx[i], cy[i]);
    }
    this.segs = segs;
    this.segCount = count * 2;

    // bounds (with margin for skid canvas / minimap)
    let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    for (let i = 0; i < count; i++) {
      if (outX[i] < minX) minX = outX[i];
      if (outX[i] > maxX) maxX = outX[i];
      if (outY[i] < minY) minY = outY[i];
      if (outY[i] > maxY) maxY = outY[i];
      if (inX[i] < minX) minX = inX[i];
      if (inX[i] > maxX) maxX = inX[i];
      if (inY[i] < minY) minY = inY[i];
      if (inY[i] > maxY) maxY = inY[i];
    }
    this.bounds = { minX: minX - 60, minY: minY - 60, maxX: maxX + 60, maxY: maxY + 60 };

    // spatial hash of wall segments
    this.hash = new Map();
    for (let i = 0; i < this.segCount; i++) {
      const o = i * 6;
      const x1 = segs[o], y1 = segs[o + 1], x2 = segs[o + 2], y2 = segs[o + 3];
      const cMinX = Math.floor(Math.min(x1, x2) / HASH_CELL), cMaxX = Math.floor(Math.max(x1, x2) / HASH_CELL);
      const cMinY = Math.floor(Math.min(y1, y2) / HASH_CELL), cMaxY = Math.floor(Math.max(y1, y2) / HASH_CELL);
      for (let cyc = cMinY; cyc <= cMaxY; cyc++) {
        for (let cxc = cMinX; cxc <= cMaxX; cxc++) {
          const key = cxc * 100003 + cyc;
          let arr = this.hash.get(key);
          if (!arr) { arr = []; this.hash.set(key, arr); }
          arr.push(i);
        }
      }
    }
    this._stamp = new Int32Array(this.segCount);
    this._stampId = 0;
    this.lastHit = { x: 0, y: 0, nx: 0, ny: 0, impact: 0 };

    // checkpoint gates every ~CHECKPOINT_EVERY of the lap (start line = gate 0)
    const gateCount = Math.max(4, Math.round(1 / CONFIG.RACE.CHECKPOINT_EVERY));
    this.gates = [];
    for (let g = 0; g < gateCount; g++) {
      const i = Math.round(g * count / gateCount) % count;
      this.gates.push({
        i,
        x1: inX[i], y1: inY[i], x2: outX[i], y2: outY[i],
        cx: cx[i], cy: cy[i],
        tx: tx[i], ty: ty[i],
        heading: Math.atan2(ty[i], tx[i]),
      });
    }

    this.startPose = {
      x: cx[0], y: cy[0],
      heading: Math.atan2(ty[0], tx[0]),
    };

    // medal targets (seconds), derived from length & average-speed fractions
    const ms = this.def.medalSpeed;
    const laps = CONFIG.RACE.LAPS;
    this.medals = {
      gold: Math.ceil(laps * this.length / (ms.gold * CONFIG.CAR.TOP_SPEED)),
      silver: Math.ceil(laps * this.length / (ms.silver * CONFIG.CAR.TOP_SPEED)),
      bronze: Math.ceil(laps * this.length / (ms.bronze * CONFIG.CAR.TOP_SPEED)),
    };
  }

  // ---- render caches ----
  _buildPaths() {
    const mk = (xs, ys) => {
      const p = new Path2D();
      p.moveTo(xs[0], ys[0]);
      for (let i = 1; i < this.n; i++) p.lineTo(xs[i], ys[i]);
      p.closePath();
      return p;
    };
    this.centerPath = mk(this.cx, this.cy);
    this.innerPath = mk(this.inX, this.inY);
    this.outerPath = mk(this.outX, this.outY);

    // edge polylines split into bbox'd chunks so the render loop strokes
    // only what's on screen (long Path2D strokes are CPU-heavy offscreen too)
    const CHUNK = 40;
    const mkChunks = (xs, ys) => {
      const chunks = [];
      for (let s = 0; s < this.n; s += CHUNK) {
        const e = Math.min(s + CHUNK, this.n);
        const p = new Path2D();
        p.moveTo(xs[s], ys[s]);
        let minX = xs[s], maxX = xs[s], minY = ys[s], maxY = ys[s];
        for (let i = s + 1; i <= e; i++) {
          const j = i % this.n;
          p.lineTo(xs[j], ys[j]);
          if (xs[j] < minX) minX = xs[j];
          if (xs[j] > maxX) maxX = xs[j];
          if (ys[j] < minY) minY = ys[j];
          if (ys[j] > maxY) maxY = ys[j];
        }
        chunks.push({ path: p, minX: minX - 12, maxX: maxX + 12, minY: minY - 12, maxY: maxY + 12 });
      }
      return chunks;
    };
    this.innerChunks = mkChunks(this.inX, this.inY);
    this.outerChunks = mkChunks(this.outX, this.outY);

    // start line checker geometry (two rows across the track at gate 0)
    const i0 = 0;
    const nx = -this.ty[i0], ny = this.tx[i0];
    this.startLine = {
      cx: this.cx[i0], cy: this.cy[i0],
      nx, ny, tx: this.tx[i0], ty: this.ty[i0],
      halfW: this.width / 2,
    };

    // pre-built stroke styles so the render loop never builds strings
    const oc = hexRgb(this.def.colors.outer);
    const ic = hexRgb(this.def.colors.inner);
    this.renderColors = {
      halo: rgba(oc, 0.04),
      halo2: rgba(oc, 0.05),
      outerStrokes: [
        [rgba(oc, 0.10), 11],
        [rgba(oc, 0.30), 4.5],
        [rgba(oc, 0.95), 2],
      ],
      innerStrokes: [
        [rgba(ic, 0.10), 11],
        [rgba(ic, 0.30), 4.5],
        [rgba(ic, 0.95), 2],
      ],
    };
  }

  // ---- baked base layer ----
  // Halo, asphalt, shading, dashes and the start line never change, so they
  // are rendered once to an offscreen canvas at reduced scale and blitted.
  // Only the two crisp neon core lines are stroked live each frame.
  bake() {
    if (this.baked) return;
    const s = 0.55;
    // expand the baked canvas to also hold the roadside scenery, so the whole
    // backdrop is ONE blit per frame instead of two (scenery used to cost a
    // second full-screen drawImage — ~4 FPS under software rendering)
    const bb = this.bounds, pad = 360;
    const b = { minX: bb.minX - pad, minY: bb.minY - pad, maxX: bb.maxX + pad, maxY: bb.maxY + pad };
    const W = Math.ceil((b.maxX - b.minX) * s), H = Math.ceil((b.maxY - b.minY) * s);
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    g.setTransform(s, 0, 0, s, -b.minX * s, -b.minY * s);
    g.lineJoin = 'round'; g.lineCap = 'round';
    const tc = this.renderColors;

    this._drawScenery(g);   // props go down first, the road covers them

    g.strokeStyle = tc.halo; g.lineWidth = this.width + 86; g.stroke(this.centerPath);
    g.strokeStyle = tc.halo2; g.lineWidth = this.width + 30; g.stroke(this.centerPath);
    g.strokeStyle = CONFIG.COLORS.ASPHALT; g.lineWidth = this.width; g.stroke(this.centerPath);
    g.strokeStyle = 'rgba(0,0,0,0.18)'; g.lineWidth = this.width - 20; g.stroke(this.centerPath);
    g.strokeStyle = 'rgba(170,195,255,0.035)'; g.lineWidth = this.width - 64; g.stroke(this.centerPath);

    g.setLineDash([22, 38]);
    g.strokeStyle = 'rgba(244,247,255,0.07)';
    g.lineWidth = 2.5;
    g.stroke(this.centerPath);
    g.setLineDash([]);

    this._bakeSurfaces(g);  // ice + mud are static; boost pads animate live
    this._bakeKerbs(g);
    this._bakeChevrons(g);
    this._bakeGateNotches(g);

    // wide soft glow passes are baked; thin cores stay live
    const [oSoft] = tc.outerStrokes, [iSoft] = tc.innerStrokes;
    g.strokeStyle = oSoft[0]; g.lineWidth = oSoft[1]; g.stroke(this.outerPath);
    g.strokeStyle = iSoft[0]; g.lineWidth = iSoft[1]; g.stroke(this.innerPath);

    // start line checker
    const sl = this.startLine;
    const cell = (sl.halfW * 2) / 10;
    g.save();
    g.translate(sl.cx, sl.cy);
    g.rotate(Math.atan2(sl.ny, sl.nx));
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 10; col++) {
        g.fillStyle = (row + col) % 2 === 0 ? 'rgba(244,247,255,0.8)' : 'rgba(8,12,30,0.85)';
        g.fillRect(-sl.halfW + col * cell, -cell + row * cell, cell - 0.5, cell - 0.5);
      }
    }
    g.restore();

    this.baked = { canvas: c, scale: s, bounds: b };
  }

  // ice & mud patches baked onto the asphalt (radial gradients fade at the
  // rim so a patch spilling over the neon edge still looks soft, not clipped)
  _bakeSurfaces(g) {
    let seed = 24680 + this.index * 7919;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (const s of this.surfaces) {
      if (s.t === 'boost') continue;
      if (s.t === 'ice') {
        // tangent-aligned icy slab (rect), softly faded so the edge reads frosty
        g.save();
        g.translate(s.x, s.y);
        g.rotate(Math.atan2(s.ty, s.tx));
        const ex = (s.rect ? s.h : s.r * 2) / 2;   // half-length along the road
        const ey = (s.rect ? s.w : s.r * 2) / 2;   // half-width across the road
        const rad = Math.hypot(ex, ey);
        const grad = g.createRadialGradient(0, 0, rad * 0.12, 0, 0, rad);
        grad.addColorStop(0, 'rgba(150,232,255,0.42)');
        grad.addColorStop(0.7, 'rgba(120,205,248,0.20)');
        grad.addColorStop(1, 'rgba(120,205,248,0)');
        g.fillStyle = grad;
        g.fillRect(-ex, -ey, ex * 2, ey * 2);
        g.strokeStyle = 'rgba(190,242,255,0.3)';
        g.lineWidth = 2.5;
        g.strokeRect(-ex, -ey, ex * 2, ey * 2);
        g.strokeStyle = 'rgba(232,250,255,0.45)';
        g.lineWidth = 1.5;
        for (let k = 0; k < 6; k++) {
          const a = rnd() * Math.PI * 2, l = 0.5 + rnd() * 0.9;
          g.beginPath();
          g.moveTo(Math.cos(a) * ex * 0.12, Math.sin(a) * ey * 0.12);
          g.lineTo(Math.cos(a) * ex * l, Math.sin(a) * ey * l);
          g.stroke();
        }
        g.restore();
      } else if (s.t === 'mud') {
        const grad = g.createRadialGradient(s.x, s.y, s.r * 0.1, s.x, s.y, s.r);
        grad.addColorStop(0, 'rgba(74,58,32,0.82)');
        grad.addColorStop(0.6, 'rgba(58,46,26,0.62)');
        grad.addColorStop(1, 'rgba(58,46,26,0)');
        g.fillStyle = grad;
        g.beginPath(); g.arc(s.x, s.y, s.r, 0, Math.PI * 2); g.fill();
        // speckles / ruts
        g.fillStyle = 'rgba(30,24,14,0.6)';
        for (let k = 0; k < 14; k++) {
          const a = rnd() * Math.PI * 2, rr = rnd() * s.r * 0.85;
          g.beginPath();
          g.arc(s.x + Math.cos(a) * rr, s.y + Math.sin(a) * rr, 1.5 + rnd() * 3, 0, Math.PI * 2);
          g.fill();
        }
      }
    }
  }

  // animated boost pads — chevrons streaming in the track-forward direction.
  // drawn live each frame (world-space ctx). `t` is the global anim clock.
  drawBoosts(ctx, t, left, top, right, bottom) {
    for (const s of this.surfaces) {
      if (s.t !== 'boost') continue;
      if (s.x + s.r < left || s.x - s.r > right || s.y + s.r < top || s.y - s.r > bottom) continue;
      const ang = Math.atan2(s.ty, s.tx);
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.rotate(ang);
      // glow floor
      const grad = ctx.createRadialGradient(0, 0, s.r * 0.1, 0, 0, s.r);
      grad.addColorStop(0, 'rgba(80,255,170,0.34)');
      grad.addColorStop(0.7, 'rgba(60,255,150,0.14)');
      grad.addColorStop(1, 'rgba(60,255,150,0)');
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.arc(0, 0, s.r, 0, Math.PI * 2); ctx.fill();
      // streaming chevrons
      ctx.save();
      ctx.beginPath(); ctx.arc(0, 0, s.r * 0.96, 0, Math.PI * 2); ctx.clip();
      const gap = s.r * 0.55;
      const scroll = (t * 260) % gap;
      ctx.lineWidth = 5;
      ctx.lineJoin = 'miter';
      for (let i = -2; i <= 2; i++) {
        const cxp = -s.r + i * gap + scroll;
        const k = 1 - Math.abs(cxp) / s.r;
        ctx.strokeStyle = `rgba(150,255,190,${(0.25 + 0.55 * Math.max(0, k)).toFixed(3)})`;
        ctx.beginPath();
        ctx.moveTo(cxp - s.r * 0.18, -s.r * 0.5);
        ctx.lineTo(cxp + s.r * 0.18, 0);
        ctx.lineTo(cxp - s.r * 0.18, s.r * 0.5);
        ctx.stroke();
      }
      ctx.restore();
      ctx.restore();
    }
  }

  // red/white kerb dashes where the corner radius tightens — classic circuit
  // dressing that also telegraphs braking zones
  _bakeKerbs(g) {
    const n = this.n;
    const ang = (i) => Math.atan2(this.ty[i], this.tx[i]);
    const hw = this.width / 2 - 5;
    let dash = 0;
    g.lineCap = 'butt';
    for (let i = 0; i < n; i++) {
      const a0 = ang((i - 2 + n) % n), a1 = ang((i + 2) % n);
      let d = a1 - a0;
      if (d > Math.PI) d -= Math.PI * 2;
      else if (d < -Math.PI) d += Math.PI * 2;
      const curv = Math.abs(d) / (4 * this.spacing);
      if (curv < 1 / 420) continue;
      const j = (i + 1) % n;
      for (let side = -1; side <= 1; side += 2) {
        const nx0 = -this.ty[i] * side, ny0 = this.tx[i] * side;
        const nx1 = -this.ty[j] * side, ny1 = this.tx[j] * side;
        g.strokeStyle = (dash & 1) ? 'rgba(244,247,255,0.55)' : 'rgba(255,77,107,0.65)';
        g.lineWidth = 8;
        g.beginPath();
        g.moveTo(this.cx[i] + nx0 * hw, this.cy[i] + ny0 * hw);
        g.lineTo(this.cx[j] + nx1 * hw, this.cy[j] + ny1 * hw);
        g.stroke();
      }
      dash++;
    }
    g.lineCap = 'round';
  }

  // dim direction chevrons down the middle of the road
  _bakeChevrons(g) {
    const every = Math.max(24, Math.round(520 / this.spacing));
    g.strokeStyle = 'rgba(244,247,255,0.075)';
    g.lineWidth = 3.5;
    g.lineJoin = 'miter';
    for (let i = 0; i < this.n; i += every) {
      const tx = this.tx[i], ty = this.ty[i];
      const nx = -ty, ny = tx;
      const px = this.cx[i], py = this.cy[i];
      g.beginPath();
      g.moveTo(px - tx * 5 + nx * 9, py - ty * 5 + ny * 9);
      g.lineTo(px + tx * 9, py + ty * 9);
      g.lineTo(px - tx * 5 - nx * 9, py - ty * 5 - ny * 9);
      g.stroke();
    }
    g.lineJoin = 'round';
  }

  // subtle notches at checkpoint gates (respawn anchors)
  _bakeGateNotches(g) {
    g.strokeStyle = 'rgba(0,240,255,0.45)';
    g.lineWidth = 3;
    for (let k = 1; k < this.gates.length; k++) {
      const gt = this.gates[k];
      const nx = -gt.ty, ny = gt.tx;
      for (let side = -1; side <= 1; side += 2) {
        const ex = gt.cx + nx * (this.width / 2) * side;
        const ey = gt.cy + ny * (this.width / 2) * side;
        g.beginPath();
        g.moveTo(ex, ey);
        g.lineTo(ex - nx * 13 * side, ey - ny * 13 * side);
        g.stroke();
      }
    }
  }

  // blit only the visible part of the baked base (road + scenery in one image)
  drawBase(ctx, left, top, right, bottom) {
    const k = this.baked, b = k.bounds, s = k.scale;
    const x0 = Math.max(left, b.minX), y0 = Math.max(top, b.minY);
    const x1 = Math.min(right, b.maxX), y1 = Math.min(bottom, b.maxY);
    if (x1 <= x0 || y1 <= y0) return;
    ctx.drawImage(k.canvas,
      (x0 - b.minX) * s, (y0 - b.minY) * s, (x1 - x0) * s, (y1 - y0) * s,
      x0, y0, x1 - x0, y1 - y0);
  }

  // ---- roadside scenery (procedural, drawn into the baked base canvas) ----
  // Top-down palms, neon billboards, light poles and barrier studs placed
  // beside the ribbon so the world reads as a place, not a flat baseplate.
  _drawScenery(g) {
    let seed = 13579 + this.index * 6271;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const hw = this.width / 2;

    // neon barrier studs hugging the outer wall
    for (let i = 0; i < this.n; i += 9) {
      const nx = -this.ty[i], ny = this.tx[i];
      const px = this.cx[i] + nx * (hw + 9), py = this.cy[i] + ny * (hw + 9);
      g.fillStyle = (i % 27 === 0) ? 'rgba(255,45,149,0.7)' : 'rgba(0,240,255,0.55)';
      g.beginPath(); g.arc(px, py, 3, 0, Math.PI * 2); g.fill();
    }

    // scattered props beyond the walls (mostly outfield)
    const count = 24 + Math.floor(this.length / 750);
    for (let p = 0; p < count; p++) {
      const i = Math.floor(rnd() * this.n);
      const side = rnd() < 0.62 ? 1 : -1;
      const nx = -this.ty[i] * side, ny = this.tx[i] * side;
      const dist = hw + 78 + rnd() * 250;
      const px = this.cx[i] + nx * dist, py = this.cy[i] + ny * dist;
      const kind = rnd();
      if (kind < 0.5) this._drawPalm(g, px, py, 14 + rnd() * 12, rnd);
      else if (kind < 0.8) this._drawPole(g, px, py, rnd);
      else this._drawBillboard(g, px, py, rnd);
    }
  }

  _drawPalm(g, x, y, r, rnd) {
    const gl = g.createRadialGradient(x, y, 1, x, y, r * 1.7);
    gl.addColorStop(0, 'rgba(34,230,150,0.30)');
    gl.addColorStop(1, 'rgba(34,230,150,0)');
    g.fillStyle = gl; g.beginPath(); g.arc(x, y, r * 1.7, 0, Math.PI * 2); g.fill();
    g.strokeStyle = 'rgba(46,224,156,0.85)'; g.lineWidth = 2.4;
    const n = 6, base = rnd() * Math.PI * 2;
    for (let k = 0; k < n; k++) {
      const a = base + (k / n) * Math.PI * 2;
      g.beginPath();
      g.moveTo(x, y);
      g.quadraticCurveTo(x + Math.cos(a) * r * 0.55, y + Math.sin(a) * r * 0.55,
        x + Math.cos(a) * r, y + Math.sin(a) * r);
      g.stroke();
    }
    g.fillStyle = 'rgba(16,36,36,0.92)';
    g.beginPath(); g.arc(x, y, 3, 0, Math.PI * 2); g.fill();
  }

  _drawPole(g, x, y, rnd) {
    const col = rnd() < 0.5 ? '0,240,255' : '255,45,149';
    const gl = g.createRadialGradient(x, y, 1, x, y, 22);
    gl.addColorStop(0, `rgba(${col},0.5)`);
    gl.addColorStop(1, `rgba(${col},0)`);
    g.fillStyle = gl; g.beginPath(); g.arc(x, y, 22, 0, Math.PI * 2); g.fill();
    g.fillStyle = `rgba(${col},0.95)`;
    g.beginPath(); g.arc(x, y, 3.2, 0, Math.PI * 2); g.fill();
  }

  _drawBillboard(g, x, y, rnd) {
    const a = rnd() * Math.PI * 2, w = 34 + rnd() * 24, h = 17 + rnd() * 8;
    const cols = ['#00f0ff', '#ff2d95', '#ffe14d'];
    const col = cols[Math.floor(rnd() * 3)];
    g.save();
    g.translate(x, y); g.rotate(a);
    g.fillStyle = 'rgba(8,12,30,0.9)'; g.fillRect(-w / 2, -h / 2, w, h);
    g.globalAlpha = 0.42; g.fillStyle = col; g.fillRect(-w / 2 + 4, -h / 2 + 4, w - 8, h - 8);
    g.globalAlpha = 1;
    g.strokeStyle = col; g.lineWidth = 2.5; g.strokeRect(-w / 2, -h / 2, w, h);
    g.restore();
  }

  // ---- minimap (pre-rendered outline; dots drawn live by the HUD) ----
  _buildMinimap() {
    const b = this.bounds;
    const W = 440, H = 320; // 2x for crispness
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    const pad = 18;
    const sc = Math.min((W - pad * 2) / (b.maxX - b.minX), (H - pad * 2) / (b.maxY - b.minY));
    const ox = (W - (b.maxX - b.minX) * sc) / 2 - b.minX * sc;
    const oy = (H - (b.maxY - b.minY) * sc) / 2 - b.minY * sc;
    this.mini = { canvas: c, sc, ox, oy };

    g.setTransform(sc, 0, 0, sc, ox, oy);
    g.lineJoin = 'round'; g.lineCap = 'round';
    // dark ribbon + neon outline
    g.strokeStyle = 'rgba(7,10,28,0.92)';
    g.lineWidth = this.width + 70;
    g.stroke(this.centerPath);
    g.strokeStyle = 'rgba(16,24,52,0.95)';
    g.lineWidth = this.width;
    g.stroke(this.centerPath);
    g.strokeStyle = this.def.colors.outer;
    g.globalAlpha = 0.85;
    g.lineWidth = 26 / sc > this.width * 0.45 ? this.width * 0.45 : 26 / sc;
    g.stroke(this.centerPath);
    g.globalAlpha = 1;
    // start tick
    const s = this.startLine;
    g.strokeStyle = '#ffffff';
    g.lineWidth = 8 / sc;
    g.beginPath();
    g.moveTo(s.cx - s.nx * s.halfW, s.cy - s.ny * s.halfW);
    g.lineTo(s.cx + s.nx * s.halfW, s.cy + s.ny * s.halfW);
    g.stroke();
  }

  worldToMini(x, y, out) {
    out.x = x * this.mini.sc + this.mini.ox;
    out.y = y * this.mini.sc + this.mini.oy;
    return out;
  }

  // ---- collision ----
  // Tests three circles along the car body against nearby wall segments.
  // Returns the strongest impact speed this tick (0 = no contact).
  collideCar(car, dt = 0) {
    let maxImpact = 0;
    this.lastHit.impact = 0;
    const cos = Math.cos(car.heading), sin = Math.sin(car.heading);
    for (let pass = 0; pass < 2; pass++) {
      let hitThisPass = false;
      for (let ci = 0; ci < 3; ci++) {
        let px, py, r;
        if (ci === 0) { px = car.x; py = car.y; r = CONFIG.CAR.RADIUS; }
        else {
          const d = ci === 1 ? CONFIG.CAR.NOSE_TAIL : -CONFIG.CAR.NOSE_TAIL;
          px = car.x + cos * d; py = car.y + sin * d; r = CONFIG.CAR.END_RADIUS;
        }
        const imp = this._collideCircle(car, px, py, r);
        if (imp > 0) hitThisPass = true;
        if (imp > maxImpact) maxImpact = imp;
      }
      if (!hitThisPass) break;
    }
    // wall-ride friction: once per step, if the car touched a wall at all,
    // bleed a fixed amount of speed. Brief taps cost almost nothing; riding a
    // wall through a corner sheds speed fast, so it never pays to do it.
    if (maxImpact > 0 && dt > 0) {
      const sp = Math.hypot(car.vx, car.vy);
      if (sp > 1) {
        const k = Math.max(0, sp - CONFIG.WALL.RIDE_DECEL * dt) / sp;
        car.vx *= k; car.vy *= k;
      }
    }
    return maxImpact;
  }

  _collideCircle(car, px, py, r) {
    const cellX = Math.floor(px / HASH_CELL), cellY = Math.floor(py / HASH_CELL);
    const segs = this.segs;
    const tmp = this._tmp;
    this._stampId++;
    let maxImpact = 0;
    for (let gy = cellY - 1; gy <= cellY + 1; gy++) {
      for (let gx = cellX - 1; gx <= cellX + 1; gx++) {
        const arr = this.hash.get(gx * 100003 + gy);
        if (!arr) continue;
        for (let k = 0; k < arr.length; k++) {
          const si = arr[k];
          if (this._stamp[si] === this._stampId) continue;
          this._stamp[si] = this._stampId;
          const o = si * 6;
          segClosest(px, py, segs[o], segs[o + 1], segs[o + 2], segs[o + 3], tmp);
          const dx = px - tmp.x, dy = py - tmp.y;
          const dist = Math.hypot(dx, dy);
          const nx = segs[o + 4], ny = segs[o + 5];
          const side = dx * nx + dy * ny; // >0: circle center on track side
          // Tunneling in one 120 Hz step is ≤ ~6 px, so only snap back when
          // the center is just past the line. A center far on the "wrong"
          // side belongs to ANOTHER track section running nearby — ignore.
          if (side < 0 && dist > 10) continue;
          const pen = r - (side >= 0 ? dist : -dist);
          if (pen > 0) {
            const impact = resolveWallHit(car, nx, ny, pen);
            if (impact > maxImpact) maxImpact = impact;
            const lh = this.lastHit;
            if (impact >= lh.impact) {
              lh.x = tmp.x; lh.y = tmp.y; lh.nx = nx; lh.ny = ny; lh.impact = impact;
            }
            // circle followed the car body — update local test position
            px += nx * pen; py += ny * pen;
          }
        }
      }
    }
    return maxImpact;
  }

  // did the car cross gate `gi` while moving forward along the track?
  crossedGate(gi, x0, y0, x1, y1) {
    const g = this.gates[gi];
    if (!segsIntersect(x0, y0, x1, y1, g.x1, g.y1, g.x2, g.y2)) return false;
    return (x1 - x0) * g.tx + (y1 - y0) * g.ty > 0;
  }

  gatePose(gi) { return this.gates[gi]; }
}

// build-once cache
const built = new Map();
export function getTrack(index) {
  if (!built.has(index)) built.set(index, new Track(TRACK_DEFS[index], index));
  return built.get(index);
}
