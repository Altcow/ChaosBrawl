// 首頁與設定:頭像列 + 大「開始」鈕;次要入口(連線 / 練習 / 更多設定);「自訂每個座位」第二層。
// 設定存 localStorage(記住上次用的);同機 2P / 手把改成「按任一鍵加入」。
const LS = 'chaosbrawl-prefs';
const DEFAULTS = { char: 'fanfan', mode: 'brawl', total: 8, lvl: 1, teams: 2, ff: 0, custom: null };
const MODE_NAME = { brawl: '大亂鬥', team: '分隊戰', timed: '時間賽' };
const KINDS = [
  ['off', '關閉'],
  ['P1', '玩家 P1(鍵盤 WASD/JKL、觸控)'],
  ['P2', '玩家 P2(鍵盤 方向鍵/小鍵盤 1 2 3)'],
  ['G1', '玩家(手把 1)'],
  ['G2', '玩家(手把 2)'],
  ['G3', '玩家(手把 3)'],
  ['G4', '玩家(手把 4)'],
  ['AI0', '電腦 新手'],
  ['AI1', '電腦 普通'],
  ['AI2', '電腦 困難'],
  ['AI3', '電腦 魔王']
];

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(LS));
    return Object.assign({}, DEFAULTS, p || {});
  } catch (e) {
    return Object.assign({}, DEFAULTS);
  }
}
function savePrefs(p) {
  try {
    localStorage.setItem(LS, JSON.stringify(p));
  } catch (e) { /* 隱私模式:不記住也能玩 */ }
}

export function loadChar(charIds) {
  const p = loadPrefs();
  return p.char === 'random' || charIds.indexOf(p.char) >= 0 ? p.char : charIds[0];
}

// 分段按鈕
export function seg(el, options, value, onPick) {
  el.innerHTML = '';
  const btns = [];
  for (const [v, t] of options) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = t;
    b.dataset.v = String(v);
    b.onclick = () => {
      onPick(v);
      mark(v);
    };
    el.append(b);
    btns.push(b);
  }
  const mark = (val) => btns.forEach((b) => b.classList.toggle('on', b.dataset.v === String(val)));
  mark(value);
  return mark;
}

