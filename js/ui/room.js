// 和朋友連線(獨立面板):建房 / 加入 / 座位 / 換角 / 補位電腦 / 房間設定 / 開局 / 重新整理後回到同一局。
// 角色沿用首頁所選;模式等設定放在房間設定,不再借用單機設定。
// 離線單機不需要這個面板;沒設定網址或沒網路時整塊灰掉並寫原因。
import { FIREBASE_URL } from '../net/config.js';
import { FbTransport } from '../net/fb.js';
import { RealClock } from '../net/mem.js';
import { createRoom, joinRoom, leaveSeat, setSeat, setMeta, planSeats, applyPlan, startMatch, SEAT_COUNT } from '../net/lobby.js';
import { Session } from '../net/sync.js';
import { SLOT_COLORS } from '../render/hud.js';
import { seg } from './select.js';

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

export function setupRoom(root, { chars, stage, charIds, getChar, onSession }) {
  const $ = (s) => root.querySelector(s);
  const note = $('#net-note');
  const panel = $('#netpanel');
  const setUsable = (ok, why) => {
    for (const b of panel.querySelectorAll('#net-enter button, #net-enter input')) b.disabled = !ok;
    panel.classList.toggle('off', !ok);
    note.textContent = ok ? '' : why;
  };
  if (!FIREBASE_URL) {
    setUsable(false, '尚未設定 Firebase 網址(js/net/config.js),連線功能停用。單機與練習不受影響。');
    return { enabled: false, rejoin: async () => false, onOpen() { setUsable(false, '尚未設定 Firebase 網址(js/net/config.js),連線功能停用。單機與練習不受影響。'); } };
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
  let lastMeta = {};
  const rand = (n) => Math.floor(Math.random() * n);
  const meta = (patch) => room && room.host && setMeta(tr, room.code, patch).catch(() => {});

  // ---- 房間設定(房主):分段按鈕 ----
  const marks = {};
  marks.mode = seg($('#seg-lbmode'), [['brawl', '大亂鬥'], ['team', '分隊戰'], ['timed', '時間賽']], 'brawl', (v) => meta({ mode: v }));
  marks.fill = seg($('#seg-lbfill'), [1, 2, 3, 4, 5, 6, 7, 8].map((n) => [n, String(n)]), 8, (v) => meta({ fill: v }));
  marks.lvl = seg($('#seg-lblvl'), [[0, '新手'], [1, '普通'], [2, '困難'], [3, '魔王']], 1, (v) => meta({ aiLvl: v }));
  marks.teams = seg($('#seg-lbteams'), [[2, '2'], [3, '3'], [4, '4']], 2, (v) => meta({ teams: v }));
  marks.ff = seg($('#seg-lbff'), [[0, '關'], [1, '部分'], [2, '全開']], 0, (v) => meta({ ff: v }));
  marks.keep = seg($('#seg-lbkeep'), [[10, '10 分'], [30, '30 分'], [60, '60 分']], 30, (v) => meta({ keep: v }));
  $('#btn-room-set').onclick = () => $('#lb-host').classList.toggle('hide');

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

  function renderAvatars(cur) {
    const el = $('#lb-avatars');
    el.innerHTML = '';
    for (const id of charIds) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'avatar sm' + (id === cur ? ' on' : '');
      const face = document.createElement('i');
      face.textContent = ((chars[id].nicknames && chars[id].nicknames[0]) || chars[id].name).slice(0, 1);
      face.style.background = chars[id].color;
      b.append(face);
      b.title = chars[id].name;
      b.onclick = () => setSeat(tr, room.code, room.seat, { char: id }).catch(() => {});
      el.append(b);
    }
  }

  function render(v) {
    if (!v || !v.seats) return;
    if (v.meta && v.meta.state === 'match' && v.meta.cfg) {
      startSession(v.meta.cfg);
      return;
    }
    const m = v.meta || {};
    lastMeta = m;
    if (m.mode) marks.mode(m.mode);
    if (m.fill) marks.fill(m.fill);
    if (m.aiLvl !== undefined) marks.lvl(m.aiLvl);
    if (m.teams) marks.teams(m.teams);
    marks.ff(m.ff || 0);
    if (m.keep) marks.keep(m.keep);
    for (const e of panel.querySelectorAll('.lb-team')) e.style.display = m.mode === 'team' ? '' : 'none';
    if (room.host) rebalance(v);
    const me = v.seats[room.seat];
    renderAvatars(me && me.char);
    const el = $('#lb-seats');
    el.innerHTML = '';
    for (let n = 0; n < SEAT_COUNT; n++) {
      const s = v.seats[n] || { kind: 'open' };
      const cell = document.createElement('div');
      cell.className = 'cell';
      const dot = document.createElement('i');
      dot.style.background = SLOT_COLORS[(s.team === undefined ? n : s.team) % 8];
      const who = s.kind === 'human' ? (n === room.seat ? '你' : s.name || '玩家') : s.kind === 'ai' ? '電腦' : s.kind === 'closed' ? '關閉' : '空位';
      const ch = s.kind !== 'open' && s.char && chars[s.char] ? '(' + ((chars[s.char].nicknames && chars[s.char].nicknames[0]) || chars[s.char].name) + ')' : '';
      cell.append(dot, document.createTextNode((n + 1) + ' ' + who + ch + (m.mode === 'team' ? ' 隊' + ((s.team || 0) + 1) : '')));
      el.append(cell);
    }
  }

  function enterLobby() {
    $('#net-enter').classList.add('hide');
    $('#lobby').classList.remove('hide');
    $('#lb-code').textContent = room.code;
    $('#btn-go').style.display = room.host ? '' : 'none';
    $('#btn-room-set').style.display = room.host ? '' : 'none';
    $('#lb-host').classList.add('hide');
    unsub = tr.listen('rooms/' + room.code, render);
  }

  $('#btn-create').onclick = async () => {
    try {
      const r = await createRoom(tr, clock, { dev, name: '玩家', char: getChar(), rank, rand });
      room = { code: r.code, seat: r.seat, host: true };
      await setMeta(tr, r.code, { mode: 'brawl', fill: 8 });
      enterLobby();
    } catch (e) {
      note.textContent = '建房失敗(沒網路或連線錯誤):' + e.message;
    }
  };
  $('#btn-join').onclick = async () => {
    const code = $('#in-code').value.trim().toUpperCase();
    try {
      const r = await joinRoom(tr, clock, code, { dev, name: '玩家' + (1 + rand(99)), char: getChar(), rank });
      room = { code, seat: r.seat, host: false };
      enterLobby();
    } catch (e) {
      note.textContent = e.code === 'noroom' ? '找不到房間' : e.code === 'full' ? '房間已滿' : e.code === 'started' ? '對戰已開始' : '加入失敗:' + e.message;
    }
  };
  $('#btn-go').onclick = async () => {
    try {
      const m = (await tr.get('rooms/' + room.code + '/meta')) || lastMeta;
      const cfg = await startMatch(tr, clock, room.code, { mode: m.mode || 'brawl', seed: 1 + rand(2147483000), stage: 'market', ff: m.ff || 0, teams: m.teams || 2 });
      startSession(cfg);
    } catch (e) {
      note.textContent = '開局失敗:' + e.message;
    }
  };
  $('#btn-copy').onclick = () => {
    try {
      navigator.clipboard.writeText(room.code);
      note.textContent = '已複製房號 ' + room.code;
    } catch (e) {
      note.textContent = '請手動記下房號 ' + room.code;
    }
  };
  $('#btn-leave').onclick = async () => {
    if (unsub) unsub();
    unsub = null;
    $('#lobby').classList.add('hide');
    $('#net-enter').classList.remove('hide');
    if (room && !room.host) await leaveSeat(tr, room.code, room.seat).catch(() => {});
    room = null;
    started = false;
    lsSet(LS_KEY, null);
  };

  // 重新整理後回到同一局(草案 5-5):localStorage 有 {房號, 座位, 裝置 id} 且座位的 dev 相符
  async function rejoin() {
    const saved = lsGet(LS_KEY);
    if (!saved || saved.dev !== dev) return false;
    try {
      const mt = await tr.get('rooms/' + saved.code + '/meta');
      const seat = await tr.get('rooms/' + saved.code + '/seats/' + saved.seat);
      if (!mt || mt.state !== 'match' || !mt.cfg || !seat || seat.dev !== dev) {
        lsSet(LS_KEY, null);
        return false;
      }
      room = { code: saved.code, seat: saved.seat, host: false };
      startSession(mt.cfg);
      return true;
    } catch (e) {
      return false; // 沒網路:離線單機照常可玩
    }
  }
  return {
    enabled: true,
    rejoin,
    onOpen() {
      setUsable(navigator.onLine !== false, '目前沒有網路,連線功能暫停。單機與練習不受影響。');
    }
  };
}
