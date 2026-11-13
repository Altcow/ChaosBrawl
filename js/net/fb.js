// Firebase RTDB 傳輸:純 REST 寫入 + EventSource 監聽,不載入 SDK。
// 注意:尚未連過真實資料庫(使用者還沒建專案),僅做過介面與單元層級檢查。
const enc = (p) => p.split('/').filter(Boolean).map(encodeURIComponent).join('/');

function applyEvent(root, path, data, merge) {
  const ps = path.split('/').filter(Boolean);
  if (!ps.length) {
    if (!merge) return data === undefined ? null : data;
    const o = root && typeof root === 'object' ? root : {};
    for (const k in data) {
      if (data[k] === null) delete o[k];
      else o[k] = data[k];
    }
    return o;
  }
  let o = root && typeof root === 'object' ? root : {};
  const top = o;
  for (let i = 0; i < ps.length - 1; i++) {
    if (!o[ps[i]] || typeof o[ps[i]] !== 'object') o[ps[i]] = {};
    o = o[ps[i]];
  }
  const last = ps[ps.length - 1];
  if (merge) {
    const t = o[last] && typeof o[last] === 'object' ? o[last] : {};
    for (const k in data) {
      if (data[k] === null) delete t[k];
      else t[k] = data[k];
    }
    o[last] = t;
  } else if (data === null) delete o[last];
  else o[last] = data;
  return top;
}

export class FbTransport {
  // base:資料庫網址(結尾不含斜線)。fetchImpl / EventSourceImpl 可注入以便單元測試。
  constructor(base, opts = {}) {
    this.base = base.replace(/\/+$/, '');
    this.fetch = opts.fetch || ((...a) => fetch(...a));
    this.ES = opts.EventSource || (typeof EventSource !== 'undefined' ? EventSource : null);
    this.online = true;
    this.stateCbs = [];
  }
  onState(cb) {
    this.stateCbs.push(cb);
  }
  _url(path, q) {
    return this.base + '/' + enc(path) + '.json' + (q ? '?' + q : '');
  }
  async _json(res) {
    if (res.status === 401 || res.status === 403) throw Object.assign(new Error('PERMISSION_DENIED'), { code: 'denied' });
    if (!res.ok && res.status !== 412) throw Object.assign(new Error('HTTP ' + res.status), { code: 'http' });
    return res;
  }
  async get(path) {
    const res = await this._json(await this.fetch(this._url(path)));
    return res.json();
  }
  async getEtag(path) {
    const res = await this._json(await this.fetch(this._url(path), { headers: { 'X-Firebase-ETag': 'true' } }));
    return { v: await res.json(), etag: res.headers.get('ETag') };
  }
  async set(path, v) {
    await this._json(await this.fetch(this._url(path, 'print=silent'), { method: 'PUT', body: JSON.stringify(v) }));
  }
  async update(path, obj) {
    await this._json(await this.fetch(this._url(path, 'print=silent'), { method: 'PATCH', body: JSON.stringify(obj) }));
  }
  async remove(path) {
    await this._json(await this.fetch(this._url(path, 'print=silent'), { method: 'DELETE' }));
  }
  async setIf(path, v, etag) {
    // 真實 Firebase 不允許 if-match 與 print=silent 並用(HTTP 400),所以條件寫入不帶 print=silent
    const res = await this._json(await this.fetch(this._url(path), { method: 'PUT', headers: { 'if-match': etag }, body: JSON.stringify(v) }));
    return res.status !== 412;
  }
  // 回傳取消函式。callback 收到監聽節點的完整目前值(本地依 put/patch 事件合併)。
  listen(path, cb) {
    if (!this.ES) throw new Error('EventSource unavailable');
    let cache = null;
    const es = new this.ES(this._url(path));
    es.addEventListener('open', () => this.stateCbs.forEach((f) => f('up')));
    es.addEventListener('error', () => this.stateCbs.forEach((f) => f('down')));
    const onEvt = (merge) => (e) => {
      const m = JSON.parse(e.data);
      cache = applyEvent(cache, m.path, m.data, merge);
      cb(cache === null ? null : JSON.parse(JSON.stringify(cache)));
    };
    es.addEventListener('put', onEvt(false));
    es.addEventListener('patch', onEvt(true));
    es.addEventListener('cancel', () => es.close());
    es.addEventListener('auth_revoked', () => es.close());
    return () => es.close();
  }
}

export { applyEvent };
