// M3 連線測試(本機模擬傳輸 + 虛擬時鐘,不碰真實網路):node tools/net-test.mjs [long]
// Firebase 實作只做單元層級檢查(mock fetch / EventSource);真網路未驗證。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { VClock, MemHub } from '../js/net/mem.js';
import { FbTransport, applyEvent } from '../js/net/fb.js';
import { createRoom, joinRoom, startMatch, setSeat, expired, planSeats, applyPlan, leaveSeat } from '../js/net/lobby.js';
import { Session, TICK_MS, buildNetWorld } from '../js/net/sync.js';
import { makeCtx, encodeWorld, decodeWorld, b64enc, b64dec } from '../js/net/codec.js';
import { Usage } from '../js/net/usage.js';
import { serializeWorld, restoreWorld, stepWorld, hashWorld } from '../js/sim/world.js';
import { Rng } from '../js/core/rng.js';
import { BIT } from '../js/core/input.js';
import { S } from '../js/sim/fighter.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ids = JSON.parse(readFileSync(join(root, 'data/chars/index.json'), 'utf8'));
const chars = {};
for (const id of ids) chars[id] = JSON.parse(readFileSync(join(root, 'data/chars/' + id + '.json'), 'utf8'));
const stage = JSON.parse(readFileSync(join(root, 'data/stages/market.json'), 'utf8'));
const LONG = process.argv[2] === 'long';

let pass = 0;
let fail = 0;
function check(name, ok, info) {
  if (ok) pass++;
  else fail++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (info ? '  (' + info + ')' : ''));
}
const tick = () => new Promise((r) => setImmediate(r));

// ---------- 測試場景 ----------
async function makeRoom(o = {}) {
  const clock = new VClock();
  const hub = new MemHub(clock, { seed: o.seed || 1 });
  const lat = { base: o.base === undefined ? 100 : o.base, jitter: o.jitter === undefined ? 30 : o.jitter, drop: o.drop || 0 };
  const n = o.humans || 4;
  const trs = [];
  for (let i = 0; i < n; i++) trs.push(hub.client(lat));
  const rng = new Rng(77);
  const wait = async (p) => {
    let done = false;
    let val;
    let err;
    p.then((v) => { done = true; val = v; }, (e) => { done = true; err = e; });
    while (!done) {
      clock.advance(5);
      await tick();
    }
    if (err) throw err;
    return val;
  };
  const room = await wait(createRoom(trs[0], clock, { dev: 'dev0', name: 'p0', char: 'ada', rank: 0, rand: (k) => rng.int(k) }));
  for (let i = 1; i < n; i++) await wait(joinRoom(trs[i], clock, room.code, { dev: 'dev' + i, name: 'p' + i, char: ids[i % ids.length], rank: i }));
  for (let a = 0; a < (o.ais || 0); a++) await wait(setSeat(trs[0], room.code, n + a, { kind: 'ai', char: ids[(n + a) % 4], lvl: 2 }));
  const cfg = await wait(startMatch(trs[0], clock, room.code, { mode: o.mode || 'practice', seed: 7, stage: 'market' }));
  const peers = [];
  for (let i = 0; i < n; i++) {
    const sess = new Session({ tr: trs[i], clock, code: room.code, seat: i, dev: 'dev' + i, chars, stage, cfg, rank: i });
    peers.push({ i, tr: trs[i], sess, dead: false });
  }
  await wait(peers[0].sess.startHost());
  for (let i = 1; i < n; i++) peers[i].sess.startClient();
  const R = {
    clock, hub, peers, cfg, code: room.code, wait, rng,
    async drive(ms, fn) {
      const n = Math.round(ms / TICK_MS);
      for (let k = 0; k < n; k++) {
        clock.advance(TICK_MS);
        for (const p of peers) if (!p.dead) p.sess.tick(fn ? fn(p, k) : 0);
        if (R.tickHook) R.tickHook();
        await tick();
      }
    },
    async until(cond, maxMs, fn) {
      const t0 = clock.now();
      while (clock.now() - t0 < maxMs) {
        if (cond()) return clock.now() - t0;
        await R.drive(50, fn);
      }
      return cond() ? clock.now() - t0 : -1;
    },
    hosts: () => peers.filter((p) => !p.dead && p.tr.online && p.sess.role === 'host'),
    fighterOf: (p) => (p.sess.role === 'host' ? p.sess.world : R.hostPeer().sess.world).fighters[p.sess.fid],
    hostPeer: () => peers.find((p) => !p.dead && p.sess.role === 'host')
  };
  // 等所有客戶端同步
  await R.until(() => peers.every((p) => p.sess.role === 'host' || p.sess.synced), 5000);
  return R;
}

// 簡單的人類行為:隨機走動與攻擊
function wander(seed) {
  const r = new Rng(seed);
  const cur = {};
  return (p, k) => {
    if (k % 20 === 0 || cur[p.i] === undefined) cur[p.i] = r.next() & 31;
    return cur[p.i];
  };
}

