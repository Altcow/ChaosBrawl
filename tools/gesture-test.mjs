// 手勢辨識測試:node tools/gesture-test.mjs [每手勢次數,預設 200]
// 1) 範本軌跡自我辨識  2) 合成人手軌跡(三種雜訊檔)的成功率 / 錯招率 / 失敗原因  3) 角色內手勢距離與衝突
// 4) 點一下 / 按住 / 太慢 / 斜向 / 面向左鏡像 等邊界
// 除錯:DBG=檔位,角色,手勢id,次數 [V=1 印分段] [W=過濾字] [CONF=1 列出錯招組合與失敗樣態] [DUR=1 列出各手勢平均時間]
import { readFileSync } from 'node:fs';
import { recognize, tokenize, buildSet, editDistance, templatePath, fitTemplate, PARAMS } from '../js/ui/gesture.js';

const N = parseInt(process.argv[2] || '200', 10);
const DBG = process.env.DBG || '';
const rd = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const ids = rd('../data/chars/index.json');
const gd = rd('../data/gestures.json');
const chars = {};
for (const id of ids) chars[id] = rd('../data/chars/' + id + '.json');
const sets = {};
for (const id of ids) sets[id] = buildSet(chars[id], gd);

let pass = 0;
let fail = 0;
const ok = (c, m) => {
  console.log((c ? 'PASS ' : 'FAIL ') + m);
  c ? pass++ : fail++;
};

