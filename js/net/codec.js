// 編碼:世界全狀態(快照 / save 共用)、輸入封包。位元組 → base64 字串供 RTDB JSON 傳輸。
// 全狀態用變長整數(zigzag varint),字串用共用字串表索引(兩端由同一份角色資料建表)。

export function makeCtx(chars) {
  const set = new Set(['human', 'ai', 'post', 'puncher', 'practice', 'brawl', 'timed', 'team']);
  for (const id in chars) {
    set.add(id);
    for (const m in chars[id].moves) set.add(m);
    for (const p in chars[id].projectiles || {}) set.add(p);
    for (const b in chars[id].buffs || {}) set.add(b);
  }
  const strs = Array.from(set).sort();
  const idx = new Map(strs.map((s, i) => [s, i + 1]));
  return { strs, idx };
}

class Writer {
  constructor() {
    this.b = new Uint8Array(1024);
    this.n = 0;
  }
  byte(v) {
    if (this.n >= this.b.length) {
      const nb = new Uint8Array(this.b.length * 2);
      nb.set(this.b);
      this.b = nb;
    }
    this.b[this.n++] = v;
  }
  int(v) {
    let z = v >= 0 ? v * 2 : -v * 2 - 1;
    while (z >= 128) {
      this.byte((z % 128) | 128);
      z = Math.floor(z / 128);
    }
    this.byte(z);
  }
  str(ctx, s) {
    this.int(s == null ? 0 : ctx.idx.get(s));
  }
  out() {
    return this.b.slice(0, this.n);
  }
}

class Reader {
  constructor(b) {
    this.b = b;
    this.p = 0;
  }
  byte() {
    return this.b[this.p++];
  }
  int() {
    let z = 0;
    let m = 1;
    let c;
    do {
      c = this.byte();
      z += (c & 127) * m;
      m *= 128;
    } while (c & 128);
    return z % 2 === 0 ? z / 2 : -(z + 1) / 2;
  }
  str(ctx) {
    const i = this.int();
    return i ? ctx.strs[i - 1] : null;
  }
}

const F_INTS = ['id', 'team', 'x', 'y', 'z', 'vx', 'vy', 'vz', 'face', 'state', 'st', 'nextState', 'takeoffVx',
  'hp', 'gray', 'mp', 'rage', 'ult', 'ultSeq', 'ultGuard', 'ultGuardBy', 'held', 'mkx', 'mkz', 'bufT', 'aftT', 'fall', 'bdef', 'sinceHit', 'hitstop', 'rollCd', 'getupDir', 'stunT', 'airHits', 'inv', 'silence',
  'deadTick', 'kills', 'lastAtk', 'lastAtkTick', 'mf', 'mt', 'mtot', 'mseq', 'hf', 'prev', 'pend', 'tapDir', 'tapT'];
const P_INTS = ['id', 'owner', 'x', 'y', 'z', 'face', 'vx', 'vz', 'life'];

function writeMap(w, m) {
  const keys = Object.keys(m || {});
  w.int(keys.length);
  for (const k of keys) {
    w.int(parseInt(k, 10));
    w.int(m[k]);
  }
}
function readMap(r) {
  const m = {};
  const n = r.int();
  for (let i = 0; i < n; i++) {
    const k = r.int();
    m[k] = r.int();
  }
  return m;
}
function writeList(w, a) {
  w.int(a.length);
  for (const x of a) w.int(x);
}
function readList(r) {
  const n = r.int();
  const a = [];
  for (let i = 0; i < n; i++) a.push(r.int());
  return a;
}
// 大招世界狀態 w.ult:on / cur / t / cd / dim / dimId + 排隊清單 q(舊快照沒有時補預設)
const ultOf = (s) => s.ult || { on: true, cur: -1, t: 0, q: [], cd: 0, dim: 0, dimId: -1 };
function vecUlt(u) {
  return [u.on ? 1 : 0, u.cur, u.t, u.cd, u.dim, u.dimId];
}
function ultFromVec(v, q) {
  return { on: !!v[0], cur: v[1], t: v[2], q, cd: v[3], dim: v[4], dimId: v[5] };
}
function writeLog(w, log) {
  const keys = Object.keys(log);
  w.int(keys.length);
  for (const k of keys) {
    w.int(parseInt(k, 10));
    w.int(log[k].seq);
    w.int(log[k].tick);
  }
}
function readLog(r) {
  const log = {};
  const n = r.int();
  for (let i = 0; i < n; i++) {
    const k = r.int();
    log[k] = { seq: r.int(), tick: r.int() };
  }
  return log;
}