// ---------- 1. 編碼 ----------
{
  const ctx = makeCtx(chars);
  const w = buildNetWorld(chars, stage, { mode: 'brawl', seed: 3, seats: [0, 1, 2, 3].map((i) => ({ seat: i, kind: i < 2 ? 'human' : 'ai', char: ids[i], lvl: 2 })) });
  const r = new Rng(9);
  for (let t = 0; t < 900; t++) stepWorld(w, [r.next() & 127, r.next() & 127]);
  const snap = serializeWorld(w);
  const bytes = encodeWorld(snap, ctx);
  const back = decodeWorld(bytes, ctx);
  const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
  const noAi = (sn) => JSON.stringify(canon(Object.assign({}, sn, { fighters: sn.fighters.map((f) => Object.assign({}, f, { ai: null })) })));
  const same = (a, b) => JSON.stringify(a.fighters.map((f) => [f.x, f.y, f.z, f.hp, f.state, f.move, f.hist, f.hitLog, f.fall])) === JSON.stringify(b.fighters.map((f) => [f.x, f.y, f.z, f.hp, f.state, f.move, f.hist, f.hitLog, f.fall]));
  check('世界全狀態編碼 → 解碼一致', same(snap, back) && back.tick === snap.tick && back.rng === snap.rng && JSON.stringify(back.mode) === JSON.stringify(snap.mode));
  // 還原後續跑結果一致(人類角色不依賴 AI 內部狀態)
  const w1 = buildNetWorld(chars, stage, { mode: 'practice', seed: 3, seats: [0, 1].map((i) => ({ seat: i, kind: 'human', char: ids[i], lvl: 1 })) });
  const w2 = buildNetWorld(chars, stage, { mode: 'practice', seed: 3, seats: [0, 1].map((i) => ({ seat: i, kind: 'human', char: ids[i], lvl: 1 })) });
  const rr = new Rng(4);
  const ins = [];
  for (let t = 0; t < 1200; t++) ins.push([rr.next() & 127, rr.next() & 127]);
  for (let t = 0; t < 600; t++) stepWorld(w1, ins[t]);
  restoreWorld(w2, decodeWorld(encodeWorld(serializeWorld(w1), ctx), ctx));
  for (let t = 600; t < 1200; t++) {
    stepWorld(w1, ins[t]);
    stepWorld(w2, ins[t]);
  }
  check('快照編碼後還原,續跑 600 tick 狀態一致(不含 AI 內部思考狀態)', noAi(serializeWorld(w1)) === noAi(serializeWorld(w2)));
  const s4 = b64enc(encodeWorld(serializeWorld(buildNetWorld(chars, stage, { mode: 'practice', seed: 1, seats: [0, 1, 2, 3].map((i) => ({ seat: i, kind: 'human', char: ids[i], lvl: 1 })) })), ctx)).length;
  const s4f = b64enc(bytes).length;
  console.log('INFO 4 角色快照 base64 長度:開局 ' + s4 + ' B、戰鬥中 ' + s4f + ' B(草案 5-3-2 估 400 B;本實作為全狀態,見疑點)');
  const rt = b64dec(b64enc(Uint8Array.from([0, 1, 2, 250, 255, 7, 9])));
  check('base64 往返', JSON.stringify(Array.from(rt)) === '[0,1,2,250,255,7,9]');
}

// ---------- 2. 大廳 ----------
{
  const clock = new VClock();
  const hub = new MemHub(clock);
  const t = [hub.client({ base: 20, jitter: 0 }), hub.client({ base: 20, jitter: 0 }), hub.client({ base: 20, jitter: 0 }), hub.client({ base: 20, jitter: 0 }), hub.client({ base: 20, jitter: 0 })];
  const wait = async (p) => {
    let d = false, v, e;
    p.then((x) => { d = true; v = x; }, (x) => { d = true; e = x; });
    while (!d) { clock.advance(5); await tick(); }
    if (e) throw e;
    return v;
  };
  const rng = new Rng(5);
  const room = await wait(createRoom(t[0], clock, { dev: 'a', name: 'A', rand: (k) => rng.int(k) }));
  check('建房得到 4 碼房號', /^[A-Z2-9]{4}$/.test(room.code), room.code);
  const j1 = await wait(joinRoom(t[1], clock, room.code, { dev: 'b', name: 'B' }));
  const j2 = await wait(joinRoom(t[2], clock, room.code, { dev: 'c', name: 'C' }));
  const j3 = await wait(joinRoom(t[3], clock, room.code, { dev: 'd', name: 'D' }));
  check('加入者依序拿到座位 1/2/3', j1.seat === 1 && j2.seat === 2 && j3.seat === 3);
  for (let i = 4; i < 8; i++) { const tt = hub.client({ base: 20, jitter: 0 }); await wait(joinRoom(tt, clock, room.code, { dev: 'x' + i, name: 'X' + i })); }
  let full = null;
  try { await wait(joinRoom(t[4], clock, room.code, { dev: 'e', name: 'E' })); } catch (e) { full = e.code; }
  check('第 9 人加入被拒(8 座位已滿)', full === 'full', String(full));
  let nf = null;
  try { await wait(joinRoom(t[4], clock, 'ZZZZ', { dev: 'e', name: 'E' })); } catch (e) { nf = e.code; }
  check('加入不存在的房號被拒', nf === 'noroom');
  // 同時搶最後一個座位:ETag 條件寫入只有一人成功
  const room2 = await wait(createRoom(t[0], clock, { dev: 'a', name: 'A', rand: (k) => rng.int(k) }));
  const res = await Promise.allSettled([wait(joinRoom(t[1], clock, room2.code, { dev: 'x1', name: 'X' })), wait(joinRoom(t[2], clock, room2.code, { dev: 'x2', name: 'Y' })), wait(joinRoom(t[3], clock, room2.code, { dev: 'x3', name: 'Z' }))]);
  const seatsGot = res.filter((r) => r.status === 'fulfilled').map((r) => r.value.seat).sort();
  check('三人同時加入各拿到不同座位', new Set(seatsGot).size === 3 && seatsGot.length === 3, seatsGot.join(','));
  // 過期規則
  const now = clock.wall();
  check('過期規則:大廳 5 分鐘 / 對戰 30 分鐘 / 對戰 29 分鐘仍有效',
    expired({ state: 'lobby', lastSeen: now - 6 * 60000 }, now) && !expired({ state: 'lobby', lastSeen: now - 4 * 60000 }, now) &&
    expired({ state: 'match', lastSeen: now - 31 * 60000, keep: 30 }, now) && !expired({ state: 'match', lastSeen: now - 29 * 60000, keep: 30 }, now));
  // 過期房號直接覆寫
  await wait(t[0].set('rooms/OLD1/meta', { state: 'lobby', lastSeen: now - 10 * 60000 }));
  check('過期房號可被覆寫(expired=true)', expired(await wait(t[0].get('rooms/OLD1/meta')), clock.wall()));
}

