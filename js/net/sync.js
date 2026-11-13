// 同步(草案 5-3、5-4):房主權威、15Hz 快照、客戶端預測 / 重播修正、輸入時間戳與緩衝、
// 本機先播命中回饋、其他角色插值。一個 Session 同時能當房主或客戶端(房主遷移時角色會切換)。
import { createWorld, stepWorld, serializeWorld, restoreWorld } from '../sim/world.js';
import { layoutSpawns } from '../sim/modes.js';
import { Net } from './net.js';
import { makeCtx, encodeWorld, decodeWorld, encodeDelta, applyDelta, b64enc, b64dec, encodeInput, decodeInput } from './codec.js';
import { Usage } from './usage.js';
import { BIT } from '../core/input.js';
import { S } from '../sim/fighter.js';
import { Migrator, promote, demote } from './migrate.js';

export const TICK_MS = 1000 / 60;
export const SNAP_EVERY = 4; // 15 Hz
export const SAVE_EVERY = 30; // 2 Hz
export const KEY_EVERY = 60; // 差量快照:每 60 tick(1 s)送一則完整關鍵格,丟包後最久等這麼久修正
export const HOST_INPUT_DELAY = 4; // 房主本機輸入延遲(67 ms)
export const AWAY_MS = 3000; // 3 s 沒輸入 → AI 暫代
export const FREEZE_MS = 1500; // 1.5 s 沒收到快照 → 視為房主中斷
const INTERP_TICKS = 6; // 插值緩衝 100 ms
const EXTRAP_TICKS = 6; // 外推上限 100 ms
const HEARTBEAT_MS = 200; // 輸入最少 5 Hz
const MIN_SEND_MS = 50; // 輸入最多 20 Hz
const SMOOTH_PX = 8; // 預測誤差 < 8 px 平滑拉回,否則直接跳
const SMOOTH_MS = 100;
const LEAD_EXTRA = 4; // 預測領先量的緩衝(草案 5-4 #3 寫 +2;因輸入最多 20Hz 節流,多留 2 tick 保住連段)

export function buildNetWorld(chars, stage, cfg) {
  const lay = layoutSpawns(cfg.seats.length, stage);
  const spawns = cfg.seats.map((s, i) => ({
    charId: s.char, kind: s.kind === 'human' ? 'human' : 'ai', lvl: s.lvl || 1,
    team: s.team === undefined ? i : s.team, x: lay[i].x, z: lay[i].z, face: lay[i].face
  }));
  return createWorld({ chars, seed: cfg.seed, stage, spawns, mode: cfg.mode, ff: cfg.ff || 0, ult: cfg.ult === undefined ? true : !!cfg.ult });
}

export class Session {
  // opts: tr, clock, code, seat, dev, chars, stage, cfg, rank
  constructor(o) {
    Object.assign(this, { tr: o.tr, clock: o.clock, code: o.code, seat: o.seat, dev: o.dev, chars: o.chars, stage: o.stage, cfg: o.cfg });
    this.rank = o.rank || 0;
    this.net = new Net(this.tr, this.clock, this.code);
    this.ctx = makeCtx(this.chars);
    this.usage = new Usage(this.tr, this.clock);
    this.fid = this.cfg.seats.findIndex((s) => s.seat === this.seat);
    this.fidSeat = this.cfg.seats.map((s) => s.seat);
    this.nonce = Math.floor(Math.random() * 1e9);
    this.role = null;
    this.epoch = 1;
    this.hostSeat = -1;
    this.succ = [];
    this.frozen = false;
    this.synced = false;
    this.migrator = new Migrator(this);
    this.stats = { corr: 0, corrDist: 0, sparks: 0, confirmed: 0, whiffs: 0, lateInputs: 0, migrations: 0, fullSent: 0, deltaSent: 0, snapBytes: 0, deltaMiss: 0 };
    this.onFx = null; // (events) => void
    this.onNotice = null; // (text) => void
    this.log = new Map();
    this.lastByte = 0;
    this.q = 0;
    this.sentAt = new Map();
    this.rtts = [];
    this.lastAck = 0;
    this.predTick = 0;
    this.snaps = [];
    this.chainS = null; // 差量鏈:客戶端最後套用成功的完整快照(下一則差量必須以它為底)
    this.chainE = 0;
    this.deltaBase = null; // 房主:上一則送出的快照(差量的底)
    this.pending = [];
    this.err = { dx: 0, dz: 0, t: 0 };
    this._net = (e) => {
      if (e && e.code === 'denied' && this.role === 'host') demote(this);
    };
  }