// snap = serializeWorld(w) 的結果
export function encodeWorld(snap, ctx) {
  const w = new Writer();
  w.int(snap.tick);
  w.int(snap.rng);
  w.int(snap.nextSeq);
  const m = snap.mode;
  w.str(ctx, m.type);
  w.int(m.t);
  w.int(m.limit);
  w.int(m.over ? 1 : 0);
  w.int(m.winner);
  w.int(m.overtime ? 1 : 0);
  w.int(m.ff || 0);
  const u = ultOf(snap);
  for (const x of vecUlt(u)) w.int(x);
  writeList(w, u.q);
  w.int(snap.fighters.length);
  for (const f of snap.fighters) {
    for (const k of F_INTS) w.int(f[k]);
    w.byte((f.dead ? 1 : 0) | (f.seatHuman ? 2 : 0));
    w.str(ctx, f.charId);
    w.str(ctx, f.kind);
    w.str(ctx, f.move);
    w.str(ctx, f.hm);
    w.int(f.buf ? ctx.idx.get(f.buf) : 0);
    w.int(f.hist.length);
    for (const h of f.hist) w.byte(h);
    writeLog(w, f.hitLog);
    writeMap(w, f.ultDmg);
    w.int(f.ai.lvl);
    w.int(f.ai.tgt);
  }
  w.int(snap.projectiles.length);
  for (const p of snap.projectiles) {
    for (const k of P_INTS) w.int(p[k]);
    w.byte(p.dead ? 1 : 0);
    w.str(ctx, p.ch);
    w.str(ctx, p.kind);
    writeLog(w, p.hitLog);
    w.int(p.ph === undefined ? 0 : p.ph + 1);
    w.int(p.ult === undefined ? 0 : p.ult + 1);
  }
  return w.out();
}

export function decodeWorld(bytes, ctx) {
  const r = new Reader(bytes);
  const snap = { tick: r.int(), rng: r.int(), nextSeq: r.int() };
  snap.mode = { type: r.str(ctx), t: r.int(), limit: r.int(), over: !!r.int(), winner: r.int(), overtime: !!r.int(), ff: r.int() };
  const uv = [];
  for (let i = 0; i < 6; i++) uv.push(r.int());
  snap.ult = ultFromVec(uv, readList(r));
  const nf = r.int();
  snap.fighters = [];
  for (let i = 0; i < nf; i++) {
    const f = {};
    for (const k of F_INTS) f[k] = r.int();
    const fl = r.byte();
    f.dead = !!(fl & 1);
    f.seatHuman = !!(fl & 2);
    f.charId = r.str(ctx);
    f.kind = r.str(ctx);
    f.move = r.str(ctx);
    f.hm = r.str(ctx);
    const bi = r.int();
    f.buf = bi ? ctx.strs[bi - 1] : '';
    const hn = r.int();
    f.hist = [];
    for (let j = 0; j < hn; j++) f.hist.push(r.byte());
    f.hitLog = readLog(r);
    f.ultDmg = readMap(r);
    f.ai = { lvl: r.int(), tgt: r.int(), cd: 30, period: 30, q: [], script: [], defUntil: 0, reactCd: 0, cdA: 0, zOff: 0, spT: 0, lastIn: 0 };
    snap.fighters.push(f);
  }
  const np = r.int();
  snap.projectiles = [];
  for (let i = 0; i < np; i++) {
    const p = {};
    for (const k of P_INTS) p[k] = r.int();
    p.dead = !!r.byte();
    p.ch = r.str(ctx);
    p.kind = r.str(ctx);
    p.hitLog = readLog(r);
    const ph = r.int();
    const pu = r.int();
    if (ph) p.ph = ph - 1;
    if (pu) p.ult = pu - 1;
    snap.projectiles.push(p);
  }
  return snap;
}