// ---------- 3. 規則(epoch)與 Firebase 實作單元 ----------
{
  const clock = new VClock();
  const hub = new MemHub(clock);
  const tr = hub.client({ base: 5, jitter: 0 });
  const wait = async (p) => {
    let d = false, v, e;
    p.then((x) => { d = true; v = x; }, (x) => { d = true; e = x; });
    while (!d) { clock.advance(5); await tick(); }
    if (e) throw e;
    return v;
  };
  await wait(tr.set('rooms/AAAA/save', { e: 2, seat: 1, tick: 0, d: '' }));
  let denied = 0;
  for (const [p, v] of [['rooms/AAAA/c/snap', { e: 1, t: 1, d: '' }], ['rooms/AAAA/save', { e: 1, seat: 0, tick: 5, d: '' }], ['rooms/AAAA/c/host', { e: 1, seat: 0 }]]) {
    try { await wait(tr.set(p, v)); } catch (e) { if (e.code === 'denied') denied++; }
  }
  let ok = true;
  try { await wait(tr.set('rooms/AAAA/c/snap', { e: 2, t: 1, d: '' })); } catch (e) { ok = false; }
  check('規則:舊 epoch 的 snap / save / host 寫入被拒、正確 epoch 通過', denied === 3 && ok);
  // 條件寫入
  const a = await wait(tr.getEtag('rooms/AAAA/save'));
  await wait(tr.set('rooms/AAAA/save', { e: 2, seat: 1, tick: 9, d: '' }));
  check('ETag 條件寫入:內容變更後舊 ETag 失敗', (await wait(tr.setIf('rooms/AAAA/save', { e: 3, seat: 2, tick: 9, d: '' }, a.etag))) === false);
  const b = await wait(tr.getEtag('rooms/AAAA/save'));
  check('ETag 條件寫入:最新 ETag 成功', (await wait(tr.setIf('rooms/AAAA/save', { e: 3, seat: 2, tick: 9, d: '' }, b.etag))) === true);

  // FbTransport:mock fetch / EventSource
  const calls = [];
  const mockFetch = async (url, init = {}) => {
    calls.push({ url, init });
    const status = init.headers && init.headers['if-match'] === 'stale' ? 412 : 200;
    return { ok: status === 200, status, json: async () => ({ x: 1 }), headers: { get: () => '"etag1"' } };
  };
  const fb = new FbTransport('https://example-rtdb.asia-southeast1.firebasedatabase.app/', { fetch: mockFetch, EventSource: class { addEventListener() {} close() {} } });
  await fb.set('rooms/AB12/c/snap', { e: 1 });
  await fb.update('rooms/AB12/meta', { a: 1 });
  const gt = await fb.getEtag('rooms/AB12/save');
  const cond = await fb.setIf('rooms/AB12/save', { e: 2 }, 'stale');
  check('Fb REST:PUT print=silent / PATCH / ETag 標頭 / 412 → false',
    calls[0].url.endsWith('/rooms/AB12/c/snap.json?print=silent') && calls[0].init.method === 'PUT' && calls[1].init.method === 'PATCH' &&
    calls[2].init.headers['X-Firebase-ETag'] === 'true' && gt.etag === '"etag1"' && cond === false, calls[0].url);
  let deniedFb = false;
  try { await new FbTransport('https://x', { fetch: async () => ({ ok: false, status: 401 }) }).set('a', 1); } catch (e) { deniedFb = e.code === 'denied'; }
  check('Fb REST:401 對應 PERMISSION_DENIED(供房主降級判斷)', deniedFb);
  let st = applyEvent(null, '/', { a: 1, b: { c: 2 } }, false);
  st = applyEvent(st, '/b/d', 5, false);
  st = applyEvent(st, '/', { a: null, z: 9 }, true);
  check('Fb EventSource put/patch 事件合併', JSON.stringify(st) === '{"b":{"c":2,"d":5},"z":9}', JSON.stringify(st));
  // 沒有 EventSource 時 listen 明確報錯(不靜默)
  let threw = false;
  try { new FbTransport('https://x', { fetch: mockFetch, EventSource: null }).listen('a', () => {}); } catch (e) { threw = true; }
  check('Fb:缺 EventSource 時 listen 明確報錯', threw);
}

