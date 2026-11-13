// 房間流程(草案 5-7):建房 4 碼房號、加入、座位、開局;存活時間規則
// M4:8 座位;房主設定「補滿到 N 人」與電腦等級,空座位自動補電腦;真人加入時替換掉一個補位電腦、離開時補回。
const ALPH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const SEAT_COUNT = 8;
const LOBBY_EXPIRE = 5 * 60000;

export function randomCode(rand) {
  let s = '';
  for (let i = 0; i < 4; i++) s += ALPH[rand(ALPH.length)];
  return s;
}

// 過期判定:大廳 / 結算 5 分鐘沒心跳;對戰中 = 房主 lastSeen 超過 keep 分鐘(預設 30)
export function expired(meta, wall) {
  if (!meta) return true;
  const age = wall - (meta.lastSeen || 0);
  if (meta.state === 'match') return age > (meta.keep || 30) * 60000;
  return age > LOBBY_EXPIRE;
}

const teamOf = (n, mode, teams) => (mode === 'team' ? n % Math.max(2, Math.min(4, teams || 2)) : n);

// 建房:先寫房間索引與 meta,再寫 seats(兩步,草案 5-7-5);過期的舊房號直接覆寫
export async function createRoom(tr, clock, { dev, name, char, rank, rand }) {
  for (let i = 0; i < 12; i++) {
    const code = randomCode(rand);
    const meta = await tr.get('rooms/' + code + '/meta');
    if (!expired(meta, clock.wall())) continue;
    await tr.remove('rooms/' + code);
    await tr.set('rooms/' + code + '/meta', { state: 'lobby', lastSeen: clock.wall(), keep: 30, mode: 'brawl', stage: 'market', fill: 1, aiLvl: 1, teams: 2, ff: 0 });
    const seats = {};
    for (let n = 0; n < SEAT_COUNT; n++) {
      seats[n] = n === 0
        ? { dev, name, char: char || 'fanfan', team: n, kind: 'human', lvl: 1, rank: rank || 0 }
        : { kind: 'open', team: n };
    }
    await tr.set('rooms/' + code + '/seats', seats);
    return { code, seat: 0 };
  }
  throw new Error('no free room code');
}

// 加入:先找空座位,滿了就替換一個補位電腦(ETag 條件寫入搶位);對戰中只允許原裝置回到自己的座位
export async function joinRoom(tr, clock, code, { dev, name, char, rank }) {
  const meta = await tr.get('rooms/' + code + '/meta');
  if (!meta || expired(meta, clock.wall())) throw Object.assign(new Error('room not found'), { code: 'noroom' });
  const seats = (await tr.get('rooms/' + code + '/seats')) || {};
  for (let n = 0; n < SEAT_COUNT; n++) {
    if (seats[n] && seats[n].dev === dev && seats[n].kind === 'human') return { seat: n, rejoin: true, meta };
  }
  if (meta.state !== 'lobby') throw Object.assign(new Error('match already started'), { code: 'started' });
  for (const want of ['open', 'fill']) {
    for (let n = 0; n < SEAT_COUNT; n++) {
      const path = 'rooms/' + code + '/seats/' + n;
      const s = seats[n];
      if (!s || (want === 'open' ? s.kind !== 'open' : !(s.kind === 'ai' && s.fill))) continue;
      const r = await tr.getEtag(path);
      if (!r.v || (want === 'open' ? r.v.kind !== 'open' : !(r.v.kind === 'ai' && r.v.fill))) continue;
      const ok = await tr.setIf(path, { dev, name, char: char || 'fanfan', team: n, kind: 'human', lvl: 1, rank: rank || 0 }, r.etag);
      if (ok) return { seat: n, rejoin: false, meta };
    }
  }
  throw Object.assign(new Error('room full'), { code: 'full' });
}

