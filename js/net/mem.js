// 本機模擬傳輸:記憶體 RTDB + 虛擬時鐘,可注入人工延遲、抖動、斷線、丟包。
// 用於自動測試與離線開發;語意貼近 Firebase RTDB(REST 寫入 + 事件推送 + ETag 條件寫入 + 安全規則)。
import { Rng } from '../core/rng.js';

export class VClock {
  constructor() {
    this.t = 0;
    this.timers = [];
    this.seq = 0;
  }
  now() {
    return this.t;
  }
  wall() {
    return 1700000000000 + this.t;
  }
  setTimeout(fn, ms) {
    const id = ++this.seq;
    this.timers.push({ at: this.t + Math.max(0, ms), id, fn });
    return id;
  }
  clearTimeout(id) {
    this.timers = this.timers.filter((x) => x.id !== id);
  }
  advance(ms) {
    const target = this.t + ms;
    for (;;) {
      let best = -1;
      for (let i = 0; i < this.timers.length; i++) {
        const x = this.timers[i];
        if (x.at <= target && (best < 0 || x.at < this.timers[best].at || (x.at === this.timers[best].at && x.id < this.timers[best].id))) best = i;
      }
      if (best < 0) break;
      const x = this.timers.splice(best, 1)[0];
      this.t = Math.max(this.t, x.at);
      x.fn();
    }
    this.t = target;
  }
}

export class RealClock {
  now() {
    return performance.now();
  }
  wall() {
    return Date.now();
  }
  setTimeout(fn, ms) {
    return setTimeout(fn, ms);
  }
  clearTimeout(id) {
    clearTimeout(id);
  }
}

const parts = (p) => (p ? p.split('/').filter(Boolean) : []);
const clone = (v) => (v === undefined || v === null ? null : JSON.parse(JSON.stringify(v)));

function getAt(tree, ps) {
  let n = tree;
  for (const k of ps) {
    if (n === null || typeof n !== 'object' || !(k in n)) return null;
    n = n[k];
  }
  return n === undefined ? null : n;
}

function setAt(tree, ps, v) {
  if (!ps.length) return v === null ? {} : v;
  let n = tree;
  for (let i = 0; i < ps.length - 1; i++) {
    if (n[ps[i]] === null || typeof n[ps[i]] !== 'object') n[ps[i]] = {};
    n = n[ps[i]];
  }
  if (v === null) delete n[ps[ps.length - 1]];
  else n[ps[ps.length - 1]] = v;
  return tree;
}

// 與 docs/firebase-rules.json 同語意的規則(epoch 檢查)
export function defaultRules(hub, path, value) {
  const m = /^rooms\/([^/]+)\/(save|c\/snap|c\/host)$/.exec(path);
  if (!m || value === null) return;
  const saveE = getAt(hub.tree, ['rooms', m[1], 'save', 'e']);
  if (m[2] === 'save') {
    if (saveE !== null && value.e < saveE) throw Object.assign(new Error('PERMISSION_DENIED'), { code: 'denied' });
  } else if (value.e !== saveE) {
    throw Object.assign(new Error('PERMISSION_DENIED'), { code: 'denied' });
  }
}

export class MemHub {
  constructor(clock, opts = {}) {
    this.clock = clock;
    this.tree = {};
    this.ver = {};
    this.listeners = [];
    this.rules = opts.rules === undefined ? defaultRules : opts.rules;
    this.rng = new Rng(opts.seed || 12345);
    this.stats = { writes: 0, denied: 0, dropped: 0, bytesDown: 0 };
  }
  client(opts = {}) {
    return new MemTransport(this, opts);
  }
  _bump(path) {
    const ps = parts(path);
    for (let i = 0; i <= ps.length; i++) {
      const k = ps.slice(0, i).join('/');
      this.ver[k] = (this.ver[k] || 0) + 1;
    }
    const pre = ps.join('/') + '/';
    for (const k in this.ver) if (k.startsWith(pre)) this.ver[k]++;
  }
  etag(path) {
    return String(this.ver[parts(path).join('/')] || 0);
  }
  get(path) {
    return clone(getAt(this.tree, parts(path)));
  }
  _write(path, value) {
    const ps = parts(path);
    if (value && typeof value === 'object' && value['.sv'] && value['.sv'].increment !== undefined) {
      value = (getAt(this.tree, ps) || 0) + value['.sv'].increment;
    }
    if (this.rules) {
      try {
        this.rules(this, ps.join('/'), value);
      } catch (e) {
        this.stats.denied++;
        throw e;
      }
    }
    this.tree = setAt(this.tree, ps, clone(value));
    this._bump(path);
    this.stats.writes++;
    this._notify(ps, value);
  }
  _notify(ps, written) {
    const wp = ps.join('/');
    const wire = JSON.stringify(written === undefined ? null : written).length + 90; // put 事件 + SSE/TLS 包裝(估算)
    for (const L of this.listeners) {
      const lp = L.ps.join('/');
      if (!(wp.startsWith(lp) || lp.startsWith(wp))) continue;
      this._deliver(L, clone(getAt(this.tree, L.ps)), wire);
    }
  }
  _deliver(L, value, wire) {
    const c = L.client;
    const at = Math.max(c.lastDown + 0.001, this.clock.now() + c._delay());
    c.lastDown = at;
    this.clock.setTimeout(() => {
      if (!c.online || L.dead) return;
      this.stats.bytesDown += wire === undefined ? JSON.stringify(value).length + 90 : wire;
      L.cb(value);
    }, at - this.clock.now());
  }
}