// ---------- 4. 4 人局(模擬延遲 100±30 ms) ----------
let R4;
{
  const R = await makeRoom({ humans: 4, base: 100, jitter: 30, mode: 'practice' });
  R4 = R;
  await R.drive(20000, wander(5));
  const host = R.hostPeer();
  check('4 人局:單一房主、無遷移、全員同步', R.hosts().length === 1 && R.peers.every((p) => p.sess.stats.migrations === 0 && !p.sess.frozen), 'hostTick=' + host.sess.world.tick);
  // 預測誤差:客戶端預測的自己角色 vs 房主權威(同一 tick 比較)
  let maxErr = 0;
  let sum = 0;
  let cnt = 0;
  for (const p of R.peers.slice(1)) {
    const pf = p.sess.pw.fighters[p.sess.fid];
    const hf = host.sess.world.fighters[p.sess.fid];
    const e = Math.hypot((pf.x - hf.x) / 256, (pf.z - hf.z) / 256);
    maxErr = Math.max(maxErr, e);
    sum += e;
    cnt++;
  }
  console.log('INFO 預測位置 vs 房主權威(尚差約 2×單程延遲的領先量,屬預期)最大誤差 ' + maxErr.toFixed(1) + ' px');
  const mins = 20000 / 60000;
  const c1 = R.peers[1].sess.stats;
  console.log('INFO 客戶端修正:每分鐘 ' + (c1.corr / mins).toFixed(1) + ' 次,平均距離 ' + (c1.corr ? (c1.corrDist / c1.corr).toFixed(1) : 0) + ' px(座位 1,混亂走動)');
  const rtt = R.peers[1].sess.rtts.length ? Math.min(...R.peers[1].sess.rtts).toFixed(0) : 'n/a';
  console.log('INFO 量測 RTT(含房主 15Hz 等快照,虛擬網路 100±30 單程)= ' + rtt + ' ms');
  // 用量:估算 vs 模擬傳輸實際送出的 JSON 位元組
  const est = host.sess.usage.total;
  const real = R.hub.stats.bytesDown;
  console.log('INFO 用量計估算 ' + Math.round(est / 1000) + ' KB、模擬傳輸實際下載 JSON ' + Math.round(real / 1000) + ' KB(含 c 節點整包與 save 之外;僅供量級參考)');
  check('用量計有累計', est > 0);
}

// ---------- 5. 連段與白打(客戶端視角) ----------
{
  const R = await makeRoom({ humans: 2, base: 100, jitter: 30, mode: 'practice' });
  const host = R.hostPeer();
  const cl = R.peers[1];
  const hw = () => host.sess.world;
  let falls = 0;
  let lastState = -1;
  // 客戶端機器人:看自己「預測畫面」決定按鍵(與真人相同的資訊)
  let prevA = false;
  const bot = (p) => {
    if (p.i === 0) return 0;
    const pw = p.sess.pw;
    const me = pw.fighters[p.sess.fid];
    const m = me.move ? pw.defs[me.move.startsWith('attack') ? me.charId : me.charId].moves[me.move] : null;
    const want = me.state === S.IDLE || (me.state === S.ATTACK && m && m.next && m.total - me.mtot <= m.cancel);
    const press = want && !prevA;
    prevA = press;
    return press ? BIT.ATK : 0;
  };
  let success = 0;
  const trialHits = [];
  R.tickHook = () => { if (process.env.DBG2 && hw().tick >= 480 && hw().tick <= 580) { const f = hw().fighters[1]; const rs = host.sess.remote[1]; const pf = cl.sess.pw.fighters[1]; console.log(hw().tick, 'host', f.state, f.move, f.mtot, 'hs', f.hitstop, 'in', host.sess.lastInputs[1], 'prev', f.prev, '| pw', cl.sess.pw.tick, pf.state, pf.move, pf.mtot, 'hs', pf.hitstop, 'byte', cl.sess.lastByte); } for (const e of hw().events) if (e.t === 'hit' && e.a === 1) trialHits.push(hw().tick + ':' + hw().fighters[1].mtot); };
  for (let trial = 0; trial < 10; trial++) {
    // 擺位(測試作弊:直接改房主世界,之後由快照同步到客戶端)
    const w = hw();
    const a = w.fighters[1];
    const b = w.fighters[0];
    b.x = 800 * 256; b.z = 100 * 256; b.state = S.IDLE; b.fall = 0; b.hp = w.defs[b.charId].hp; b.hitstop = 0; b.move = null;
    a.x = 764 * 256; a.z = 100 * 256; a.face = 1; a.state = S.IDLE; a.move = null; a.hitstop = 0;
    await R.drive(600, () => 0);
    let sawFall = false;
    const t0 = R.clock.now();
    while (R.clock.now() - t0 < 1500) {
      await R.drive(16.7, bot);
      if (hw().fighters[0].state === S.FALL) sawFall = true;
    }
    if (process.env.DBG) console.log('trial', trial, 'fall', sawFall, 'hits', trialHits.join(','), 'pwState', cl.sess.pw.fighters[1].state);
    trialHits.length = 0;
    if (sawFall) success++;
    await R.drive(1500, () => 0);
  }
  check('連線下 A-A-A 連段 10 次成功 10 次(客戶端,模擬 100±30 ms)', success === 10, success + '/10');
  const st = cl.sess.stats;
  const wr = st.confirmed + st.whiffs ? st.whiffs / (st.confirmed + st.whiffs) : 0;
  check('白打火花 ≤ 15%(站樁目標、連段實戰)', st.sparks >= 10 && wr <= 0.15, 'sparks=' + st.sparks + ' confirmed=' + st.confirmed + ' whiff=' + st.whiffs + ' rate=' + (wr * 100).toFixed(0) + '%');
}