// 真人離開(大廳):座位變回空位,房主下一次 planSeats 會補電腦
export function leaveSeat(tr, code, n) {
  return tr.set('rooms/' + code + '/seats/' + n, { kind: 'open', team: n });
}

export function setSeat(tr, code, n, patch) {
  return tr.update('rooms/' + code + '/seats/' + n, patch);
}

export async function setMeta(tr, code, patch) {
  return tr.update('rooms/' + code + '/meta', patch);
}

function pickNick(chars, charId, used, rand) {
  const pool = (chars[charId] && chars[charId].nicknames) || [chars[charId] ? chars[charId].name : charId];
  const free = pool.filter((x) => !used.has(x));
  if (free.length) return free[rand(free.length)];
  for (let i = 2; i < 99; i++) {
    const cand = pool[0] + i;
    if (!used.has(cand)) return cand;
  }
  return pool[0];
}

// 依目前座位計算補位計畫(純函式,方便測試):回傳 { 座位: 新座位資料 }
// opts: { target 補滿到 N 人, lvl 電腦等級 0~3, mode, teams, chars, charIds, rand }
export function planSeats(seats, opts) {
  const { target, lvl, mode, teams, chars, charIds, rand } = opts;
  const out = {};
  const humans = [];
  const used = new Set();
  for (let n = 0; n < SEAT_COUNT; n++) {
    const s = seats[n];
    if (s && s.kind === 'human') {
      humans.push(n);
      if (s.name) used.add(s.name);
    }
  }
  let need = Math.max(0, Math.min(SEAT_COUNT, target) - humans.length);
  const next = {};
  // 既有補位電腦保留(角色與名字不變),多的清掉
  for (let n = 0; n < SEAT_COUNT; n++) {
    const s = seats[n];
    if (s && s.kind === 'ai' && s.fill) {
      if (need > 0) {
        next[n] = Object.assign({}, s, { lvl });
        used.add(s.name);
        need--;
      } else next[n] = { kind: 'open' };
    }
  }
  for (let n = 0; n < SEAT_COUNT && need > 0; n++) {
    const s = seats[n];
    if (next[n] || (s && (s.kind === 'human' || s.kind === 'closed' || (s.kind === 'ai' && !s.fill)))) continue;
    const ch = charIds[rand(charIds.length)];
    const name = pickNick(chars, ch, used, rand);
    used.add(name);
    next[n] = { kind: 'ai', fill: true, char: ch, name, lvl };
    need--;
  }
  for (let n = 0; n < SEAT_COUNT; n++) {
    const s = seats[n];
    let want = next[n] || s || { kind: 'open' };
    if (!next[n] && s && s.kind === 'ai' && s.fill) want = { kind: 'open' }; // 已處理過,不會到這
    const t = teamOf(n, mode, teams);
    want = Object.assign({}, want, { team: t });
    if (JSON.stringify(want) !== JSON.stringify(s)) out[n] = want;
  }
  return out;
}

export async function applyPlan(tr, code, plan) {
  for (const n in plan) await tr.set('rooms/' + code + '/seats/' + n, plan[n]);
}

// 房主開局:open / closed 的座位不入局;回傳 cfg(寫進 meta.cfg,所有人用同一份建世界)
export async function startMatch(tr, clock, code, { mode, seed, stage, ff, teams }) {
  const seats = (await tr.get('rooms/' + code + '/seats')) || {};
  const list = [];
  for (let n = 0; n < SEAT_COUNT; n++) {
    const s = seats[n];
    if (!s || (s.kind !== 'human' && s.kind !== 'ai')) continue;
    list.push({ seat: n, kind: s.kind, char: s.char, lvl: s.lvl || 1, name: s.name || '', team: teamOf(n, mode, teams) });
  }
  const cfg = { mode: mode || 'brawl', seed, stage: stage || 'market', ff: ff || 0, seats: list };
  await tr.update('rooms/' + code + '/meta', { state: 'match', cfg, lastSeen: clock.wall() });
  return cfg;
}
