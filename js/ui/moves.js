// 招式表面板:列出角色的普攻連段、必殺(名稱 + 指令 + 說明)、大招(名稱 + 說明 + 發動條件)與爆氣累積方式。
// 資料來自 data/chars/*.json 的 info 欄位(顯示用);指令依輸入裝置顯示。手機('touch')顯示手勢動畫(需要 gd = data/gestures.json)。
import { buildSet, seqSym } from './gesture.js';
import { gestureSvg, seqText } from './guide.js';

const DEVICES = ['kb', 'p2', 'pad', 'touch'];
const DEV_NAME = { kb: '鍵盤', p2: '鍵盤 P2', pad: '手把', touch: '手機' };

// 各裝置的按鍵標示
const KEYS = {
  kb: { def: '防(L)', atk: '攻(J)', jump: '技(K)', up: '↑(W)', down: '↓(S)', fwd: '→', ult: '鍵盤 U' },
  p2: { def: '防(小鍵盤 3)', atk: '攻(小鍵盤 1)', jump: '技(小鍵盤 2)', up: '↑', down: '↓', fwd: '→', ult: '小鍵盤 4' },
  pad: { def: '防(B)', atk: '攻(X)', jump: '技(A)', up: '↑', down: '↓', fwd: '→', ult: '手把 Y' },
  touch: { def: '防', atk: '攻', jump: '技', up: '↑', down: '↓', fwd: '→', ult: '手勢圈' }
};
const SHORT = { def: '防', atk: '攻', jump: '技', up: '↑', down: '↓', fwd: '→' };
// 月步(取消跳躍後的移動)說明;鍵位依 docs/引擎介面.md 1-2
const STEP_KEYS = {
  kb: 'E 前衝、Q 後滑、R / F 縱步上 / 下(或 K 單按 = 前衝、K + 後 / 上 / 下);耗 HUD 青色「步力條」,不吃 MP',
  p2: '小鍵盤 6 前衝、5 後滑、8 / 9 縱步上 / 下(或 2 單按 = 前衝);耗步力條',
  pad: 'A 單按 = 前衝;A + 搖桿往後 = 後滑;A + 搖桿上 / 下 = 縱步;耗步力條',
  touch: '手勢圈畫一筆:→ 前衝、← 後滑、↑ ↓ 縱步(面向左時左右相反)'
};

export const RAGE_HELP = '出招命中:造成傷害每 10 點 +2;被打:受到傷害每 10 點 +3、被擊倒 +5(防禦擋下的不算);最強必殺技命中不加。每局從 0 開始,時間賽復活保留一半。';
export const ULT_COND = '爆氣條滿(100)、人在地面且站 / 走 / 跑 / 防的時候才能發動;受擊、倒地、空中、被封招時不行。';

// 'sp_fwd_atk' → ['fwd', 'atk'] 的顯示文字。short = 只用簡寫(防+→+攻)
export function cmdText(cmd, dev, short) {
  const p = cmd.split('_');
  const k = short ? SHORT : KEYS[dev] || KEYS.kb;
  return [k.def || SHORT.def, k[p[1]], k[p[2]]].join('+');
}

export function ultKeyText(dev) {
  const k = KEYS[dev] || KEYS.kb;
  if (dev === 'touch') return '在右下手勢圈畫最強必殺技的手勢(爆氣滿了,圈外框會亮金光)';
  return k.def + '+' + k.atk + '+' + k.jump + ' 同時按,或單按 ' + k.ult;
}

// 普攻連段數:attack1 → next → ...
function chainLen(j) {
  let n = 0;
  let name = 'attack1';
  const seen = {};
  while (name && j.moves[name] && !seen[name]) {
    seen[name] = 1;
    n++;
    name = j.moves[name].next;
  }
  return n;
}

export function listMoves(j) {
  const info = j.info || { moves: {}, ult: null };
  const out = [];
  for (const cmd in info.moves) {
    const m = j.moves[cmd];
    out.push({ cmd, name: info.moves[cmd].name, desc: info.moves[cmd].desc, cost: m ? m.cost || 0 : 0 });
  }
  return out;
}

export function defaultDevice(srcKind, hasTouch) {
  if (hasTouch) return 'touch';
  if (srcKind === 'P2') return 'p2';
  if (srcKind && srcKind[0] === 'G') return 'pad';
  return 'kb';
}