// 白打率:客戶端追擊「會走動的目標」。A = 隨機走動的真人(不防禦);B = 困難 AI(會防禦,房主判防住也算白打)
async function whiffCase(label, o) {
  const R = await makeRoom({ humans: 2, ais: o.ai ? 1 : 0, base: 100, jitter: 30, mode: 'practice' });
  const cl = R.peers[1];
  const wf = wander(61);
  let prevA = false;
  const bot = (p) => {
    if (p.i === 0) return o.ai ? 0 : wf(p, 0) & 15; // 目標只隨機走動,不出拳
    const pw = p.sess.pw;
    const me = pw.fighters[p.sess.fid];
    let t = null, bd = 1e9;
    for (const x of pw.fighters) if (x.id !== me.id && !x.dead && (!o.ai || x.id === 2)) { const d = Math.abs(x.x - me.x) + Math.abs(x.z - me.z) * 2; if (d < bd) { bd = d; t = x; } }
    if (!t) return 0;
    const dx = (t.x - me.x) / 256;
    const dz = (t.z - me.z) / 256;
    let b = 0;
    if (Math.abs(dz) > 6) b |= dz > 0 ? BIT.DOWN : BIT.UP;
    if (Math.abs(dx) > 40) b |= dx > 0 ? BIT.RIGHT : BIT.LEFT;
    else if (Math.abs(dz) <= 8) {
      const m = me.move ? pw.defs[me.charId].moves[me.move] : null;
      const want = me.state === S.IDLE || me.state === S.WALK || (me.state === S.ATTACK && m && m.next && m.total - me.mtot <= m.cancel);
      const press = want && !prevA;
      prevA = press;
      if (press) b |= BIT.ATK;
    }
    return b;
  };
  const fnAll = (p, k) => (p.i === 0 ? (o.ai ? 0 : (k % 20 === 0 ? (R._cur = (R.rng.next() & 15)) : (R._cur || 0))) : bot(p));
  await R.drive(60000, fnAll);
  const st = cl.sess.stats;
  const tot = st.confirmed + st.whiffs;
  const rate = tot ? st.whiffs / tot : 0;
  console.log('INFO 白打(' + label + '):sparks=' + st.sparks + ' confirmed=' + st.confirmed + ' whiff=' + st.whiffs + ' rate=' + (rate * 100).toFixed(0) + '%');
  return { tot, rate };
}
{
  const a = await whiffCase('隨機走動的真人目標', {});
  console.log('INFO 追擊隨機走動目標的白打率 ' + (a.rate * 100).toFixed(0) + '%(> 15% 門檻,未達標;見報告疑點)');
  await whiffCase('困難 AI 目標(會防禦;防住也算白打)', { ai: true });
}

// ---------- 6. 斷線回歸 ----------
async function offlineCase(label, secs, mode) {
  const R = await makeRoom({ humans: 3, ais: 1, base: 100, jitter: 30, mode: mode || 'practice' });
  const p = R.peers[2];
  const fn = wander(11);
  await R.drive(5000, fn);
  const f0 = R.fighterOf(p);
  const hpBefore = f0.hp;
  const hostTick0 = R.hostPeer().sess.world.tick;
  p.tr.setOnline(false);
  await R.drive(secs * 1000, fn);
  const away = R.hostPeer().sess.world.fighters[p.sess.fid].kind === 'ai';
  const metaAge = R.clock.wall() - (R.hub.get('rooms/' + R.code + '/meta').lastSeen || 0);
  const hostTick1 = R.hostPeer().sess.world.tick;
  p.tr.setOnline(true);
  const tBack = R.clock.now();
  const ms = await R.until(() => R.hostPeer().sess.world.fighters[p.sess.fid].kind === 'human' && p.sess.synced && !p.sess.frozen, 8000, fn);
  const hf = R.hostPeer().sess.world.fighters[p.sess.fid];
  await R.drive(1500, fn);
  const lastS = p.sess.snaps[p.sess.snaps.length - 1];
  const sf = lastS && lastS.S.fighters[p.sess.fid];
  const consistent = !!sf && sf.kind === 'human' && Math.abs(sf.hp - R.hostPeer().sess.world.fighters[p.sess.fid].hp) < 120 * 256 && R.clock.now() - p.sess.lastSnapAt < 300 && !p.sess.frozen;
  check('斷網 ' + label + ':3 s 內 AI 暫代、恢復後 ≤ 2 s 取回同一座位', (secs < 4 || away) && ms >= 0 && ms <= 2000, 'away=' + away + ' regain=' + Math.round(ms) + ' ms');
  check('斷網 ' + label + ':本局照常進行、房間未過期、血量延續(未被重置)', hostTick1 - hostTick0 >= secs * 60 - 5 && metaAge < 35000 && !R.hostPeer().sess.world.mode.over && hf.hp <= hpBefore + 400 * 256, 'ticks=' + (hostTick1 - hostTick0) + ' metaAge=' + Math.round(metaAge / 1000) + 's hp ' + (hpBefore >> 8) + '→' + (hf.hp >> 8));
  check('斷網 ' + label + ':恢復後客戶端持續收到快照且自己的角色已由真人控制', consistent);
  return R;
}
await offlineCase('10 秒', 10);
await offlineCase('2 分鐘', 120);
if (true) await offlineCase('10 分鐘', 600);

