// 連線面板:建房 / 加入 / 座位 / 補位電腦 / 開局 / 重新整理後回到同一局。
// 離線單機入口在選單最上方,不需要這個面板;網址留空或連不上時這個面板自動停用。
import { FIREBASE_URL } from '../net/config.js';
import { FbTransport } from '../net/fb.js';
import { RealClock } from '../net/mem.js';
import { createRoom, joinRoom, leaveSeat, setMeta, planSeats, applyPlan, startMatch, SEAT_COUNT } from '../net/lobby.js';
import { Session } from '../net/sync.js';
import { SLOT_COLORS } from '../render/hud.js';

const LS_KEY = 'chaosbrawl-room';

function lsGet(k) {
  try {
    return JSON.parse(localStorage.getItem(k));
  } catch (e) {
    return null;
  }
}
function lsSet(k, v) {
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, JSON.stringify(v));
  } catch (e) { /* 隱私模式 */ }
}

export function setupRoom(root, { chars, stage, charIds, getMode, onSession }) {
  const $ = (s) => root.querySelector(s);
  const note = $('#net-note');
  if (!FIREBASE_URL) {
    note.textContent = '尚未設定 Firebase 網址(js/net/config.js),連線功能停用';
    for (const b of root.querySelectorAll('#online button, #online input')) b.disabled = true;
    return { enabled: false, rejoin: async () => false };
  }
  const clock = new RealClock();
  const tr = new FbTransport(FIREBASE_URL);
  let dev = lsGet('chaosbrawl-dev');
  if (!dev) {
    dev = Math.random().toString(36).slice(2) + Date.now().toString(36);
    lsSet('chaosbrawl-dev', dev);
  }
  const rank = /Mobi|Android|iPhone/.test(navigator.userAgent) ? 2 : 0; // 電腦優先接班(草案 5-6)
  let room = null;
  let unsub = null;
  let started = false;
  let busy = false;
  const rand = (n) => Math.floor(Math.random() * n);

  const fillSel = $('#lb-fill');
  for (let n = 1; n <= SEAT_COUNT; n++) fillSel.append(new Option(String(n), String(n)));
  fillSel.value = '4';

  function startSession(cfg) {
    if (started) return;
    started = true;
    if (unsub) unsub();
    const sess = new Session({ tr, clock, code: room.code, seat: room.seat, dev, chars, stage, cfg, rank });
    lsSet(LS_KEY, { code: room.code, seat: room.seat, dev });
    if (room.host) sess.startHost();
    else sess.startClient();
    onSession(sess);
  }

  // 房主:依設定補滿座位(真人加入會替換電腦、離開會補回)
  async function rebalance(v) {
    if (!room.host || busy) return;
    const m = v.meta || {};
    const plan = planSeats(v.seats, {
      target: m.fill || 1, lvl: m.aiLvl === undefined ? 1 : m.aiLvl, mode: m.mode || 'brawl', teams: m.teams || 2, chars, charIds, rand
    });
    if (!Object.keys(plan).length) return;
    busy = true;
    try {
      await applyPlan(tr, room.code, plan);
    } catch (e) {
      note.textContent = '補位失敗:' + e.message;
    }
    busy = false;
  }

  function render(v) {
    if (!v || !v.seats) return;
    if (v.meta && v.meta.state === 'match' && v.meta.cfg) {
      startSession(v.meta.cfg);
      return;
    }
    const m = v.meta || {};
    if (room.host) {
      rebalance(v);
    } else {
      $('#lb-host').style.display = 'none';
    }
    const el = $('#lb-seats');
    el.innerHTML = '';
    for (let n = 0; n < SEAT_COUNT; n++) {
      const s = v.seats[n] || { kind: 'open' };
      const row = document.createElement('div');
      row.className = 'slot';
      const label = document.createElement('span');
      label.textContent = String(n + 1);
      label.style.color = SLOT_COLORS[(s.team === undefined ? n : s.team) % 8];
      const txt = document.createElement('span');
      txt.style.flex = '1';
      const who = s.kind === 'human' ? (s.name || '玩家') + (n === room.seat ? '(你)' : '') : s.kind === 'ai' ? '電腦 ' + (s.name || '') + (s.char && chars[s.char] ? '(' + chars[s.char].name + ')' : '') : s.kind === 'closed' ? '關閉' : '空位';
      txt.textContent = who + (m.mode === 'team' ? ' · 隊 ' + ((s.team || 0) + 1) : '');
      row.append(label, txt);
      el.append(row);
    }
  }

  function enterLobby() {
    $('#lobby').classList.remove('hide');
    $('#online').open = true;
    $('#lb-code').textContent = room.code;
    $('#btn-go').style.display = room.host ? '' : 'none';
    $('#lb-host').style.display = room.host ? '' : 'none';
    unsub = tr.listen('rooms/' + room.code, render);
  }

  // 房主改設定 → 寫進 meta,listener 收到後自動補位
  const hostCtl = (id, key, parse) => {
    $(id).onchange = () => room && room.host && setMeta(tr, room.code, { [key]: parse($(id).value) }).catch(() => {});
  };
  hostCtl('#lb-fill', 'fill', (x) => parseInt(x, 10));
  hostCtl('#lb-lvl', 'aiLvl', (x) => parseInt(x, 10));
  hostCtl('#lb-teams', 'teams', (x) => parseInt(x, 10));
  hostCtl('#lb-ff', 'ff', (x) => parseInt(x, 10));
  hostCtl('#lb-keep', 'keep', (x) => parseInt(x, 10));
  $('#sel-mode').addEventListener('change', () => room && room.host && !started && setMeta(tr, room.code, { mode: getMode() }).catch(() => {}));

  $('#btn-create').onclick = async () => {
    try {
      const r = await createRoom(tr, clock, { dev, name: '玩家', char: charIds[0], rank, rand });
      room = { code: r.code, seat: r.seat, host: true };
      await setMeta(tr, r.code, { mode: getMode() === 'practice' ? 'brawl' : getMode(), fill: parseInt(fillSel.value, 10) });
      enterLobby();
    } catch (e) {
      note.textContent = '建房失敗:' + e.message;
    }
  };
  $('#btn-join').onclick = async () => {
    const code = $('#in-code').value.trim().toUpperCase();
    try {
      const r = await joinRoom(tr, clock, code, { dev, name: '玩家' + (1 + rand(99)), char: charIds[rand(charIds.length)], rank });
      room = { code, seat: r.seat, host: false };
      enterLobby();
    } catch (e) {
      note.textContent = e.code === 'noroom' ? '找不到房間' : e.code === 'full' ? '房間已滿' : e.code === 'started' ? '對戰已開始' : '加入失敗:' + e.message;
    }
  };
  $('#btn-go').onclick = async () => {
    try {
      const meta = (await tr.get('rooms/' + room.code + '/meta')) || {};
      const cfg = await startMatch(tr, clock, room.code, { mode: meta.mode || 'brawl', seed: 1 + rand(2147483000), stage: 'market', ff: meta.ff || 0, teams: meta.teams || 2 });
      startSession(cfg);
    } catch (e) {
      note.textContent = '開局失敗:' + e.message;
    }
  };
  $('#btn-leave').onclick = async () => {
    if (unsub) unsub();
    $('#lobby').classList.add('hide');
    if (room && !room.host) await leaveSeat(tr, room.code, room.seat).catch(() => {});
    room = null;
    lsSet(LS_KEY, null);
  };

  // 重新整理後回到同一局(草案 5-5):localStorage 有 {房號, 座位, 裝置 id} 且座位的 dev 相符
  async function rejoin() {
    const saved = lsGet(LS_KEY);
    if (!saved || saved.dev !== dev) return false;
    try {
      const meta = await tr.get('rooms/' + saved.code + '/meta');
      const seat = await tr.get('rooms/' + saved.code + '/seats/' + saved.seat);
      if (!meta || meta.state !== 'match' || !meta.cfg || !seat || seat.dev !== dev) {
        lsSet(LS_KEY, null);
        return false;
      }
      room = { code: saved.code, seat: saved.seat, host: false };
      startSession(meta.cfg);
      return true;
    } catch (e) {
      return false; // 沒網路:離線單機照常可玩
    }
  }
  return { enabled: true, rejoin };
}