  // ---------- 啟動 ----------
  async startHost(epoch = 1) {
    this.role = 'host';
    this.epoch = epoch;
    this.hostSeat = this.seat;
    this.world = buildNetWorld(this.chars, this.stage, this.cfg);
    this._hostInit(this.clock.now());
    await this.net.save(this._saveRec());
    await this.net.announceHost(this.epoch, this.seat);
    this.net.listenHost((v) => this.onHostIn(v));
    this._publishSucc();
    this.hostReady = true;
  }

  _hostInit(now) {
    this.localQ = [];
    this.remote = {};
    for (const s of this.cfg.seats) {
      if (s.kind === 'human' && s.seat !== this.seat) this.remote[s.seat] = { table: new Map(), held: 0, lastRecv: now, lastQ: -1, nonce: 0, ack: 0, regainedAt: -1, consumed: -1, edgeOr: 0 };
    }
    this.deltaBase = null; // 新房主 / 遷移後:第一則一定送完整快照
    this.lastTouch = now;
    this.lastSucc = now;
    this.evN = this.evN || 0;
    this.resultSent = false;
  }

  async startClient() {
    this.role = 'client';
    this.pw = buildNetWorld(this.chars, this.stage, this.cfg);
    this.vw = buildNetWorld(this.chars, this.stage, this.cfg);
    this.lastSnapAt = this.clock.now();
    this.net.listenClient((v) => this.onC(v));
    // 回歸流程:先 GET save 當底(草案 5-5),之後由快照接手
    try {
      const save = await this.net.getSave();
      if (save && !this.synced) {
        this.epoch = Math.max(this.epoch, save.e);
        this.hostSeat = save.seat;
        const S0 = decodeWorld(b64dec(save.d), this.ctx);
        this.chainS = S0;
        this.chainE = save.e;
        this._adoptState(S0, save.tick, false);
      }
    } catch (e) { /* 斷線中:等快照 */ }
  }

  stop() {
    this.net.stopClient();
    this.net.stopHost();
    this.role = 'stopped';
    this.hostReady = false;
  }

  // ---------- 每 tick(60Hz,由外部迴圈驅動) ----------
  tick(localByte) {
    if (this.role === 'host') this._hostTick(localByte);
    else if (this.role === 'client') this._clientTick(localByte);
  }

  // ---------- 房主 ----------
  _hostTick(b) {
    if (!this.hostReady) return;
    const now = this.clock.now();
    if (this.resumeAt && now < this.resumeAt) {
      // 遷移後「繼續!」倒數,模式計時不走;期間仍每 0.5 s 更新 save,讓其他候選者看得出房主還活著(防雙房主)
      if (now - (this.lastResumeSave || 0) >= 500) {
        this.lastResumeSave = now;
        this.net.save(this._saveRec()).catch(this._net);
      }
      return;
    }
    if (this.resumeAt) {
      this.resumeAt = 0;
      this._broadcast();
    }
    const w = this.world;
    this.localQ.push(b);
    const lb = this.localQ.length > HOST_INPUT_DELAY ? this.localQ.shift() : 0;
    const inputs = [];
    for (const f of w.fighters) {
      if (!f.seatHuman) continue;
      const seat = this.fidSeat[f.id];
      if (seat === this.seat) {
        inputs[f.id] = lb;
        continue;
      }
      const rs = this.remote[seat];
      if (!rs) continue;
      if (now - rs.lastRecv > AWAY_MS && f.kind === 'human') {
        f.kind = 'ai';
        f.ai.lvl = 1;
        f.ai.script = [];
        f.ai.q = [];
        rs.awaySince = now;
      }
      let v = rs.table.get(w.tick);
      if (v === undefined) v = rs.held;
      else rs.held = v;
      rs.table.delete(w.tick - 16);
      rs.consumed = w.tick;
      if (rs.edgeOr) {
        v |= rs.edgeOr;
        rs.edgeOr = 0;
        this.stats.lateInputs++;
      }
      inputs[f.id] = v;
    }
    this.lastInputs = inputs;
    stepWorld(w, inputs);
    if (this.onFx && w.events.length) this.onFx(w.events);
    if (w.tick % SNAP_EVERY === 0) this._broadcast();
    if (w.tick % SAVE_EVERY === 0) this.net.save(this._saveRec()).catch(this._net);
    if (now - this.lastTouch > 30000) {
      this.lastTouch = now;
      this.net.touch().catch(() => {});
    }
    if (now - this.lastSucc > 5000) this._publishSucc();
    if (now - this.usage.lastFlush > 60000) this.usage.flush();
    if (w.mode.over && !this.resultSent) {
      this.resultSent = true;
      this.tr.set(this.net.path('result'), { winner: w.mode.winner, tick: w.tick, kills: w.fighters.map((f) => f.kills) }).catch(() => {});
      this.tr.update(this.net.path('meta'), { state: 'result', lastSeen: this.clock.wall() }).catch(() => {});
    }
  }