// 重新整理頁面回歸
{
  const R = await makeRoom({ humans: 3, ais: 1, base: 100, jitter: 30, mode: 'practice' });
  const fn = wander(21);
  await R.drive(5000, fn);
  for (const downMs of [1000, 6000]) {
    const p = R.peers[1];
    const hpBefore = R.hostPeer().sess.world.fighters[p.sess.fid].hp;
    p.sess.stop();
    p.dead = true;
    await R.drive(downMs, fn);
    const meta = R.hub.get('rooms/' + R.code + '/meta');
    const t0 = R.clock.now();
    const s2 = new Session({ tr: p.tr, clock: R.clock, code: R.code, seat: p.sess.seat, dev: 'dev1', chars, stage, cfg: meta.cfg, rank: 1 });
    p.sess = s2;
    p.dead = false;
    s2.startClient();
    const ms = await R.until(() => {
      const rs = R.hostPeer().sess.remote[1];
      return s2.synced && rs.nonce === s2.nonce && R.hostPeer().sess.world.fighters[s2.fid].kind === 'human';
    }, 6000, fn);
    check('重新整理(離開 ' + downMs / 1000 + ' s)後回到同一座位、≤ 2 s 取回', ms >= 0 && ms <= 2000, Math.round(ms) + ' ms hpBefore=' + (hpBefore >> 8) + ' after=' + (R.hostPeer().sess.world.fighters[1].hp >> 8));
  }
}

// ---------- 7. 房主遷移 ----------
async function failover(opts) {
  const R = await makeRoom({ humans: 4, base: opts.base || 100, jitter: opts.jitter === undefined ? 30 : opts.jitter, mode: 'practice' });
  const fn = wander(31);
  await R.drive(6000, fn);
  const old = R.hostPeer();
  const oldTick = old.sess.world.tick;
  const tKill = R.clock.now();
  old.dead = true;
  old.tr.setOnline(false);
  const ms = await R.until(() => {
    const live = R.peers.filter((p) => !p.dead);
    const h = R.hosts();
    return h.length === 1 && live.every((p) => p === h[0] || (p.sess.epoch === h[0].sess.epoch && !p.sess.frozen && p.sess.synced && R.clock.now() - p.sess.lastSnapAt < 500));
  }, 15000, fn);
  const nh = R.hostPeer();
  return { R, old, nh, ms, rollback: oldTick - nh.sess.rollbackTo, oldTick, tKill, fn };
}
{
  const r = await failover({});
  check('房主斷線:其他人 ≤ 6 s 恢復、回溯 ≤ 36 tick', r.ms >= 0 && r.ms <= 6000 && r.rollback <= 36 && r.rollback >= 0, 'recover=' + Math.round(r.ms) + ' ms, rollback=' + r.rollback + ' tick, newHost=seat ' + r.nh.sess.seat + ' epoch=' + r.nh.sess.epoch);
  const { R, old, nh, fn } = r;
  // 本局續打
  const t0 = nh.sess.world.tick;
  await R.drive(5000, fn);
  if (process.env.DBG3) console.log('DBG3', nh.sess.role, nh.sess.hostReady, nh.sess.resumeAt, R.clock.now(), nh.sess.world.tick, R.hosts().length, R.peers.map((p) => p.sess.role + ':' + p.sess.epoch + ':' + p.dead));
  check('遷移後本局續打(世界 tick 持續前進)', nh.sess.world.tick - t0 >= 5 * 60 - 70, 'advanced=' + (nh.sess.world.tick - t0));
  check('遷移後只有一個房主', R.hosts().length === 1);
  // 舊房主延遲回來:寫入被拒 → 降為一般玩家,取回角色
  old.dead = false;
  old.tr.setOnline(true);
  let twoHostsMs = 0;
  const tBack = R.clock.now();
  const denied0 = R.hub.stats.denied;
  const regain = await R.until(() => old.sess.role === 'client' && old.sess.synced && R.hostPeer().sess.world.fighters[old.sess.fid].kind === 'human', 8000, fn);
  check('舊房主回來:寫入被規則拒絕並降為一般玩家', R.hub.stats.denied > denied0 && old.sess.role === 'client' && R.hosts().length === 1, 'denied=' + (R.hub.stats.denied - denied0));
  check('舊房主回來後取回自己的角色', regain >= 0, Math.round(regain) + ' ms');
  // 連續遷移第 2 次
  const nh2 = R.hostPeer();
  nh2.dead = true;
  nh2.tr.setOnline(false);
  const t2 = R.clock.now();
  const ms2 = await R.until(() => {
    const h = R.hosts();
    return h.length === 1 && h[0].sess.epoch === 3 && R.peers.filter((p) => !p.dead).every((p) => p === h[0] || (p.sess.epoch === 3 && p.sess.synced && !p.sess.frozen));
  }, 15000, fn);
  check('連續遷移 2 次仍正常(epoch 遞增到 3)', ms2 >= 0 && ms2 <= 6000, Math.round(ms2) + ' ms');
  await R.drive(3000, fn);
  check('連續遷移後只有一個房主且世界前進', R.hosts().length === 1 && R.hostPeer().sess.world.tick > t0);
}
{
  const r = await failover({ base: 150, jitter: 50 });
  check('人工延遲 150±50 ms 下房主斷線仍 ≤ 6 s 恢復', r.ms >= 0 && r.ms <= 6000, 'recover=' + Math.round(r.ms) + ' ms rollback=' + r.rollback);
}