export function setupMoves(root, { chars, charIds, onToggle, gd, onGuide }) {
  const $ = (s) => root.querySelector(s);
  const tabs = $('#mv-tabs');
  const body = $('#mv-body');
  let cur = charIds[0];
  let dev = 'kb';

  const h = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };

  function render() {
    const j = chars[cur];
    const k = KEYS[dev];
    $('#mv-title').textContent = j.name + ' 的招式表';
    $('#mv-dev').textContent = '顯示:' + DEV_NAME[dev];
    for (const b of tabs.children) b.classList.toggle('on', b.dataset.id === cur);
    body.innerHTML = '';
    body.scrollTop = 0;
    const left = h('div', 'mv-col');
    const right = h('div', 'mv-col');
    body.append(left, right);

    // 普攻
    left.append(h('h3', null, '普通攻擊'));
    const n = chainLen(j);
    const basic = h('ul');
    for (const t of [
      '連按 ' + k.atk + ' 打出 ' + n + ' 段連段,最後一下把對手擊倒(傷害低,用來牽制與補刀)',
      '跑步中按 ' + k.atk + ':衝刺攻擊',
      k.def + ':按住擋住正面攻擊(擦傷不致死)',
      '月步:' + STEP_KEYS[dev]
    ]) basic.append(h('li', null, t));
    left.append(basic);

    // 必殺
    left.append(h('h3', null, '必殺技(吃 MP,MP 上限 ' + j.mp + ',會自動回復)'));
    const list = h('div', 'mv-list');
    const gset = dev === 'touch' && gd ? buildSet(j, gd) : null;
    for (const m of listMoves(j)) {
      const row = h('div', 'mv-row');
      const top = h('div', 'mv-top');
      top.append(h('b', null, m.name), h('span', 'mv-cost', 'MP ' + m.cost));
      row.append(top);
      const gi = gset && gset.find((x) => x.id === m.cmd);
      if (gi) {
        const gw = h('div', 'mv-gest');
        const sw = h('div', 'gd-svg');
        sw.append(gestureSvg(gi.seq));
        const tx = h('div');
        tx.append(h('div', 'mv-cmd', '手勢圈畫:' + seqSym(gi.seq)), h('div', 'mv-desc', seqText(gi.seq)), h('div', 'mv-desc', m.desc));
        gw.append(sw, tx);
        row.append(gw);
      } else {
        row.append(h('div', 'mv-cmd', cmdText(m.cmd, dev)));
        row.append(h('div', 'mv-desc', m.desc));
      }
      list.append(row);
    }
    left.append(list);
    if (dev !== 'touch') left.append(h('div', 'mv-note', '→ 指面對的方向(面右按 D、面左按 A;P2 為 → / ←)。防、方向、攻 / 技 在 0.25 秒內按完即可,順序不拘。'));
    else left.append(h('div', 'mv-note', '一筆畫完、放開才出招;弧形要畫夠半圓。MP 不夠會變灰並震動。更多說明看「手勢書」。'));

    // 大招
    right.append(h('h3', null, '最強必殺技'));
    const u = j.info && j.info.ult;
    const ur = h('div', 'mv-row mv-ult');
    ur.append(h('div', 'mv-top', ''));
    ur.firstChild.append(h('b', null, u ? u.name : '(無)'), h('span', 'mv-cost', '爆氣 100'));
    const ugi = dev === 'touch' && gd ? buildSet(j, gd).find((x) => x.id === 'ultimate') : null;
    if (ugi) {
      const gw = h('div', 'mv-gest');
      const sw = h('div', 'gd-svg');
      sw.append(gestureSvg(ugi.seq));
      const tx = h('div');
      tx.append(h('div', 'mv-cmd', '手勢圈畫:' + seqSym(ugi.seq)), h('div', 'mv-desc', seqText(ugi.seq)));
      gw.append(sw, tx);
      ur.append(gw);
    } else ur.append(h('div', 'mv-cmd', ultKeyText(dev)));
    if (u) ur.append(h('div', 'mv-desc', u.desc));
    ur.append(h('div', 'mv-desc', '發動條件:' + ULT_COND));
    right.append(ur);

    right.append(h('h3', null, '爆氣條怎麼累積'));
    right.append(h('div', 'mv-desc', 'HUD 上的金色細條(標示「爆氣」)就是爆氣條,與 MP 分開。'));
    right.append(h('div', 'mv-desc', RAGE_HELP));
    if (j.info && j.info.note) {
      right.append(h('h3', null, '特色'));
      right.append(h('div', 'mv-desc', j.info.note));
    }
  }

  function buildTabs() {
    tabs.innerHTML = '';
    for (const id of charIds) {
      const b = h('button', null, (chars[id].nicknames && chars[id].nicknames[0]) || chars[id].name);
      b.type = 'button';
      b.dataset.id = id;
      b.onclick = () => {
        cur = id;
        render();
      };
      tabs.append(b);
    }
  }
  buildTabs();

  const api = {
    open(charId, device) {
      cur = chars[charId] ? charId : charIds[0];
      dev = DEVICES.indexOf(device) >= 0 ? device : 'kb';
      root.classList.remove('hide');
      render();
      onToggle && onToggle(true);
    },
    close() {
      if (root.classList.contains('hide')) return;
      root.classList.add('hide');
      onToggle && onToggle(false);
    },
    isOpen: () => !root.classList.contains('hide')
  };
  $('#mv-close').onclick = () => api.close();
  $('#mv-guide').onclick = () => onGuide && onGuide(cur);
  $('#mv-dev').onclick = () => {
    dev = DEVICES[(DEVICES.indexOf(dev) + 1) % DEVICES.length];
    render();
  };
  root.addEventListener('keydown', (e) => {
    if (e.code === 'Escape') api.close();
  });
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Escape' && api.isOpen()) api.close();
  });
  return api;
}