// ---- 差量快照(15 Hz 一般訊息用):以「上一則快照」為底,只送有變化的欄位;每秒另送一則完整關鍵格 ----
// 欄位向量:全狀態的整數欄位 + 旗標 + 字串表索引,逐欄位比對;hist 以「附加 n 個位元組」表示;hitLog 有變才整份重送。
const strIdx = (ctx, s) => (s == null ? 0 : ctx.idx.get(s));
const strAt = (ctx, i) => (i ? ctx.strs[i - 1] : null);
const P_N = P_INTS.length + 5;

function vecMode(m, ctx) {
  return [strIdx(ctx, m.type), m.t, m.limit, m.over ? 1 : 0, m.winner, m.overtime ? 1 : 0, m.ff || 0];
}
function modeFromVec(v, ctx) {
  return { type: strAt(ctx, v[0]), t: v[1], limit: v[2], over: !!v[3], winner: v[4], overtime: !!v[5], ff: v[6] };
}
function vecF(f, ctx) {
  const v = F_INTS.map((k) => f[k]);
  v.push((f.dead ? 1 : 0) | (f.seatHuman ? 2 : 0), strIdx(ctx, f.charId), strIdx(ctx, f.kind), strIdx(ctx, f.move), strIdx(ctx, f.hm), f.ai.lvl, f.ai.tgt, f.buf ? strIdx(ctx, f.buf) : 0);
  return v;
}
function fFromVec(v, ctx, hist, hitLog, ultDmg) {
  const f = {};
  F_INTS.forEach((k, i) => { f[k] = v[i]; });
  const n = F_INTS.length;
  f.dead = !!(v[n] & 1);
  f.seatHuman = !!(v[n] & 2);
  f.charId = strAt(ctx, v[n + 1]);
  f.kind = strAt(ctx, v[n + 2]);
  f.move = strAt(ctx, v[n + 3]);
  f.hm = strAt(ctx, v[n + 4]);
  f.buf = v[n + 7] ? strAt(ctx, v[n + 7]) : '';
  f.hist = hist;
  f.hitLog = hitLog;
  f.ultDmg = ultDmg;
  f.ai = { lvl: v[n + 5], tgt: v[n + 6], cd: 30, period: 30, q: [], script: [], defUntil: 0, reactCd: 0, cdA: 0, zOff: 0, spT: 0, lastIn: 0 };
  return f;
}
function vecP(p, ctx) {
  const v = P_INTS.map((k) => p[k]);
  v.push(p.dead ? 1 : 0, strIdx(ctx, p.ch), strIdx(ctx, p.kind), p.ph === undefined ? 0 : p.ph + 1, p.ult === undefined ? 0 : p.ult + 1);
  return v;
}
function pFromVec(v, ctx, hitLog) {
  const p = {};
  P_INTS.forEach((k, i) => { p[k] = v[i]; });
  const n = P_INTS.length;
  p.dead = !!v[n];
  p.ch = strAt(ctx, v[n + 1]);
  p.kind = strAt(ctx, v[n + 2]);
  p.hitLog = hitLog;
  if (v[n + 3]) p.ph = v[n + 3] - 1;
  if (v[n + 4]) p.ult = v[n + 4] - 1;
  return p;
}
function changes(a, b) {
  const out = [];
  for (let i = 0; i < b.length; i++) if (a[i] !== b[i]) out.push(i);
  return out;
}
function writeChanges(w, list, a, b) {
  for (const i of list) {
    w.int(i);
    w.int(b[i] - a[i]);
  }
}
function readChanges(r, n, v) {
  for (let j = 0; j < n; j++) {
    const i = r.int();
    v[i] += r.int();
  }
}
const sameLog = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const cloneLog = (a) => JSON.parse(JSON.stringify(a));
const HIST_MAX = 16;
// 回傳新增的位元組數(0 = 沒變、-1 = 無法用附加表示)
function histAppend(a, b) {
  if (a.length === b.length && a.every((x, i) => x === b[i])) return 0;
  for (let c = 1; c <= b.length; c++) {
    const cand = a.concat(b.slice(b.length - c)).slice(-HIST_MAX);
    if (cand.length === b.length && cand.every((x, i) => x === b[i])) return c;
  }
  return -1;
}
function writeHist(w, a, b) {
  const c = histAppend(a, b);
  if (c < 0) {
    w.int(-1);
    w.int(b.length);
    for (const x of b) w.byte(x);
    return;
  }
  const app = b.slice(b.length - c);
  if (app.every((x) => x === app[0])) {
    w.int(c * 2 + 1);
    w.byte(app[0]);
  } else {
    w.int(c * 2);
    for (const x of app) w.byte(x);
  }
}
function readHist(r, a) {
  const code = r.int();
  if (code < 0) {
    const n = r.int();
    const h = [];
    for (let i = 0; i < n; i++) h.push(r.byte());
    return h;
  }
  const c = Math.floor(code / 2);
  const app = [];
  if (code % 2) {
    const v = r.byte();
    for (let i = 0; i < c; i++) app.push(v);
  } else {
    for (let i = 0; i < c; i++) app.push(r.byte());
  }
  return a.concat(app).slice(-HIST_MAX);
}