  _encodeState() {
    return b64enc(encodeWorld(serializeWorld(this.world), this.ctx));
  }
  _saveRec() {
    return { e: this.epoch, seat: this.seat, tick: this.world.tick, d: this._encodeState() };
  }
  _broadcast() {
    const k = [];
    for (const s in this.remote) k[s] = this.remote[s].ack;
    const snap = serializeWorld(this.world);
    const msg = { e: this.epoch, t: snap.tick, h: this.seat, k: Array.from(k, (v) => v || 0) };
    let delta = null;
    if (this.deltaBase && snap.tick % KEY_EVERY !== 0 && snap.tick > this.deltaBase.tick) delta = encodeDelta(this.deltaBase, snap, this.ctx);
    if (delta) {
      msg.b = this.deltaBase.tick;
      msg.d = b64enc(delta);
    } else msg.d = b64enc(encodeWorld(snap, this.ctx));
    this.deltaBase = snap;
    if (delta) this.stats.deltaSent++;
    else this.stats.fullSent++;
    this.stats.snapBytes += msg.d.length;
    this.usage.snapshotSent(JSON.stringify(msg).length, Object.keys(this.remote).length);
    this.net.broadcast(msg).catch(this._net);
  }
  _publishSucc() {
    this.lastSucc = this.clock.now();
    const list = this.cfg.seats
      .filter((s) => s.kind === 'human' && s.seat !== this.seat)
      .map((s) => ({ seat: s.seat, rank: (s.seat === this.seat ? this.rank : (this.ranks && this.ranks[s.seat]) || 0) }))
      .sort((a, b) => a.rank - b.rank || a.seat - b.seat)
      .map((x) => x.seat);
    // 房主自己排在最前(客戶端會排除目前房主);遷移後新房主也會重發
    this.net.publishEvent({ n: ++this.evN, t: 'succ', e: this.epoch, list: [this.seat].concat(list) }).catch(this._net);
  }

  onHostIn(v) {
    if (!v || this.role !== 'host') return;
    const now = this.clock.now();
    for (const key in v) {
      const seat = parseInt(key, 10);
      const rs = this.remote[seat];
      const pkt = v[key];
      if (!rs || !pkt) continue;
      if (pkt.n !== rs.nonce) {
        rs.nonce = pkt.n;
        rs.lastQ = -1;
      }
      if (pkt.q <= rs.lastQ) continue;
      rs.lastQ = pkt.q;
      rs.ack = pkt.q;
      const { at, bytes } = decodeInput(pkt);
      for (let j = 0; j < bytes.length; j++) {
        const t = at - (bytes.length - 1) + j;
        if (!rs.table.has(t)) {
          rs.table.set(t, bytes[j]);
          // 遲到的輸入:已過去的 tick 裡的「按下」邊緣不能丟,記下來在下一個 tick 補上(保住連段節奏)
          if (t <= rs.consumed && t > rs.consumed - 16) rs.edgeOr |= bytes[j] & ~(j > 0 ? bytes[j - 1] : rs.held);
        }
      }
      this.usage.inputReceived();
      if (at <= this.world.tick + 1) {
        rs.held = bytes[bytes.length - 1]; // 遲到的立即套用
        if (at < this.world.tick) this.stats.lateInputs++;
      }
      rs.lastRecv = now;
      const f = this.world.fighters[this.fidSeat.indexOf(seat)];
      if (f && f.seatHuman && f.kind === 'ai') {
        f.kind = 'human'; // 收到第一筆輸入即交還控制
        f.ai.script = [];
        rs.regainedAt = now;
      }
    }
  }