export class MemTransport {
  constructor(hub, opts) {
    this.hub = hub;
    this.clock = hub.clock;
    this.base = opts.base === undefined ? 100 : opts.base; // 單程延遲 ms
    this.jitter = opts.jitter === undefined ? 30 : opts.jitter;
    this.drop = opts.drop || 0; // 只作用在 lossy 寫入
    this.online = true;
    this.lastUp = 0;
    this.lastDown = 0;
    this.stateCbs = [];
    this.myListeners = [];
  }
  _delay() {
    return Math.max(1, this.base + (this.hub.rng.int(2001) / 1000 - 1) * this.jitter);
  }
  onState(cb) {
    this.stateCbs.push(cb);
  }
  setOnline(on) {
    if (on === this.online) return;
    this.online = on;
    if (!on) {
      this.stateCbs.forEach((cb) => cb('down'));
      return;
    }
    // EventSource 重連:稍後重新送達目前值
    this.clock.setTimeout(() => {
      if (!this.online) return;
      this.stateCbs.forEach((cb) => cb('up'));
      for (const L of this.myListeners) if (!L.dead) this.hub._deliver(L, clone(getAt(this.hub.tree, L.ps)));
    }, 300);
  }
  _req(fn, lossy) {
    const clock = this.clock;
    return new Promise((resolve, reject) => {
      if (!this.online) {
        clock.setTimeout(() => reject(Object.assign(new Error('offline'), { code: 'offline' })), 50);
        return;
      }
      const at = Math.max(this.lastUp + 0.001, clock.now() + this._delay());
      this.lastUp = at;
      clock.setTimeout(() => {
        if (lossy && this.drop && this.hub.rng.int(1000) < this.drop * 1000) {
          this.hub.stats.dropped++;
          resolve();
          return;
        }
        let r;
        let err = null;
        try {
          r = fn();
        } catch (e) {
          err = e;
        }
        clock.setTimeout(() => (err ? reject(err) : resolve(r)), this._delay());
      }, at - clock.now());
    });
  }
  get(path) {
    return this._req(() => this.hub.get(path));
  }
  getEtag(path) {
    return this._req(() => ({ v: this.hub.get(path), etag: this.hub.etag(path) }));
  }
  set(path, v, opt) {
    return this._req(() => this.hub._write(path, v), opt && opt.lossy);
  }
  update(path, obj, opt) {
    return this._req(() => {
      for (const k in obj) this.hub._write(path + '/' + k, obj[k]);
    }, opt && opt.lossy);
  }
  remove(path) {
    return this._req(() => this.hub._write(path, null));
  }
  setIf(path, v, etag) {
    return this._req(() => {
      if (this.hub.etag(path) !== etag) return false;
      this.hub._write(path, v);
      return true;
    });
  }
  listen(path, cb) {
    const L = { ps: parts(path), cb, client: this, dead: false };
    // 訂閱生效要先經過一個上行延遲
    this.clock.setTimeout(() => {
      if (L.dead) return;
      this.hub.listeners.push(L);
      this.myListeners.push(L);
      this.hub._deliver(L, clone(getAt(this.hub.tree, L.ps)));
    }, this._delay());
    return () => {
      L.dead = true;
      this.hub.listeners = this.hub.listeners.filter((x) => x !== L);
      this.myListeners = this.myListeners.filter((x) => x !== L);
    };
  }
}
