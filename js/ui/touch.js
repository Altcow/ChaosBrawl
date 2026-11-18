import { BIT } from '../core/input.js';
import { ULT_MACRO } from '../sim/command.js';

// 觸控:左側動態虛擬搖桿(8 向,死區 25%)+ 攻 / 跳 / 防 + 必殺輔助鍵
// 必殺鈕:點一下展開小面板,列出該角色所有必殺,點選即放(onAssist(cmd),由主程式依面向排入 commandMacro)
// getSpecials() 由主程式提供:回傳 { items: [{ cmd, name, short, cost }], mp } 或 null;MP 不足的招式灰色不可按
// 大招鈕:爆氣滿(100)才亮起,點一下排入 ULT_MACRO;爆氣來源:主程式呼叫 setRage(0~1),沒呼叫時讀 window.__cb.world
const STICK_R = 56;
const DEAD = 0.25;
const RUN_R = 0.8; // 搖桿推到 80% 以上(左右)= 自動跑
const RAGE_FULL = 100 * 256; // 爆氣滿值(sim/ult.js RAGE_MAX = 100 * FX,FX = 256)

export function setupTouch(root, input, onAssist, getSpecials) {
  root.innerHTML = '';
  const zone = el('div', 'zone');
  const hint = el('div', 'stick-hint');
  const base = el('div', 'stick-base');
  const knob = el('div', 'stick-knob');
  root.append(zone, hint, base, knob);

  const btnBits = { atk: 0, jump: 0, def: 0 };
  let stickBits = 0;
  let runArmed = true;
  const emit = () => input.setTouch(stickBits | btnBits.atk | btnBits.jump | btnBits.def);

  // 搖桿
  let sid = null;
  let ox = 0;
  let oy = 0;
  zone.addEventListener('pointerdown', (e) => {
    if (sid !== null) return;
    e.preventDefault();
    sid = e.pointerId;
    capture(zone, sid);
    const r = root.getBoundingClientRect();
    ox = e.clientX - r.left;
    oy = e.clientY - r.top;
    hint.style.display = 'none';
    base.style.cssText = 'display:block;left:' + ox + 'px;top:' + oy + 'px';
    knob.style.cssText = 'display:block;left:' + ox + 'px;top:' + oy + 'px';
    stickBits = 0;
    emit();
  });
  zone.addEventListener('pointermove', (e) => {
    if (e.pointerId !== sid) return;
    e.preventDefault();
    const r = root.getBoundingClientRect();
    let dx = e.clientX - r.left - ox;
    let dy = e.clientY - r.top - oy;
    const mag = Math.hypot(dx, dy);
    if (mag > STICK_R) {
      dx = (dx / mag) * STICK_R;
      dy = (dy / mag) * STICK_R;
    }
    knob.style.left = ox + dx + 'px';
    knob.style.top = oy + dy + 'px';
    stickBits = mag < STICK_R * DEAD ? 0 : dirBits(Math.atan2(dy, dx));
    // 推到最外圈且偏左右 → 送出「連點兩下」的輸入讓角色跑起來;收回內圈再重新武裝
    const horiz = stickBits & (BIT.LEFT | BIT.RIGHT);
    if (mag >= STICK_R * RUN_R && horiz && runArmed) {
      runArmed = false;
      input.queueRun('P1');
    } else if (mag < STICK_R * 0.6) {
      runArmed = true;
    }
    emit();
  });
  const endStick = (e) => {
    if (e.pointerId !== sid) return;
    sid = null;
    stickBits = 0;
    runArmed = true;
    hint.style.display = '';
    base.style.display = 'none';
    knob.style.display = 'none';
    emit();
  };
  zone.addEventListener('pointerup', endStick);
  zone.addEventListener('pointercancel', endStick);
  zone.addEventListener('lostpointercapture', endStick);

  // 按鈕
  addButton('atk', '攻', 'b-atk', BIT.ATK);
  addButton('jump', '跳', 'b-jump', BIT.JUMP);
  addButton('def', '防', 'b-def', BIT.DEF);
  // 必殺技:每招一顆直接按鈕(一點就放,不用先展開面板);MP 不足的灰色
  const spBar = el('div', 'sp-bar');
  root.append(spBar);
  let spBtns = [];
  let spSig = '';
  const spPaint = () => {
    const d = getSpecials && getSpecials();
    if (!d || d.items.length !== spBtns.length) return;
    spBtns.forEach((c, i) => c.classList.toggle('off', d.mp < d.items[i].cost * 256));
  };
  const spBuild = () => {
    const d = getSpecials && getSpecials();
    const sig = d ? d.items.map((it) => it.cmd + it.name).join('|') : '';
    if (sig === spSig) return;
    spSig = sig;
    spBar.innerHTML = '';
    spBtns = [];
    if (!d || !d.items.length) return;
    d.items.forEach((it) => {
      const c = el('div', 'sp-btn');
      const a = el('b', '');
      a.textContent = it.name;
      const b = el('span', '');
      b.textContent = 'MP' + it.cost;
      c.append(a, b);
      c.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (c.classList.contains('off')) return;
        c.classList.add('down');
        if (onAssist) onAssist(it.cmd);
      });
      const up = () => c.classList.remove('down');
      c.addEventListener('pointerup', up);
      c.addEventListener('pointercancel', up);
      c.addEventListener('pointerleave', up);
      spBar.append(c);
      spBtns.push(c);
    });
    spPaint();
  };
  const spClose = () => {};

  // 大招鈕:rageRatio = null(未知,視為可按)/ 0~1
  const ult = el('div', 'btn b-ult');
  ult.textContent = '最強';
  root.append(ult);
  const ultTip = el('div', 'ult-tip');
  ultTip.textContent = '最強必殺技可用!點這裡 ▶';
  root.append(ultTip);
  let rageRatio = null;
  let manualAt = 0;
  const ultReady = () => rageRatio === null || rageRatio >= 1;
  const paintUlt = () => {
    ult.classList.toggle('off', rageRatio !== null && rageRatio < 1);
    ult.classList.toggle('ready', rageRatio !== null && rageRatio >= 1);
    ultTip.classList.toggle('show', rageRatio !== null && rageRatio >= 1);
  };
  ult.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (!ultReady()) return;
    ult.classList.add('down');
    input.queueMacro('P1', ULT_MACRO);
  });
  const ultUp = () => ult.classList.remove('down');
  ult.addEventListener('pointerup', ultUp);
  ult.addEventListener('pointercancel', ultUp);
  ult.addEventListener('lostpointercapture', ultUp);
  paintUlt();

  // 讀爆氣:setRage 優先;否則讀本機單機局(__cb.world)第一個真人角色
  let raf = 0;
  const poll = () => {
    raf = requestAnimationFrame(poll);
    spBuild();
    spPaint();
    if (Date.now() - manualAt < 500) return;
    const w = window.__cb && window.__cb.world;
    let r = null;
    if (w) {
      const f = w.fighters.find((x) => x.kind === 'human');
      if (f) r = w.defs[f.charId].hasUlt ? Math.min(1, (f.rage || 0) / RAGE_FULL) : 0;
    }
    if (r !== rageRatio) {
      rageRatio = r;
      paintUlt();
    }
  };

  function addButton(key, label, cls, bit) {
    const b = el('div', 'btn ' + cls);
    b.textContent = label;
    root.append(b);
    let id = null;
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (id !== null) return;
      id = e.pointerId;
      capture(b, id);
      b.classList.add('down');
      btnBits[key] = bit;
      emit();
    });
    const up = (e) => {
      if (e.pointerId !== id) return;
      id = null;
      b.classList.remove('down');
      btnBits[key] = 0;
      emit();
    };
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
    b.addEventListener('lostpointercapture', up);
  }

  root.addEventListener('contextmenu', (e) => e.preventDefault());
  return {
    show() {
      root.classList.add('show');
      spSig = '';
      spBuild();
      if (!raf) raf = requestAnimationFrame(poll);
    },
    hide() {
      spClose();
      root.classList.remove('show');
      cancelAnimationFrame(raf);
      raf = 0;
    },
    // 主程式可直接餵爆氣比例(0~1);null = 未知
    setRage(ratio) {
      manualAt = Date.now();
      if (ratio !== rageRatio) {
        rageRatio = ratio;
        paintUlt();
      }
    },
    reset() {
      spClose();
      sid = null;
      stickBits = 0;
      btnBits.atk = btnBits.jump = btnBits.def = 0;
      hint.style.display = '';
      base.style.display = 'none';
      knob.style.display = 'none';
      emit();
    }
  };
}

function capture(node, id) {
  try {
    node.setPointerCapture(id);
  } catch (e) { /* 無效的指標 id */ }
}

function el(tag, cls) {
  const e = document.createElement(tag);
  e.className = cls;
  return e;
}

// 角度 → 8 向(畫面 y 向下為正)
function dirBits(ang) {
  const i = (Math.round(ang / (Math.PI / 4)) + 8) % 8;
  return [BIT.RIGHT, BIT.RIGHT | BIT.DOWN, BIT.DOWN, BIT.LEFT | BIT.DOWN, BIT.LEFT, BIT.LEFT | BIT.UP, BIT.UP, BIT.RIGHT | BIT.UP][i];
}