  // ---------- 客戶端 ----------
  onC(v) {
    if (!v || this.role !== 'client') return;
    if (v.ev && v.ev.n !== this.lastEvN) {
      this.lastEvN = v.ev.n;
      if (v.ev.t === 'succ') this.succ = v.ev.list;
    }
    if (v.snap && (v.snap.t !== this.lastSnapT || v.snap.e !== this.lastSnapE)) {
      this.lastSnapT = v.snap.t;
      this.lastSnapE = v.snap.e;
      this._onSnap(v.snap);
    }
  }

  _onSnap(msg) {
    if (msg.e < this.epoch) return;
    const now = this.clock.now();
    if (msg.e > this.epoch) {
      this.epoch = msg.e;
      this.stats.migrations++;
      if (this.onNotice) this.onNotice('繼續!');
    }
    this.hostSeat = msg.h;
    this.lastSnapAt = now;
    this.frozen = false;
    // RTT:快照內帶房主確認到的輸入序號
    const ack = msg.k && msg.k[this.seat];
    if (ack && ack > this.lastAck && this.sentAt.has(ack)) {
      this.lastAck = ack;
      this.rtts.push(now - this.sentAt.get(ack));
      if (this.rtts.length > 8) this.rtts.shift();
      for (const q of this.sentAt.keys()) if (q <= ack) this.sentAt.delete(q);
    }
    let S;
    if (msg.b === undefined) S = decodeWorld(b64dec(msg.d), this.ctx);
    else if (this.chainS && this.chainS.tick === msg.b && this.chainE === msg.e) S = applyDelta(this.chainS, b64dec(msg.d), this.ctx);
    else {
      // 差量的底不在手上(前面有訊息丟了):這則作廢,等下一個關鍵格修正;房主仍算活著(上面已更新 lastSnapAt)
      this.stats.deltaMiss++;
      return;
    }
    this.chainS = S;
    this.chainE = msg.e;
    this.snaps.push({ t: S.tick, recv: now, S });
    if (this.snaps.length > 12) this.snaps.shift();
    this._checkHits(S);
    this._adoptState(S, S.tick, true);
  }

  owTicks() {
    if (!this.rtts.length) return 6;
    return Math.max(1, Math.min(...this.rtts) / 2 / TICK_MS);
  }

  // 以權威狀態為底,重播尚未確認的本機輸入(草案 5-4 #2)
  _adoptState(S, tick, smooth) {
    const own = (w) => w.fighters[this.fid];
    const old = this.synced ? { x: own(this.pw).x, z: own(this.pw).z } : null;
    restoreWorld(this.pw, S);
    // 其他角色在預測世界裡依快照速度「續走」(外推),不做攻擊;提高本機命中預測的準度
    this.otherIn = [];
    for (const f of this.pw.fighters) {
      f.kind = 'human';
      if (f.id === this.fid) continue;
      let b = 0;
      if (f.state === S.IDLE || f.state === S.WALK || f.state === S.RUN) {
        if (f.vx > 0) b |= BIT.RIGHT;
        else if (f.vx < 0) b |= BIT.LEFT;
        if (f.vz > 0) b |= BIT.DOWN;
        else if (f.vz < 0) b |= BIT.UP;
      }
      this.otherIn[f.id] = b;
    }
    // 預測時間軸盡量連續:落後目標才往前補、領先太多才緩慢退 1 tick,避免每次快照來回跳動打亂輸入時間戳
    const target = S.tick + Math.round(2 * this.owTicks()) + LEAD_EXTRA;
    let pred = this.synced ? this.predTick : target;
    if (pred < target) pred = target;
    else if (pred > target + 3) pred -= 1;
    if (pred <= S.tick) pred = S.tick + 1;
    for (let t = S.tick + 1; t <= pred; t++) stepWorld(this.pw, this._ownInputs(t));
    this.predTick = pred;
    this.synced = true;
    if (old && smooth) {
      const f = own(this.pw);
      const dx = (old.x - f.x) / 256;
      const dz = (old.z - f.z) / 256;
      const d = Math.hypot(dx, dz);
      if (d >= 1) {
        this.stats.corr++;
        this.stats.corrDist += d;
        if (d < SMOOTH_PX) this.err = { dx, dz, t: this.clock.now() };
        else this.err = { dx: 0, dz: 0, t: 0 };
      }
    }
  }