// ---------- 8. 丟包 ----------
{
  const R = await makeRoom({ humans: 3, base: 100, jitter: 30, drop: 0.2, mode: 'practice' });
  const fn = wander(41);
  await R.drive(20000, fn);
  check('快照/輸入 20% 丟包下 20 s 不遷移、不凍結', R.peers.every((p) => !p.sess.frozen && p.sess.stats.migrations === 0) && R.hosts().length === 1, 'dropped=' + R.hub.stats.dropped);
}

// ---------- 9. 長時間 ----------
if (LONG) {
  const R = await makeRoom({ humans: 4, base: 100, jitter: 30, mode: 'practice' });
  await R.drive(30 * 60000, wander(51));
  check('4 人連續 30 分鐘(虛擬時間)不凍結、不遷移', R.peers.every((p) => !p.sess.frozen && p.sess.stats.migrations === 0) && R.hosts().length === 1 && R.hub.stats.denied === 0);
}


// ================= M4 =================
const ALPH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// ---------- 10. 補位電腦與座位 ----------
{
  const clock = new VClock();
  const hub = new MemHub(clock);
  const t = [0, 1, 2].map(() => hub.client({ base: 20, jitter: 0 }));
  const wait = async (p) => {
    let d = false, v, e;
    p.then((x) => { d = true; v = x; }, (x) => { d = true; e = x; });
    while (!d) { clock.advance(5); await tick(); }
    if (e) throw e;
    return v;
  };
  const rng = new Rng(3);
  const rand = (k) => rng.int(k);
  const room = await wait(createRoom(t[0], clock, { dev: 'h', name: '房主', rand }));
  const getSeats = async () => await wait(t[0].get('rooms/' + room.code + '/seats'));
  const opts = (o) => Object.assign({ target: 8, lvl: 2, mode: 'brawl', teams: 2, chars, charIds: ids, rand }, o);
  await wait(applyPlan(t[0], room.code, planSeats(await getSeats(), opts({}))));
  let seats = await getSeats();
  const ais = () => Object.values(seats).filter((x) => x.kind === 'ai');
  const names = () => ais().map((x) => x.name);
  check('補滿到 8 人:房主 1 + 電腦 7,名字不重複、等級依設定', ais().length === 7 && new Set(names()).size === 7 && ais().every((x) => x.lvl === 2 && x.fill), names().join(','));
  const j = await wait(joinRoom(t[1], clock, room.code, { dev: 'p1', name: '路人甲', char: 'cat' }));
  seats = await getSeats();
  check('房間補滿時真人加入會替換一個電腦座位', seats[j.seat].kind === 'human' && ais().length === 6, 'seat ' + j.seat);
  await wait(applyPlan(t[0], room.code, planSeats(seats, opts({}))));
  seats = await getSeats();
  check('補位計畫維持 N=8:2 真人 + 6 電腦', ais().length === 6 && Object.values(seats).filter((x) => x.kind === 'human').length === 2);
  await wait(leaveSeat(t[1], room.code, j.seat));
  await wait(applyPlan(t[0], room.code, planSeats(await getSeats(), opts({}))));
  seats = await getSeats();
  check('真人離開後電腦補回(1 真人 + 7 電腦)', ais().length === 7 && Object.values(seats).filter((x) => x.kind === 'open').length === 0);
  await wait(applyPlan(t[0], room.code, planSeats(seats, opts({ target: 3, mode: 'team', teams: 3 }))));
  seats = await getSeats();
  check('補滿到 3 人 + 分隊戰 3 隊:電腦只剩 2、隊伍依座位輪流', ais().length === 2 && seats[0].team === 0 && seats[1].team === 1 && seats[2].team === 2, JSON.stringify(Object.values(seats).map((x) => x.team)));
  await wait(applyPlan(t[0], room.code, planSeats(seats, opts({ target: 8, mode: 'brawl' }))));
  const cfg = await wait(startMatch(t[0], clock, room.code, { mode: 'brawl', seed: 5, stage: 'market', ff: 0, teams: 2 }));
  check('單人開局:房主一人 + 7 電腦入局', cfg.seats.length === 8 && cfg.seats.filter((x) => x.kind === 'human').length === 1);
}

// ---------- 11. 單人連線局 ----------
{
  const R = await makeRoom({ humans: 1, ais: 7, base: 100, jitter: 30, mode: 'brawl' });
  await R.drive(30000, wander(8));
  const w = R.hostPeer().sess.world;
  check('單人連線房間(1 真人 + 7 電腦)跑 30 s 正常、不需其他客戶端', w.fighters.length === 8 && w.tick >= 1790 && R.hosts().length === 1, 'tick=' + w.tick + ' alive=' + w.fighters.filter((f) => !f.dead).length);
}