export function setupHome(root, { chars, charIds, onStart, onPractice, onOnline, onMoves }) {
  const $ = (s) => root.querySelector(s);
  const prefs = loadPrefs();
  if (prefs.char !== 'random' && charIds.indexOf(prefs.char) < 0) prefs.char = charIds[0];
  if (prefs.custom) for (const s of prefs.custom) if (!s || charIds.indexOf(s.char) < 0) s.char = charIds[0];
  const rand = (n) => Math.floor(Math.random() * n);
  const joined = []; // 按鍵加入的本機玩家來源:'P2' / 'G1'...
  const marks = {};

  const short = (id) => (chars[id].nicknames && chars[id].nicknames[0]) || chars[id].name;
  const pickChar = () => (prefs.char === 'random' ? charIds[rand(charIds.length)] : prefs.char);

  // ---- 組出開局設定(每次開始重抽隨機角色) ----
  function buildCfg() {
    if (prefs.custom) {
      return { mode: prefs.mode === 'practice' ? 'brawl' : prefs.mode, ff: prefs.ff, slots: prefs.custom.map((s) => Object.assign({}, s)) };
    }
    const slots = [];
    slots.push({ kind: 'P1', char: pickChar(), team: 0 });
    for (const src of joined) slots.push({ kind: src, char: charIds[rand(charIds.length)], team: 0 });
    const total = Math.max(2, prefs.total, slots.length + 1);
    const count = new Array(4).fill(0);
    count[0] = slots.length;
    while (slots.length < total) {
      let t = 0;
      for (let i = 1; i < Math.max(2, prefs.teams); i++) if (count[i] < count[t]) t = i;
      count[t]++;
      slots.push({ kind: 'AI' + prefs.lvl, char: charIds[rand(charIds.length)], team: t });
    }
    while (slots.length < 8) slots.push({ kind: 'off', char: 'fanfan', team: 0 });
    return { mode: prefs.mode, ff: prefs.ff, slots };
  }

  const startLabel = () => {
    if (prefs.custom) return '開始(自訂 ' + prefs.custom.filter((s) => s.kind !== 'off').length + ' 人)';
    return '開始(' + MODE_NAME[prefs.mode] + ' ' + Math.max(2, prefs.total, joined.length + 2) + ' 人)';
  };

  // ---- 畫面切換 ----
  function showScreen(name) {
    for (const s of root.querySelectorAll('.screen')) s.classList.toggle('hide', s.id !== name);
    if (name === 'home') refresh();
  }

  // ---- 頭像列 ----
  // 戰鬥角色圖(atlas 的 idle_0),非同步載入;失敗或無 art 保留彩色圓圈
  const picCache = new Map();
  function loadPic(id) {
    if (picCache.has(id)) return picCache.get(id);
    const art = chars[id].art;
    const p = (async () => {
      if (!art || !art.atlas) return null;
      const aUrl = new URL('data/' + art.atlas, document.baseURI).href;
      const atlas = await (await fetch(aUrl)).json();
      const fr = atlas.frames && atlas.frames.idle_0;
      if (!fr) return null;
      const img = new Image();
      await new Promise((ok, no) => {
        img.onload = ok;
        img.onerror = no;
        img.src = new URL(atlas.image || 'atlas.png', aUrl).href;
      });
      return { img, fr, k: (art.scale || 0.72) * 0.8 };
    })().catch(() => null);
    picCache.set(id, p);
    return p;
  }
  function drawPic(pic) {
    const c = document.createElement('canvas');
    c.className = 'pic';
    c.width = 64;
    c.height = 64;
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    const { img, fr, k } = pic;
    // 腳底對齊畫布底、水平以錨點置中;各角色同一倍率
    g.drawImage(img, fr.x, fr.y, fr.w, fr.h, 32 - fr.ax * k, 62 - fr.ay * k, fr.w * k, fr.h * k);
    return c;
  }
  function renderAvatars() {
    const el = $('#avatars');
    el.innerHTML = '';
    for (const id of charIds.concat(['random'])) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'avatar' + (prefs.char === id ? ' on' : '');
      const face = document.createElement('i');
      face.textContent = id === 'random' ? '?' : short(id).slice(0, 1);
      face.style.background = id === 'random' ? '#555a6a' : chars[id].color;
      const name = document.createElement('span');
      name.textContent = id === 'random' ? '隨機' : short(id);
      b.append(face, name);
      if (id !== 'random') loadPic(id).then((pic) => { if (pic && face.parentNode) face.replaceWith(drawPic(pic)); });
      b.onclick = () => {
        prefs.char = id;
        savePrefs(prefs);
        renderAvatars();
        onCharChange && onCharChange(id);
      };
      el.append(b);
    }
  }
  let onCharChange = null;

  function refresh() {
    renderAvatars();
    $('#btn-start').textContent = startLabel();
    $('#custom-note').textContent = prefs.custom ? '(使用中:自訂座位)' : '';
    $('#team-opts').style.display = prefs.mode === 'team' ? '' : 'none';
    $('#join-hint').textContent = joined.length ? joined.map((s, i) => 'P' + (i + 2) + ' 已加入(' + (s === 'P2' ? '鍵盤' : '手把 ' + s.slice(1)) + ')').join('、') + '(點這裡清除)' : '2P:按手把任一鍵 / 鍵盤小鍵盤 1 加入';
  }

  // ---- 更多設定 ----
  const set = (k, v) => {
    prefs[k] = v;
    savePrefs(prefs);
    $('#team-opts').style.display = prefs.mode === 'team' ? '' : 'none';
  };
  seg($('#seg-mode'), [['brawl', '大亂鬥'], ['team', '分隊戰'], ['timed', '時間賽']], prefs.mode, (v) => set('mode', v));
  seg($('#seg-total'), [2, 3, 4, 5, 6, 7, 8].map((n) => [n, String(n)]), prefs.total, (v) => set('total', v));
  seg($('#seg-lvl'), [[0, '新手'], [1, '普通'], [2, '困難']], prefs.lvl, (v) => set('lvl', v));
  seg($('#seg-teams'), [[2, '2'], [3, '3'], [4, '4']], prefs.teams, (v) => set('teams', v));
  seg($('#seg-ff'), [[0, '關'], [1, '部分'], [2, '全開']], prefs.ff, (v) => set('ff', v));

  // ---- 自訂每個座位(第二層,沿用原本的 8 列座位表) ----
  const slotsEl = $('#slots');
  const rows = [];
  for (let i = 0; i < 8; i++) {
    const row = document.createElement('div');
    row.className = 'slot';
    const label = document.createElement('span');
    label.textContent = String(i + 1);
    const kind = document.createElement('select');
    for (const [v, t] of KINDS) kind.append(new Option(t, v));
    const ch = document.createElement('select');
    for (const id of charIds) ch.append(new Option(chars[id].name, id));
    const team = document.createElement('select');
    team.className = 'team';
    for (let t = 1; t <= 4; t++) team.append(new Option('隊 ' + t, String(t - 1)));
    row.append(label, kind, ch, team);
    slotsEl.append(row);
    rows.push({ kind, ch, team });
    for (const c of [kind, ch, team]) c.addEventListener('change', collectCustom);
  }
  function fillSeatRows() {
    const cfg = prefs.custom ? { slots: prefs.custom } : buildCfg();
    rows.forEach((r, i) => {
      const s = cfg.slots[i];
      r.kind.value = s.kind;
      r.ch.value = s.char;
      r.team.value = String(s.team || 0);
      r.team.style.display = prefs.mode === 'team' ? '' : 'none';
    });
  }
  function collectCustom() {
    prefs.custom = rows.map((r) => ({ kind: r.kind.value, char: r.ch.value, team: parseInt(r.team.value, 10) }));
    savePrefs(prefs);
  }

  // ---- 按鈕 ----
  $('#btn-start').onclick = () => onStart(buildCfg());
  $('#btn-practice').onclick = () => onPractice({ mode: 'practice', ff: 0, slots: [{ kind: 'P1', char: pickChar(), team: 0 }] });
  $('#btn-online').onclick = () => onOnline();
  $('#btn-moves-home').onclick = () => onMoves && onMoves();
  $('#btn-more').onclick = () => showScreen('more');
  $('#btn-more-done').onclick = () => showScreen('home');
  $('#btn-seats').onclick = () => {
    fillSeatRows();
    showScreen('seats');
  };
  $('#btn-seats-done').onclick = () => showScreen('more');
  $('#btn-seats-reset').onclick = () => {
    prefs.custom = null;
    savePrefs(prefs);
    fillSeatRows();
    refresh();
  };
  $('#btn-help').onclick = () => showScreen('help');
  $('#btn-help-done').onclick = () => showScreen('home');
  $('#btn-about').onclick = () => showScreen('about');
  $('#btn-about-done').onclick = () => showScreen('home');
  $('#join-hint').onclick = () => {
    joined.length = 0;
    refresh();
  };

  // ---- 同機 2P / 手把:按任一鍵加入 ----
  const homeVisible = () => !root.classList.contains('hide') && !$('#home').classList.contains('hide');
  const join = (src) => {
    if (joined.indexOf(src) >= 0 || joined.length >= 3) return;
    joined.push(src);
    refresh();
  };
  window.addEventListener('keydown', (e) => {
    if (!homeVisible()) return;
    if (e.code === 'Numpad1' || e.code === 'Numpad2' || e.code === 'Numpad3') join('P2');
  });
  setInterval(() => {
    if (!homeVisible() || !navigator.getGamepads) return;
    let k = 0;
    for (const gp of navigator.getGamepads()) {
      if (!gp || !gp.connected) continue;
      k++;
      if (gp.buttons.some((b) => b.pressed)) join('G' + k);
    }
  }, 150);

  refresh();
  return {
    getCfg: buildCfg,
    getChar: pickChar,
    getPrefChar: () => prefs.char,
    setCharListener: (fn) => { onCharChange = fn; },
    showScreen,
    refresh,
    show() { root.classList.remove('hide'); showScreen('home'); },
    hide() { root.classList.add('hide'); }
  };
}