  _ownInputs(t) {
    const a = this.otherIn ? this.otherIn.slice() : [];
    const v = this.log.get(t);
    a[this.fid] = v === undefined ? this.lastByte : v;
    return a;
  }

  _clientTick(b) {
    const now = this.clock.now();
    this.lastByte = b;
    if (!this.synced) return;
    if (!this.frozen && now - this.lastSnapAt > FREEZE_MS) {
      this.frozen = true;
      if (this.onNotice) this.onNotice('房主連線中斷,接手中…');
      this.migrator.begin();
    }
    if (this.frozen) return;
    this.predTick++;
    this.log.set(this.predTick, b);
    this.log.delete(this.predTick - 128);
    stepWorld(this.pw, this._ownInputs(this.predTick));
    // 本機先播命中回饋:自己的攻擊盒碰到對方 → 立即火花 / 停頓(傷害與擊退仍等房主)
    const mine = this.pw.events.filter((e) => e.t === 'hit' && e.a === this.fid);
    if (mine.length) {
      for (const e of mine) {
        this.stats.sparks++;
        this.pending.push({ tick: this.pw.tick, d: e.d });
      }
      if (this.onFx) this.onFx(mine);
    }
    this._sendInput(now, b);
  }

  _checkHits(S) {
    const keep = [];
    for (const h of this.pending) {
      if (S.tick < h.tick + 10) {
        keep.push(h);
        continue;
      }
      const f = S.fighters[h.d];
      if (f && f.lastAtk === this.fid && Math.abs(f.lastAtkTick - h.tick) <= 12) this.stats.confirmed++;
      else this.stats.whiffs++;
    }
    this.pending = keep;
  }

  _sendInput(now, b) {
    if (b !== this.lastSent) this.dirty = true;
    this.lastSent = b;
    const since = now - (this.lastSendAt === undefined ? -1e9 : this.lastSendAt);
    if (!((this.dirty && since >= MIN_SEND_MS) || since >= HEARTBEAT_MS)) return;
    this.dirty = false;
    this.lastSendAt = now;
    const at = this.predTick;
    const bytes = [];
    for (let t = at - 7; t <= at; t++) {
      const v = this.log.get(t);
      bytes.push(v === undefined ? this.lastByte : v);
    }
    const q = ++this.q;
    this.sentAt.set(q, now);
    const pkt = encodeInput(q, at, bytes);
    pkt.n = this.nonce;
    this.net.sendInput(this.seat, pkt).catch(() => {});
  }

  // ---------- 繪圖用視圖 ----------
  view() {
    if (this.role === 'host') return this.world;
    if (!this.snaps.length || !this.synced) return null;
    const last = this.snaps[this.snaps.length - 1];
    const est = last.t + (this.clock.now() - last.recv) / TICK_MS;
    let disp = est - INTERP_TICKS;
    let a = this.snaps[0];
    let b = a;
    for (const s of this.snaps) {
      if (s.t <= disp) a = s;
      b = s;
      if (s.t > disp) break;
    }
    const vw = this.vw;
    const pwOwn = this.pw.fighters[this.fid];
    vw.tick = last.t;
    vw.mode = last.S.mode;
    vw.projectiles = last.S.projectiles;
    vw.events = [];
    vw.fighters = a.S.fighters.map((fa, i) => {
      if (i === this.fid) {
        const e = this.err;
        const k = e.t ? Math.max(0, 1 - (this.clock.now() - e.t) / SMOOTH_MS) : 0;
        return Object.assign({}, pwOwn, { x: pwOwn.x + e.dx * 256 * k, z: pwOwn.z + e.dz * 256 * k });
      }
      const fb = b.S.fighters[i];
      let x = fa.x;
      let y = fa.y;
      let z = fa.z;
      if (b !== a && b.t > a.t) {
        const u = Math.max(0, Math.min(1, (disp - a.t) / (b.t - a.t)));
        x = fa.x + (fb.x - fa.x) * u;
        y = fa.y + (fb.y - fa.y) * u;
        z = fa.z + (fb.z - fa.z) * u;
      } else if (disp > a.t) {
        const ex = Math.min(EXTRAP_TICKS, disp - a.t); // 只外推移動速度
        x = fa.x + fa.vx * ex;
        z = fa.z + fa.vz * ex;
      }
      return Object.assign({}, fa, { x: Math.round(x), y: Math.round(y), z: Math.round(z) });
    });
    return vw;
  }
}