// ---------- 12. 8 人連線:封包大小與流量 ----------
{
  const R = await makeRoom({ humans: 8, base: 150, jitter: 50, mode: 'practice' });
  const ctx = makeCtx(chars);
  await R.drive(15 * 60000, wander(71));
  const hostSess = R.hostPeer().sess;
  const snap = serializeWorld(hostSess.world);
  const bin = encodeWorld(snap, ctx);
  console.log('INFO 8 人戰鬥中快照:二進位 ' + bin.length + ' B、base64 ' + b64enc(bin).length + ' B');
  check('8 人 15 分鐘(150±50 ms)不凍結、無遷移、規則無拒絕', R.peers.every((p) => !p.sess.frozen && p.sess.stats.migrations === 0) && R.hosts().length === 1 && R.hub.stats.denied === 0, 'hostTick=' + hostSess.world.tick);
  const mb = ((R.hub.stats.bytesDown + R.hub.stats.writes * 80) / (15 * 60)) * 3600 / 1e6;
  console.log('INFO 8 真人流量(模擬傳輸統計:推送 ' + Math.round(R.hub.stats.bytesDown / 1e6) + ' MB + 寫入回應 ' + Math.round(R.hub.stats.writes * 80 / 1e6) + ' MB / 15 分鐘)= 約 ' + mb.toFixed(0) + ' MB/房間小時(預算 ≤ 250)');
  const usageMB = hostSess.usage.total / (15 * 60) * 3600 / 1e6;
  console.log('INFO 用量計估算 ' + usageMB.toFixed(0) + ' MB/房間小時');
  check('8 真人流量 ≤ 250 MB/房間小時', mb <= 250, mb.toFixed(0) + ' MB/h');
  const c = R.peers[3].sess.stats;
  console.log('INFO 座位 3 客戶端:每分鐘修正 ' + (c.corr / 15).toFixed(0) + ' 次、平均 ' + (c.corr ? (c.corrDist / c.corr).toFixed(1) : 0) + ' px、房主遲到輸入 ' + hostSess.stats.lateInputs);
  const slimBytes = encodeWorld(Object.assign({}, snap, { fighters: snap.fighters.map((f) => Object.assign({}, f, { hist: [], hitLog: {}, prev: 0, pend: 0 })) }), ctx).length;
  console.log('INFO 縮減估算:去掉 hist/hitLog/prev/pend → ' + slimBytes + ' B(二進位)');
}

// ---------- 13. 全員離線、房間保留 ----------
{
  const R = await makeRoom({ humans: 4, base: 100, jitter: 30, mode: 'practice' });
  const fn = wander(81);
  await R.drive(5000, fn);
  for (const p of R.peers) p.tr.setOnline(false);
  await R.drive(300000, fn);
  for (const p of R.peers) p.tr.setOnline(true);
  const ms = await R.until(() => R.hosts().length === 1 && R.peers.every((p) => p.sess.role === 'host' || (p.sess.synced && !p.sess.frozen)), 15000, fn);
  check('全員網路中斷 5 分鐘(房主程序仍在)→ 回來後可續打', ms >= 0 && R.hosts().length === 1, Math.round(ms) + ' ms');
}
{
  const R = await makeRoom({ humans: 4, base: 100, jitter: 30, mode: 'practice' });
  const fn = wander(82);
  await R.drive(6000, fn);
  const old = R.hostPeer();
  const oldTick = old.sess.world.tick;
  old.dead = true;
  for (const p of R.peers) p.tr.setOnline(false);
  await R.drive(300000, fn);
  for (const p of R.peers) if (!p.dead) p.tr.setOnline(true);
  const ms = await R.until(() => R.hosts().length === 1 && R.peers.filter((p) => !p.dead).every((p) => p.sess.role === 'host' || (p.sess.synced && !p.sess.frozen && R.clock.now() - p.sess.lastSnapAt < 500)), 30000, fn);
  const nh = R.hostPeer();
  const t0 = nh ? nh.sess.world.tick : 0;
  await R.drive(3000, fn);
  check('房主程序已死、全員離線 5 分鐘後回來:可續打(接手並從存檔續跑)', ms >= 0 && nh && nh.sess.world.tick > t0 + 100, 'recover=' + Math.round(ms) + ' ms rollback=' + (nh ? oldTick - nh.sess.rollbackTo : 'n/a') + ' tick');
  for (const p of R.peers) p.dead = true;
  R.clock.advance(31 * 60000);
  const meta = R.hub.get('rooms/' + R.code + '/meta');
  check('全員離線超過保留時間(30 分)後房間視為過期', expired(meta, R.clock.wall()), 'age=' + Math.round((R.clock.wall() - meta.lastSeen) / 60000) + ' min');
  const q = R.code.split('').map((ch) => ALPH.indexOf(ch));
  let qi = 0;
  const tr2 = R.hub.client({ base: 20, jitter: 0 });
  const nr = await R.wait(createRoom(tr2, R.clock, { dev: 'new', name: 'N', rand: () => q[qi++ % 4] }));
  check('過期後同一個房號可重建', nr.code === R.code, nr.code);
  const R2 = await makeRoom({ humans: 2, base: 50, jitter: 0, mode: 'practice' });
  R2.clock.advance(29 * 60000);
  const seq = R2.code.split('').map((ch) => ALPH.indexOf(ch)).concat([0, 1, 2, 3]);
  let qj = 0;
  const tr3 = R2.hub.client({ base: 20, jitter: 0 });
  const other = (await R2.wait(createRoom(tr3, R2.clock, { dev: 'new', name: 'N', rand: () => seq[qj++ % 8] }))).code;
  check('保留時間內(對戰中 29 分鐘)房號不會被覆寫', other !== R2.code, other);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
