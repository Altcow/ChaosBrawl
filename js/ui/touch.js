import { BIT } from '../core/input.js';

// 觸控:左側動態虛擬搖桿(8 向,死區 25%)+ 攻 / 跳 / 防 + 必殺輔助鍵
// 必殺輔助鍵:點一下 → 呼叫 onAssist(),由主程式依面向自動放出該角色第一招必殺
const STICK_R = 56;
const DEAD = 0.25;

export function setupTouch(root, input, onAssist) {
  root.innerHTML = '';
  const zone = el('div', 'zone');
  const base = el('div', 'stick-base');
  const knob = el('div', 'stick-knob');
  root.append(zone, base, knob);

  const btnBits = { atk: 0, jump: 0, def: 0 };
  let stickBits = 0;
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
    emit();
  });
  const endStick = (e) => {
    if (e.pointerId !== sid) return;
    sid = null;
    stickBits = 0;
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
  const sp = el('div', 'btn b-sp');
  sp.textContent = '必殺';
  root.append(sp);
  sp.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    sp.classList.add('down');
    if (onAssist) onAssist();
  });
  const spUp = () => sp.classList.remove('down');
  sp.addEventListener('pointerup', spUp);
  sp.addEventListener('pointercancel', spUp);

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
    show() { root.classList.add('show'); },
    hide() { root.classList.remove('show'); },
    reset() {
      sid = null;
      stickBits = 0;
      btnBits.atk = btnBits.jump = btnBits.def = 0;
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