// base / cur = serializeWorld(或 decodeWorld)的結果。角色數不同時回傳 null(呼叫端改送完整快照)。
export function encodeDelta(base, cur, ctx) {
  if (base.fighters.length !== cur.fighters.length) return null;
  const w = new Writer();
  w.int(cur.tick - base.tick);
  w.int(cur.rng);
  w.int(cur.nextSeq - base.nextSeq);
  const bm = vecMode(base.mode, ctx);
  const cm = vecMode(cur.mode, ctx);
  const ml = changes(bm, cm);
  w.int(ml.length);
  writeChanges(w, ml, bm, cm);
  const bu = ultOf(base);
  const cu = ultOf(cur);
  const buv = vecUlt(bu);
  const cuv = vecUlt(cu);
  const ul = changes(buv, cuv);
  w.int(ul.length);
  writeChanges(w, ul, buv, cuv);
  const qs = sameLog(bu.q, cu.q) ? 0 : 1;
  w.int(qs);
  if (qs) writeList(w, cu.q);
  w.int(cur.fighters.length);
  for (let i = 0; i < cur.fighters.length; i++) {
    const bf = base.fighters[i];
    const cf = cur.fighters[i];
    const bv = vecF(bf, ctx);
    const cv = vecF(cf, ctx);
    const l = changes(bv, cv);
    const hs = histAppend(bf.hist, cf.hist) !== 0 ? 1 : 0;
    const hl = sameLog(bf.hitLog, cf.hitLog) ? 0 : 1;
    const ud = sameLog(bf.ultDmg || {}, cf.ultDmg || {}) ? 0 : 1;
    w.int(l.length * 8 + ud * 4 + hl * 2 + hs);
    writeChanges(w, l, bv, cv);
    if (hs) writeHist(w, bf.hist, cf.hist);
    if (hl) writeLog(w, cf.hitLog);
    if (ud) writeMap(w, cf.ultDmg);
  }
  const oldIdx = new Map(base.projectiles.map((p, i) => [p.id, i]));
  w.int(cur.projectiles.length);
  for (const p of cur.projectiles) {
    const oi = oldIdx.get(p.id);
    const cv = vecP(p, ctx);
    if (oi === undefined) {
      w.int(0);
      for (const x of cv) w.int(x);
      writeLog(w, p.hitLog);
      continue;
    }
    const bp = base.projectiles[oi];
    const bv = vecP(bp, ctx);
    const l = changes(bv, cv);
    const hl = sameLog(bp.hitLog, p.hitLog) ? 0 : 1;
    w.int(oi + 1);
    w.int(l.length * 2 + hl);
    writeChanges(w, l, bv, cv);
    if (hl) writeLog(w, p.hitLog);
  }
  return w.out();
}