// ---------------------------------------------------------------- 亂數
function mulberry(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let R = mulberry(12345);
const rnd = (a, b) => a + R() * (b - a);
const gauss = () => {
  let u = 0;
  let v = 0;
  while (u === 0) u = R();
  v = R();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};
const D2R = Math.PI / 180;

// ---------------------------------------------------------------- 合成「人手」軌跡
const PROFILES = {
  clean: { noise: 0.3, wob: 0.5, rotSd: 2, scale: [0.9, 1.1], sm: [2, 4], tokVar: 0.1, angVar: 3, speed: [550, 800] },
  normal: { noise: 0.8, wob: 1.2, rotSd: 6, scale: [0.75, 1.3], sm: [3, 7], tokVar: 0.25, angVar: 8, speed: [350, 700] },
  sloppy: { noise: 1.2, wob: 2.0, rotSd: 10, scale: [0.7, 1.5], sm: [5, 11], tokVar: 0.35, angVar: 14, speed: [260, 600] }
};
const ARC = {
  'AU>': [[1, 0], [0, -1]], 'AU<': [[-1, 0], [0, -1]], 'AD>': [[1, 0], [0, 1]], 'AD<': [[-1, 0], [0, 1]],
  'AF↓': [[0, 1], [1, 0]], 'AF↑': [[0, -1], [1, 0]], 'AB↓': [[0, 1], [-1, 0]], 'AB↑': [[0, -1], [-1, 0]]
};
const LINE = { F: 0, D: 90, B: 180, U: -90 };
const rot = (v, a) => [v[0] * Math.cos(a) - v[1] * Math.sin(a), v[0] * Math.sin(a) + v[1] * Math.cos(a)];

// 回傳 [{x,y,t}];seq 為 token;face 為 +1 / -1
function human(seq, face, prof, opts) {
  opts = opts || {};
  const tv = prof.tokVar;
  const unit = 58 * rnd(prof.scale[0], prof.scale[1]);
  const pts = [];
  let pos = [0, 0];
  let holdMs = 0;
  const add = (x, y) => {
    pts.push([x, y]);
    pos = [x, y];
  };
  add(0, 0);
  let lastLineDir = null;
  for (const t of seq) {
    if (t === 'H') {
      holdMs = rnd(640, 900);
      continue;
    }
    if (t in LINE) {
      const ang = (LINE[t] + gauss() * prof.angVar) * D2R;
      const len = unit * rnd(0.85, 1.15 + tv) * 0.85;
      // 來回的線:每一筆帶一點橫向漂移(拇指是弧形運動)
      const n = Math.max(2, Math.round(len));
      const dx = Math.cos(ang);
      const dy = Math.sin(ang);
      const side = lastLineDir !== null ? rnd(2, 9) : 0;
      const px = -dy * side;
      const py = dx * side;
      for (let i = 1; i <= n; i++) add(pos[0] + (dx * len) / n + (i === 1 ? px : 0), pos[1] + (dy * len) / n + (i === 1 ? py : 0));
      lastLineDir = t;
      continue;
    }
    lastLineDir = null;
    if (t in ARC) {
      const tilt = gauss() * prof.angVar * D2R;
      const c = rot(ARC[t][0], tilt);
      const nn = rot(ARC[t][1], tilt);
      const D = unit * rnd(0.75, 1.1 + tv);
      const S = rnd(165, 215) * D2R;
      const Rr = D / (2 * Math.sin(S / 2));
      const mid = [pos[0] + (c[0] * D) / 2, pos[1] + (c[1] * D) / 2];
      const cen = [mid[0] - nn[0] * Rr * Math.cos(S / 2), mid[1] - nn[1] * Rr * Math.cos(S / 2)];
      const sx = pos[0];
      const sy = pos[1];
      void sx;
      void sy;
      const stretch = rnd(0.85, 1.2);
      const N = Math.max(8, Math.round(Rr * S));
      for (let i = 1; i <= N; i++) {
        const phi = -S / 2 + (S * i) / N;
        let vx = nn[0] * Math.cos(phi) + c[0] * Math.sin(phi);
        let vy = nn[1] * Math.cos(phi) + c[1] * Math.sin(phi);
        // 沿弦方向拉伸 / 壓扁(橢圓)
        const along = vx * c[0] + vy * c[1];
        const perp = vx * nn[0] + vy * nn[1];
        vx = c[0] * along + nn[0] * perp * stretch;
        vy = c[1] * along + nn[1] * perp * stretch;
        add(cen[0] + Rr * vx, cen[1] + Rr * vy);
      }
      continue;
    }
    if (t === 'C1' || t === 'C2' || t === 'C8') {
      const loops = t === 'C2' ? 2 : 1;
      const r = unit * rnd(0.26, 0.4) * (t === 'C8' ? 0.75 : 1);
      const dir = R() < 0.5 ? 1 : -1;
      const a0 = rnd(0, 360) * D2R;
      const asp = rnd(0.78, 1.0);
      const tilt = rnd(0, Math.PI);
      const drift = rnd(-0.12, 0.12);
      const lobes = t === 'C8' ? 2 : 1;
      let cur = pos.slice();
      for (let lb = 0; lb < lobes; lb++) {
        const sweep = (t === 'C8' ? rnd(320, 400) : t === 'C2' ? rnd(660, 760) : rnd(340, 420)) * D2R;
        const d = t === 'C8' ? (lb === 0 ? dir : -dir) : dir;
        const base = lb === 0 ? a0 : a0 + Math.PI; // 8 字:第二個圈從對側接上
        const cen = [cur[0] - r * Math.cos(base) * 1, cur[1] - r * Math.sin(base) * 1];
        void loops;
        const N = Math.max(12, Math.round((r * sweep) / 1));
        for (let i = 1; i <= N; i++) {
          const a = base + (d * sweep * i) / N;
          const rr = r * (1 + (drift * i) / N);
          let ex = Math.cos(a) * rr;
          let ey = Math.sin(a) * rr;
          const ct = Math.cos(tilt);
          const st = Math.sin(tilt);
          const ux = ex * ct + ey * st;
          const uy = -ex * st + ey * ct;
          ex = (ux * ct - uy * asp * st);
          ey = (ux * st + uy * asp * ct);
          add(cen[0] + ex, cen[1] + ey);
        }
        cur = pos.slice();
      }
      continue;
    }
  }
  // 平滑成圓角 + 手抖
  const w = Math.round(rnd(prof.sm[0], prof.sm[1]));
  let dense = pts;
  if (w > 1) {
    dense = pts.map((p, i) => {
      let sx = 0;
      let sy = 0;
      let c = 0;
      for (let k = -w; k <= w; k++) {
        const j = Math.min(pts.length - 1, Math.max(0, i + k));
        sx += pts[j][0];
        sy += pts[j][1];
        c++;
      }
      return [sx / c, sy / c];
    });
    dense[0] = pts[0];
    dense[dense.length - 1] = pts[pts.length - 1];
  }
  const f1 = rnd(0.02, 0.06);
  const f2 = rnd(0.05, 0.12);
  const ph = rnd(0, 6.28);
  const ph2 = rnd(0, 6.28);
  const gAng = gauss() * prof.rotSd * D2R;
  const sc = rnd(0.95, 1.05);
  const out = dense.map((p, i) => {
    let x = p[0] + prof.wob * (Math.sin(i * f1 + ph) + 0.5 * Math.sin(i * f2 + ph2)) + gauss() * prof.noise;
    let y = p[1] + prof.wob * (Math.cos(i * f1 + ph2) + 0.5 * Math.cos(i * f2 + ph)) + gauss() * prof.noise;
    const rx = (x * Math.cos(gAng) - y * Math.sin(gAng)) * sc;
    const ry = (x * Math.sin(gAng) + y * Math.cos(gAng)) * sc;
    return [rx * face, ry];
  });
  // 速度:轉得越急越慢
  const kap = dense.map((p, i) => {
    const a = dense[Math.max(0, i - 3)];
    const b = dense[Math.min(dense.length - 1, i + 3)];
    const v1 = [p[0] - a[0], p[1] - a[1]];
    const v2 = [b[0] - p[0], b[1] - p[1]];
    const l1 = Math.hypot(...v1) || 1;
    const l2 = Math.hypot(...v2) || 1;
    const c = Math.max(-1, Math.min(1, (v1[0] * v2[0] + v1[1] * v2[1]) / (l1 * l2)));
    return Math.acos(c) / ((l1 + l2) / 2 + 1);
  });
  const v0 = rnd(prof.speed[0], prof.speed[1]) * (opts.slow || 1) ** -1;
  let t = holdMs;
  const timed = [];
  const x0 = out[0][0];
  const y0 = out[0][1];
  // 按住階段
  if (holdMs > 0) for (let tt = 0; tt < holdMs; tt += 16) timed.push({ x: x0 + gauss() * 1.2, y: y0 + gauss() * 1.2, t: tt });
  timed.push({ x: x0, y: y0, t });
  let s = 0;
  for (let i = 1; i < out.length; i++) {
    const ds = Math.hypot(out[i][0] - out[i - 1][0], out[i][1] - out[i - 1][1]);
    s += ds;
    const ramp = Math.min(1, 0.35 + s / 30);
    const v = Math.max(110, (v0 * ramp) / (1 + 7 * kap[i]));
    t += (ds / v) * 1000;
    timed.push({ x: out[i][0], y: out[i][1], t });
  }
  // 以 8~16ms 取樣(螢幕輸入事件)
  const res = [];
  let tt = holdMs > 0 ? 0 : timed[0].t;
  let j = 0;
  const tEnd = timed[timed.length - 1].t;
  while (tt < tEnd) {
    while (j + 1 < timed.length && timed[j + 1].t < tt) j++;
    const a = timed[j];
    const b = timed[Math.min(timed.length - 1, j + 1)];
    const r = b.t > a.t ? (tt - a.t) / (b.t - a.t) : 0;
    res.push({ x: a.x + (b.x - a.x) * r, y: a.y + (b.y - a.y) * r, t: tt });
    tt += rnd(7, 17);
  }
  res.push({ x: timed[timed.length - 1].x, y: timed[timed.length - 1].y, t: tEnd });
  const T0 = res[0].t;
  const ox = rnd(60, 90);
  const oy = rnd(60, 90);
  return res.map((p) => ({ x: p.x + ox, y: p.y + oy, t: p.t - T0 }));
}

if (process.env.DUR) {
  R = mulberry(5);
  const seen = {};
  for (const pn of ['clean', 'normal']) {
    for (const g of sets.fanfan.concat(sets.areh, sets.lubu, sets.guanyu, sets.sun, sets.piggy, sets.qiyu, sets.longjuan, sets.manman, sets.kenan)) {
      const key = g.seq.join('');
      if (seen[pn + key]) continue;
      seen[pn + key] = 1;
      let s = 0;
      let mx = 0;
      for (let k = 0; k < 40; k++) { const pts = human(g.seq, 1, PROFILES[pn]); const d = pts[pts.length - 1].t - (g.seq[0] === 'H' ? 700 : 0); s += d; mx = Math.max(mx, d); }
      console.log(pn, key.padEnd(14), Math.round(s / 40), Math.round(mx));
    }
  }
  process.exit(0);
}
if (DBG) {
  const [prof, cid, gid, cnt] = DBG.split(',');
  R = mulberry(99);
  const g = sets[cid].find((x) => x.id === gid);
  for (let k = 0; k < +cnt; k++) {
    const face = R() < 0.5 ? 1 : -1;
    const pts = human(g.seq, face, PROFILES[prof]);
    const r = recognize(pts, face, sets[cid]);
    console.log(g.seq.join(' '), '=>', r.tokens.join(' '), r.id, r.reason, Math.round(r.dur));
    if (process.env.V && r.id !== g.id && (!process.env.W || (r.tokens.join(' ') + ' ' + r.reason).includes(process.env.W))) { const tk = tokenize(pts, face); console.log(' segs', JSON.stringify(tk.segs.map((s) => [s.a, s.b, Math.round(s.fs), Math.round(s.fe)]))); console.log(' runs', JSON.stringify(tk.runs.map((s) => [s.k, s.a, s.b, Math.round(s.I || s.ang || 0), Math.round(s.L), Math.round(s.mean || 0)]))); }
  }
  process.exit(0);
}
// ---------------------------------------------------------------- 0) gestures.json 資料完整性
{
  const VALID = new Set(['F', 'B', 'U', 'D', 'AU>', 'AU<', 'AD>', 'AD<', 'AF↓', 'AF↑', 'AB↓', 'AB↑', 'C1', 'C2', 'C8', 'H']);
  let bad = [];
  for (const f of Object.values(gd.families)) if (!f.seq.every((t) => VALID.has(t)) || !f.name || !f.image) bad.push('family ' + f.name);
  for (const id of ids) {
    const j = chars[id];
    const g = gd.chars[id];
    if (!g) { bad.push(id + ' 沒有手勢'); continue; }
    for (const cmd of Object.keys(j.info.moves)) {
      const e = g[cmd];
      const seq = e && (e.seq || (gd.families[e.family] || {}).seq);
      if (!seq || !seq.every((t) => VALID.has(t))) bad.push(id + ' ' + cmd + ' 手勢無效');
      if (!e || !e.tip || e.tip.length > 14) bad.push(id + ' ' + cmd + ' tip 缺或超過 14 字');
    }
    const u = g.ultimate;
    if (!u || !u.seq || !u.seq.every((t) => VALID.has(t)) || !u.tip || u.tip.length > 14) bad.push(id + ' ultimate');
    if (Object.keys(g).filter((k) => k !== 'ultimate').length !== Object.keys(j.info.moves).length) bad.push(id + ' 手勢數與招式數不符');
  }
  ok(bad.length === 0, 'gestures.json:12 角色 × (3 招 + 最強) 手勢有效、訣竅 ≤ 14 字' + (bad.length ? ' ← ' + bad.join(' | ') : ''));
}

// ---------------------------------------------------------------- 1) 範本自我辨識
{
  let bad = 0;
  let total = 0;
  const lst = [];
  for (const id of ids) {
    for (const g of sets[id]) {
      for (const sz of [40, 55, 70, 90]) {
        // 1 單位(一條直線 = 半月直徑)= sz 像素
        const tp0 = templatePath(g.seq);
        const tp = { pts: tp0.pts.map((p) => ({ x: p.x * sz, y: p.y * sz })) };
        const pts = [];
        let t = g.seq[0] === 'H' ? 700 : 0;
        const body = tp.pts;
        if (g.seq[0] === 'H') for (let tt = 0; tt < 700; tt += 20) pts.push({ x: tp.pts[0].x + 50, y: tp.pts[0].y + 50, t: tt });
        body.forEach((p) => {
          pts.push({ x: p.x + 50, y: p.y + 50, t });
          t += 12;
        });
        for (const face of [1, -1]) {
          const mp = pts.map((p) => ({ x: face > 0 ? p.x : 400 - p.x, y: p.y, t: p.t }));
          const r = recognize(mp, face, sets[id]);
          total++;
          if (!(r.ok && r.id === g.id)) {
            bad++;
            lst.push(id + ' ' + g.id + ' sz' + sz + ' face' + face + ' → ' + r.id + ' [' + r.tokens.join(' ') + '] ' + r.reason);
          }
        }
      }
    }
  }
  ok(bad === 0, '範本軌跡 12 角色 × 8 手勢 × 4 種大小(1 單位 40~90px)× 左右面向 自我辨識(' + (total - bad) + '/' + total + ')');
  for (const l of lst.slice(0, 12)) console.log('   ' + l);
}

// ---------------------------------------------------------------- 2) 角色內手勢距離
{
  let minD = 99;
  const pairs = [];
  let dup = 0;
  for (const id of ids) {
    const s = sets[id];
    ok(s.length === 8, id + ' 有 8 個手勢(3 招 + 最強 + 4 月步),實際 ' + s.length);
    for (let i = 0; i < s.length; i++) {
      for (let j = i + 1; j < s.length; j++) {
        const d = editDistance(s[i].seq, s[j].seq);
        if (d === 0) dup++;
        if (d < 2 && s[i].kind !== 'step' && s[j].kind !== 'step') pairs.push(id + ': ' + s[i].seq.join('') + ' ~ ' + s[j].seq.join('') + ' (' + d + ')');
        minD = Math.min(minD, d);
      }
    }
  }
  ok(dup === 0, '同角色內沒有完全相同的手勢');
  console.log('INFO 角色內(3 招 + 最強)編輯距離 < 2 的組合(' + pairs.length + '):' + pairs.join(' | '));
  console.log('INFO 招式與月步:單筆月步與含該筆的複合手勢(例 [→] 與 [←,→])編輯距離為 1,靠「有無漏畫前面那筆」區分;漏畫小於 12px 的起筆會被當成月步');
}

// ---------------------------------------------------------------- 3) 合成軌跡成功率
const TARGET = { sp: 0.9, ult: 0.8, step: 0.95 };
const summary = {};
for (const pname of Object.keys(PROFILES)) {
  R = mulberry(777 + pname.length);
  const prof = PROFILES[pname];
  const agg = { sp: [0, 0, 0], ult: [0, 0, 0], step: [0, 0, 0] }; // [總數, 成功, 錯招]
  const reasons = {};
  const conf = {};
  const fails = {};
  const worst = [];
  for (const id of ids) {
    for (const g of sets[id]) {
      let good = 0;
      let wrong = 0;
      for (let k = 0; k < N; k++) {
        const face = R() < 0.5 ? 1 : -1;
        const pts = human(g.seq, face, prof);
        const r = recognize(pts, face, sets[id]);
        if (r.ok && r.id === g.id) good++;
        else if (r.ok) { wrong++; const key = g.seq.join('') + ' → ' + (sets[id].find((x) => x.id === r.id) || {}).seq.join(''); conf[key] = (conf[key] || 0) + 1; }
        else { reasons[r.reason] = (reasons[r.reason] || 0) + 1; const key = g.seq.join('') + ' ⇒ ' + r.tokens.join(' ') + ' ' + r.reason; fails[key] = (fails[key] || 0) + 1; }
      }
      const a = agg[g.kind];
      a[0] += N;
      a[1] += good;
      a[2] += wrong;
      worst.push({ id: id + '/' + g.id + ' ' + g.seq.join(''), rate: good / N, wrong: wrong / N });
    }
  }
  summary[pname] = agg;
  const f = (a) => (a[1] / a[0] * 100).toFixed(1) + '% (錯招 ' + (a[2] / a[0] * 100).toFixed(2) + '%)';
  console.log('\n[' + pname + '] 每手勢 ' + N + ' 次');
  console.log('  必殺 ' + f(agg.sp) + ' | 最強 ' + f(agg.ult) + ' | 月步 ' + f(agg.step));
  console.log('  失敗原因:' + JSON.stringify(reasons));
  if (process.env.CONF) {
    console.log('  錯招組合:' + Object.entries(conf).sort((a, b) => b[1] - a[1]).slice(0, 12).map((e) => e.join(' x')).join(' ; '));
    console.log('  失敗樣態:' + Object.entries(fails).sort((a, b) => b[1] - a[1]).slice(0, 25).map((e) => '\n    ' + e.join(' x')).join(''));
  }
  worst.sort((a, b) => a.rate - b.rate);
  console.log('  最低 6 個:' + worst.slice(0, 6).map((w) => w.id + ' ' + (w.rate * 100).toFixed(0) + '%/錯' + (w.wrong * 100).toFixed(0) + '%').join(' ; '));
  const wr = worst.filter((w) => w.wrong > 0.02);
  if (wr.length) console.log('  錯招 > 2%:' + wr.map((w) => w.id + ' ' + (w.wrong * 100).toFixed(1) + '%').join(' ; '));
}
{
  const a = summary.normal;
  ok(a.sp[1] / a[('sp')][0] >= TARGET.sp, 'normal 檔 必殺成功率 ≥ ' + TARGET.sp * 100 + '%');
  ok(a.ult[1] / a.ult[0] >= TARGET.ult, 'normal 檔 最強成功率 ≥ ' + TARGET.ult * 100 + '%');
  ok(a.step[1] / a.step[0] >= TARGET.step, 'normal 檔 月步成功率 ≥ ' + TARGET.step * 100 + '%');
  const wrongAll = (a.sp[2] + a.ult[2] + a.step[2]) / (a.sp[0] + a.ult[0] + a.step[0]);
  ok(wrongAll <= 0.02, 'normal 檔 錯招率 ≤ 2%(' + (wrongAll * 100).toFixed(2) + '%)');
  const c = summary.clean;
  ok((c.sp[1] + c.ult[1] + c.step[1]) / (c.sp[0] + c.ult[0] + c.step[0]) >= 0.97, 'clean 檔 總成功率 ≥ 97%');
}

// ---------------------------------------------------------------- 4) 邊界
{
  const s = sets.fanfan;
  const line = (x0, y0, x1, y1, ms) => {
    const out = [];
    const n = Math.max(2, Math.round(ms / 12));
    for (let i = 0; i <= n; i++) out.push({ x: x0 + ((x1 - x0) * i) / n, y: y0 + ((y1 - y0) * i) / n, t: (ms * i) / n });
    return out;
  };
  let r = recognize([{ x: 100, y: 100, t: 0 }, { x: 102, y: 101, t: 80 }, { x: 102, y: 101, t: 120 }], 1, s);
  ok(!r.ok && r.reason === 'tap', '點一下 → 不出招(tap)');
  r = recognize(line(100, 100, 190, 100, 160), 1, s);
  ok(r.ok && r.id === 'step_f', '→ 直線 = 前衝');
  r = recognize(line(190, 100, 100, 100, 160), 1, s);
  ok(r.ok && r.id === 'step_b', '← 直線 = 後滑');
  r = recognize(line(190, 100, 100, 100, 160), -1, s);
  ok(r.ok && r.id === 'step_f', '面向左時 ← 直線 = 前衝(鏡像)');
  r = recognize(line(100, 100, 100, 30, 160), 1, s);
  ok(r.ok && r.id === 'step_u', '↑ = 縱步上');
  r = recognize(line(100, 30, 100, 100, 160), 1, s);
  ok(r.ok && r.id === 'step_d', '↓ = 縱步下');
  r = recognize(line(100, 100, 160, 40, 160), 1, s);
  ok(!r.ok && r.reason === 'diag', '斜 45° 的斜向 → 不認(diag)');
  r = recognize(line(100, 100, 190, 100 - 40, 160), 1, s);
  ok(r.ok && r.id === 'step_f', '往前微微上斜 24° 仍算前衝');
  r = recognize(line(100, 100, 190, 100, 4000), 1, s);
  ok(!r.ok && r.reason === 'slow', '一筆畫了 4 秒 → 太慢(slow)');
  r = recognize(line(100, 100, 112, 100, 100), 1, s);
  ok(!r.ok, '太短的直線(12px)→ 不出招');
  r = recognize(line(100, 100, 100, 100, 900), 1, s);
  ok(!r.ok && r.reason === 'tap', '帆帆按住不動 → 沒有按住手勢,視為沒事(tap)');
  const sq = sets.qiyu;
  const hold = (ms, dx) => {
    const out = [];
    for (let t = 0; t < ms; t += 16) out.push({ x: 100 + (t % 3), y: 100, t });
    return out.concat(line(100, 100, 100 + dx, 100, 140).map((p) => ({ x: p.x, y: p.y, t: p.t + ms })));
  };
  r = recognize(hold(700, 90), 1, sq);
  ok(r.ok, '騎玉 按住 0.7 秒再往前(寬鬆仍出招)');
  r = recognize(hold(300, 90), 1, sq);
  ok(r.ok && r.id === 'step_f', '騎玉 按住只有 0.3 秒再往前 = 一般前衝');
  r = recognize(hold(700, 0).slice(0, -1), 1, sq);
  ok(!r.ok, '騎玉 只按住不放不動 → 不出招');
  // 最強不接受缺一筆(帆帆浪少畫一道)
  const tpWave = fitTemplate(templatePath(['AU>', 'AD>']), 110, 0);
  const wavePts = tpWave.pts.map((p, i) => ({ x: p.x, y: p.y, t: i * 12 }));
  r = recognize(wavePts, 1, s);
  ok(!(r.ok && r.id === 'ultimate'), '最強少畫一道 → 不會出最強');
  const t2 = tokenize([{ x: 0, y: 0, t: 0 }], 1);
  ok(t2.bad === 'tap', '只有一個點 → tap');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
