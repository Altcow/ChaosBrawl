// 編碼:世界全狀態(快照 / save 共用)、輸入封包。位元組 → base64 字串供 RTDB JSON 傳輸。
// 全狀態用變長整數(zigzag varint),字串用共用字串表索引(兩端由同一份角色資料建表)。

export function makeCtx(chars) {
  const set = new Set(['human', 'ai', 'post', 'puncher', 'practice', 'brawl', 'timed', 'team']);
  for (const id in chars) {
    set.add(id);
    for (const m in chars[id].moves) set.add(m);
    for (const p in chars[id].projectiles || {}) set.add(p);
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
  'hp', 'gray', 'mp', 'fall', 'bdef', 'sinceHit', 'hitstop', 'rollCd', 'getupDir', 'stunT', 'airHits', 'inv', 'silence',
  'deadTick', 'kills', 'lastAtk', 'lastAtkTick', 'mf', 'mt', 'mtot', 'mseq', 'hf', 'prev', 'pend', 'tapDir', 'tapT'];
const P_INTS = ['id', 'owner', 'x', 'y', 'z', 'face', 'vx', 'vz', 'life'];

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
  w.int(snap.fighters.length);
  for (const f of snap.fighters) {
    for (const k of F_INTS) w.int(f[k]);
    w.byte((f.dead ? 1 : 0) | (f.seatHuman ? 2 : 0));
    w.str(ctx, f.charId);
    w.str(ctx, f.kind);
    w.str(ctx, f.move);
    w.str(ctx, f.hm);
    w.int(f.hist.length);
    for (const h of f.hist) w.byte(h);
    writeLog(w, f.hitLog);
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
  }
  return w.out();
}

export function decodeWorld(bytes, ctx) {
  const r = new Reader(bytes);
  const snap = { tick: r.int(), rng: r.int(), nextSeq: r.int() };
  snap.mode = { type: r.str(ctx), t: r.int(), limit: r.int(), over: !!r.int(), winner: r.int(), overtime: !!r.int(), ff: r.int() };
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
    const hn = r.int();
    f.hist = [];
    for (let j = 0; j < hn; j++) f.hist.push(r.byte());
    f.hitLog = readLog(r);
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
    snap.projectiles.push(p);
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