// 套用差量:回傳新的完整快照(不修改 base);結果與 decodeWorld(encodeWorld(cur)) 逐欄位相同
export function applyDelta(base, bytes, ctx) {
  const r = new Reader(bytes);
  const snap = { tick: base.tick + r.int(), rng: r.int(), nextSeq: 0 };
  snap.nextSeq = base.nextSeq + r.int();
  const mv = vecMode(base.mode, ctx);
  readChanges(r, r.int(), mv);
  snap.mode = modeFromVec(mv, ctx);
  const bu = ultOf(base);
  const uv = vecUlt(bu);
  readChanges(r, r.int(), uv);
  snap.ult = ultFromVec(uv, r.int() ? readList(r) : bu.q.slice());
  const nf = r.int();
  snap.fighters = [];
  for (let i = 0; i < nf; i++) {
    const bf = base.fighters[i];
    const v = vecF(bf, ctx);
    const hdr = r.int();
    readChanges(r, Math.floor(hdr / 8), v);
    const hist = hdr & 1 ? readHist(r, bf.hist) : bf.hist.slice();
    const hitLog = hdr & 2 ? readLog(r) : cloneLog(bf.hitLog);
    const ultDmg = hdr & 4 ? readMap(r) : cloneLog(bf.ultDmg || {});
    snap.fighters.push(fFromVec(v, ctx, hist, hitLog, ultDmg));
  }
  const np = r.int();
  snap.projectiles = [];
  for (let i = 0; i < np; i++) {
    const oi = r.int();
    if (oi === 0) {
      const v = [];
      for (let j = 0; j < P_N; j++) v.push(r.int());
      snap.projectiles.push(pFromVec(v, ctx, readLog(r)));
      continue;
    }
    const bp = base.projectiles[oi - 1];
    const v = vecP(bp, ctx);
    const hdr = r.int();
    readChanges(r, Math.floor(hdr / 2), v);
    snap.projectiles.push(pFromVec(v, ctx, hdr & 1 ? readLog(r) : cloneLog(bp.hitLog)));
  }
  return snap;
}

// ---- base64 ----
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export function b64enc(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 3) {
    const a = u8[i];
    const b = i + 1 < u8.length ? u8[i + 1] : 0;
    const c = i + 2 < u8.length ? u8[i + 2] : 0;
    s += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)];
    s += i + 1 < u8.length ? B64[((b & 15) << 2) | (c >> 6)] : '=';
    s += i + 2 < u8.length ? B64[c & 63] : '=';
  }
  return s;
}
export function b64dec(str) {
  const clean = str.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const a = B64.indexOf(clean[i]);
    const b = B64.indexOf(clean[i + 1]);
    const c = i + 2 < clean.length ? B64.indexOf(clean[i + 2]) : 0;
    const d = i + 3 < clean.length ? B64.indexOf(clean[i + 3]) : 0;
    out[o++] = (a << 2) | (b >> 4);
    if (i + 2 < clean.length) out[o++] = ((b & 15) << 4) | (c >> 2);
    if (i + 3 < clean.length) out[o++] = ((c & 3) << 6) | d;
  }
  return out;
}

// ---- 輸入封包:q = 序號、a = 預定生效 tick、d = 最近 8 tick 的輸入位元組(最後一個對應 tick a) ----
export function encodeInput(q, at, bytes8) {
  return { q, a: at, d: b64enc(Uint8Array.from(bytes8)) };
}
export function decodeInput(pkt) {
  return { q: pkt.q, at: pkt.a, bytes: Array.from(b64dec(pkt.d)) };
}

export function encodeSnapshotMsg(snap, ctx, meta) {
  return Object.assign({ t: snap.tick, d: b64enc(encodeWorld(snap, ctx)) }, meta);
}
export function decodeSnapshotMsg(msg, ctx) {
  return decodeWorld(b64dec(msg.d), ctx);
}
