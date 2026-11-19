import { BIT } from '../core/input.js';
import { recognize, PARAMS, templatePath, fitTemplate } from './gesture.js';

// 觸控(手勢版,見 docs/手機滑動出招設計.md 第 6 節):
//   左:動態搖桿(8 向、死區 25%、推到最外圈自動跑)
//   右下:手勢圈(直徑 150,判定 170)= 只畫手勢,點一下沒反應;外圍 4 個小抄圖示;爆氣滿時外框金光
//   手勢圈左:普攻小鈕(58)按住 / 連點 = 普攻連段;防(64)按住防
//   新手輔助按鈕(單機 / 練習場、設定開啟才有):每招一顆 + 最強鈕
// 回呼(ext):
//   getCtx()      → { set, face, mp, ready, canUlt } 目前本機角色的手勢表與狀態;沒有角色時回傳 null
//   onGesture(res)→ { kind: 'ok'|'nomp'|'norage'|'fail'|'late'|'none', text } 由主程式執行招式並回報要顯示的回饋
//   fire(id)      → 同上(輔助按鈕直接指定招式 id)
//   getTemplate() → { seq, loop } | null  訓練 / 教學要顯示的範本軌跡
//   assist()      → 是否顯示輔助按鈕
//   ringOn()      → 是否顯示小抄環
//   onEvent(type) → 'stick' | 'atk'(教學偵測用)
// getSpecials() 由主程式提供:{ items: [{ cmd, name, short, cost }], mp } 或 null(輔助按鈕用)
const STICK_R = 56;
const DEAD = 0.25;
const RUN_R = 0.8; // 搖桿推到 80% 以上(左右)= 自動跑
const RAGE_FULL = 100 * 256; // 爆氣滿值(sim/ult.js RAGE_MAX = 100 * FX,FX = 256)
const PAD_D = 150;
const FADE = 320; // 軌跡淡出 ms
const LABEL_MS = 700;
const COLORS = { ok: '#ffd23a', nomp: '#9aa0aa', norage: '#9aa0aa', late: '#9aa0aa', fail: '#ff5a50', draw: '#ffffff' };

export function setupTouch(root, input, onAssist, getSpecials, ext) {
  ext = ext || {};
  root.innerHTML = '';
  const zone = el('div', 'zone');
  const hint = el('div', 'stick-hint');
  const base = el('div', 'stick-base');
  const knob = el('div', 'stick-knob');
  const cv = el('canvas', 'g-canvas');
  root.append(zone, hint, base, knob, cv);

  const btnBits = { atk: 0, def: 0 };
  let stickBits = 0;
  let runArmed = true;
  const emit = () => input.setTouch(stickBits | btnBits.atk | btnBits.def);

  // ---- 搖桿 ----
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
    if (stickBits && ext.onEvent) ext.onEvent('stick');
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

  // ---- 普攻 / 防 ----
  addButton('atk', '攻', 'b-atk', BIT.ATK);
  addButton('def', '防', 'b-def', BIT.DEF);

  // ---- 手勢圈 ----
  const pad = el('div', 'g-pad');
  const disc = el('div', 'g-disc');
  const discTxt = el('span', '');
  discTxt.textContent = '手勢';
  disc.append(discTxt);
  pad.append(disc);
  const ring = el('div', 'g-ring');
  root.append(pad, ring);
  let ringSig = '';
  let ringIcons = [];

  let gid = null;
  let pts = [];
  let gface = 1;
  let down = 0;
  let trail = null; // { pts, kind, end }
  let label = null; // { text, kind, until }
  let tapHints = 0;
  let dirty = true;

  const padCenter = () => {
    const r = root.getBoundingClientRect();
    const p = pad.getBoundingClientRect();
    return { x: p.left + p.width / 2 - r.left, y: p.top + p.height / 2 - r.top, r0: r.left, t0: r.top };
  };

  function addPoint(e) {
    const t = e.timeStamp;
    const list = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
    if (list && list.length) for (const c of list) pts.push({ x: c.clientX, y: c.clientY, t: c.timeStamp || t });
    else pts.push({ x: e.clientX, y: e.clientY, t });
    if (pts.length > 1200) pts.splice(1, 200);
  }
  pad.addEventListener('pointerdown', (e) => {
    if (gid !== null) return;
    e.preventDefault();
    gid = e.pointerId;
    capture(pad, gid);
    const c = ext.getCtx && ext.getCtx();
    gface = c && c.face < 0 ? -1 : 1;
    pts = [];
    down = performance.now();
    addPoint(e);
    trail = { pts, kind: 'draw', end: 0 };
    dirty = true;
  });
  pad.addEventListener('pointermove', (e) => {
    if (e.pointerId !== gid) return;
    e.preventDefault();
    addPoint(e);
  });
  const endPad = (e, cancel) => {
    if (e.pointerId !== gid) return;
    gid = null;
    if (cancel || !pts.length) {
      trail = null;
      dirty = true;
      return;
    }
    if (!cancel) {
      pts.push({ x: e.clientX, y: e.clientY, t: e.timeStamp });
    }
    finish(pts, gface);
  };
  pad.addEventListener('pointerup', (e) => endPad(e, false));
  pad.addEventListener('pointercancel', (e) => endPad(e, true));
  pad.addEventListener('lostpointercapture', (e) => endPad(e, true));

  // 辨識並回報;pointsIn 為一筆軌跡。測試也可以直接呼叫 feed()
  function finish(list, face) {
    const c = ext.getCtx && ext.getCtx();
    const set = c ? c.set : [];
    const res = recognize(list, face, set);
    let fb = { kind: res.ok ? 'ok' : 'fail', text: '' };
    if (res.reason === 'tap') {
      // 點一下:沒反應,前幾次提示一下
      fb = { kind: 'none', text: '' };
      if (tapHints < 3 && ext.tapHint !== false) {
        tapHints++;
        flash('普攻在左邊小鈕', 'late');
      }
      trail = null;
      dirty = true;
      if (ext.onGesture) ext.onGesture(res, list);
      return res;
    }
    if (ext.onGesture) fb = ext.onGesture(res, list) || fb;
    applyFeedback(fb);
    trail = { pts: list.slice(), kind: fb.kind === 'none' ? 'fail' : fb.kind, end: performance.now(), face };
    dirty = true;
    return res;
  }
  function applyFeedback(fb) {
    if (!fb || fb.kind === 'none') return;
    if (fb.text) flash(fb.text, fb.kind);
    vib(fb.kind);
  }
  function flash(text, kind) {
    label = { text, kind, until: performance.now() + LABEL_MS };
    dirty = true;
  }
  function vib(kind) {
    try {
      if (!navigator.vibrate) return;
      if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return; // 還沒點過畫面,瀏覽器會擋(紅字警告)
      if (kind === 'ok') navigator.vibrate(12);
      else if (kind === 'nomp' || kind === 'norage') navigator.vibrate([30, 40, 30]);
    } catch (e) { /* 不支援 */ }
  }

  // ---- 輔助按鈕(單機 / 練習場,設定開啟才出現)----
  const asBar = el('div', 'sp-bar');
  const ult = el('div', 'btn b-ult');
  ult.textContent = '最強';
  root.append(asBar, ult);
  let spBtns = [];
  let spSig = '';
  const assistOn = () => !!(ext.assist && ext.assist());
  const spPaint = () => {
    const d = getSpecials && getSpecials();
    if (!d || d.items.length !== spBtns.length) return;
    spBtns.forEach((c, i) => c.classList.toggle('off', d.mp < d.items[i].cost * 256));
  };
  const spBuild = () => {
    const on = assistOn();
    const d = on && getSpecials ? getSpecials() : null;
    const sig = d ? d.items.map((it) => it.cmd + it.name).join('|') : '';
    asBar.style.display = on ? '' : 'none';
    ult.style.display = on ? '' : 'none';
    if (sig === spSig) return;
    spSig = sig;
    asBar.innerHTML = '';
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
        const fb = ext.fire ? ext.fire(it.cmd) : (onAssist && onAssist(it.cmd), null);
        applyFeedback(fb);
      });
      const up = () => c.classList.remove('down');
      c.addEventListener('pointerup', up);
      c.addEventListener('pointercancel', up);
      c.addEventListener('pointerleave', up);
      asBar.append(c);
      spBtns.push(c);
    });
    spPaint();
  };
  let rageRatio = null;
  let manualAt = 0;
  ult.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (ult.classList.contains('off')) return;
    ult.classList.add('down');
    applyFeedback(ext.fire ? ext.fire('ultimate') : null);
  });
  const ultUp = () => ult.classList.remove('down');
  ult.addEventListener('pointerup', ultUp);
  ult.addEventListener('pointercancel', ultUp);
  ult.addEventListener('lostpointercapture', ultUp);
  const paintRage = () => {
    ult.classList.toggle('off', rageRatio !== null && rageRatio < 1);
    ult.classList.toggle('ready', rageRatio !== null && rageRatio >= 1);
    disc.classList.toggle('ready', rageRatio !== null && rageRatio >= 1);
  };
  paintRage();

  // ---- 小抄環 ----
  function buildRing(c) {
    const set = c ? c.set.filter((g) => g.kind === 'sp' || g.kind === 'ult') : [];
    const sig = set.map((g) => g.id + g.seq.join('')).join('|');
    if (sig === ringSig) return;
    ringSig = sig;
    ring.innerHTML = '';
    ringIcons = [];
    set.forEach((g, i) => {
      const n = set.length;
      const ang = ((-125 + (i * 85) / Math.max(1, n - 1)) * Math.PI) / 180;
      const d = el('div', 'g-icon' + (g.kind === 'ult' ? ' ult' : ''));
      d.style.left = 100 + Math.cos(ang) * 96 - 15 + 'px';
      d.style.bottom = 100 - Math.sin(ang) * 96 - 15 + 'px';
      d.append(miniSvg(g.seq));
      d.title = g.name;
      ring.append(d);
      ringIcons.push({ d, g });
    });
  }

  // ---- 畫布(軌跡 / 範本 / 回饋字 / 蓄力環)----
  let cw = 0;
  let ch = 0;
  let dpr = 1;
  function resizeCv() {
    const r = root.getBoundingClientRect();
    dpr = Math.min(2, window.devicePixelRatio || 1);
    cw = Math.max(1, Math.round(r.width));
    ch = Math.max(1, Math.round(r.height));
    cv.width = Math.round(cw * dpr);
    cv.height = Math.round(ch * dpr);
    dirty = true;
  }
  const g2 = cv.getContext('2d');
  window.addEventListener('resize', () => root.classList.contains('show') && resizeCv());

  function strokePath(list, color, width, alpha) {
    if (!list || list.length < 2) return;
    const r0 = root.getBoundingClientRect();
    g2.globalAlpha = alpha;
    g2.strokeStyle = color;
    g2.lineWidth = width;
    g2.lineJoin = 'round';
    g2.lineCap = 'round';
    g2.beginPath();
    list.forEach((p, i) => (i ? g2.lineTo(p.x - r0.left, p.y - r0.top) : g2.moveTo(p.x - r0.left, p.y - r0.top)));
    g2.stroke();
    g2.globalAlpha = 1;
  }

  const FONT = '"Microsoft JhengHei", "PingFang TC", sans-serif';
  function paint(now) {
    const tpl = ext.getTemplate && ext.getTemplate();
    const hasHold = gid !== null && pts.length && (ext.getCtx && ext.getCtx() ? ext.getCtx().set.some((g) => g.seq[0] === 'H') : false);
    const need = dirty || gid !== null || tpl || trail || label || hasHold;
    if (!need) return;
    dirty = false;
    g2.setTransform(dpr, 0, 0, dpr, 0, 0);
    g2.clearRect(0, 0, cw, ch);
    const pc = padCenter();
    // 範本(訓練 / 教學)
    if (tpl) drawTemplate(tpl, pc, now);
    // 軌跡
    if (trail) {
      let a = 1;
      if (trail.kind !== 'draw') {
        a = 1 - (now - trail.end) / FADE;
        if (a <= 0) trail = null;
      }
      if (trail) {
        const col = COLORS[trail.kind] || '#fff';
        strokePath(trail.pts, 'rgba(0,0,0,.55)', 9, Math.max(0, a) * 0.8);
        strokePath(trail.pts, col, 5, Math.max(0, a));
        const p0 = trail.pts[0];
        if (p0 && a > 0) {
          const r0 = root.getBoundingClientRect();
          g2.globalAlpha = Math.max(0, a);
          g2.fillStyle = '#5f5';
          g2.beginPath();
          g2.arc(p0.x - r0.left, p0.y - r0.top, 5, 0, 7);
          g2.fill();
          g2.globalAlpha = 1;
        }
        if (trail.kind !== 'draw') dirty = true;
      }
    }
    // 按住蓄力環
    if (hasHold) {
      const prog = holdProgressNow();
      if (prog > 0.15) {
        g2.lineWidth = 7;
        g2.strokeStyle = prog >= 1 ? '#ffe566' : 'rgba(255,200,60,.9)';
        g2.shadowColor = prog >= 1 ? '#ffe566' : 'transparent';
        g2.shadowBlur = prog >= 1 ? 14 : 0;
        g2.beginPath();
        g2.arc(pc.x, pc.y, PAD_D / 2 + 8, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * prog);
        g2.stroke();
        g2.shadowBlur = 0;
        if (prog >= 1) {
          g2.fillStyle = '#ffe566';
          g2.font = 'bold 14px ' + FONT;
          g2.textAlign = 'center';
          g2.fillText('蓄好了!往前畫', pc.x, pc.y - PAD_D / 2 - 14);
        }
      }
    }
    // 回饋字
    if (label) {
      const left = label.until - now;
      if (left <= 0) label = null;
      else {
        const a = Math.min(1, left / 250);
        g2.globalAlpha = a;
        g2.font = 'bold 20px ' + FONT;
        g2.textAlign = 'center';
        g2.textBaseline = 'middle';
        const w = g2.measureText(label.text).width + 24;
        const lx = Math.min(cw - w / 2 - 6, Math.max(w / 2 + 6, pc.x - 20));
        const ly = pc.y - PAD_D / 2 - 56;
        g2.fillStyle = 'rgba(0,0,0,.62)';
        roundRect(g2, lx - w / 2, ly - 16, w, 32, 16);
        g2.fill();
        g2.fillStyle = COLORS[label.kind] || '#fff';
        g2.fillText(label.text, lx, ly + 1);
        g2.globalAlpha = 1;
        g2.textBaseline = 'alphabetic';
        dirty = true;
      }
    }
  }

  function holdProgressNow() {
    if (!pts.length) return 0;
    const p0 = pts[0];
    for (const p of pts) if (Math.hypot(p.x - p0.x, p.y - p0.y) >= PARAMS.holdMove) return 0;
    return Math.min(1, Math.max(0, (performance.now() - down) / PARAMS.holdMs));
  }

  // 範本:虛線 + 終點綠點 + 沿路徑移動的亮點 + 筆順數字
  function drawTemplate(tpl, pc, now) {
    const size = 110;
    const ft = fitTemplate(templatePath(tpl.seq), size, 8);
    const cx = pc.x - size / 2;
    const cy = pc.y - size / 2;
    const face = ext.getCtx && ext.getCtx() ? ext.getCtx().face : 1;
    const Q = (p) => ({ x: cx + (face < 0 ? size - p.x : p.x), y: cy + p.y });
    g2.save();
    g2.globalAlpha = 0.9;
    g2.setLineDash([6, 6]);
    g2.strokeStyle = 'rgba(120,230,255,.85)';
    g2.lineWidth = 3;
    g2.lineCap = 'round';
    g2.beginPath();
    ft.pts.forEach((p, i) => {
      const q = Q(p);
      i ? g2.lineTo(q.x, q.y) : g2.moveTo(q.x, q.y);
    });
    g2.stroke();
    g2.setLineDash([]);
    // 起點(小白點)與終點(綠點 = 在這裡放開手指)
    const s = Q(ft.pts[0]);
    g2.fillStyle = '#fff';
    g2.beginPath();
    g2.arc(s.x, s.y, 3.5, 0, 7);
    g2.fill();
    const en = Q(ft.pts[ft.pts.length - 1]);
    g2.fillStyle = '#5f5';
    g2.beginPath();
    g2.arc(en.x, en.y, 6, 0, 7);
    g2.fill();
    if (ft.hold) {
      const h = Q(ft.hold);
      g2.strokeStyle = '#ffd23a';
      g2.lineWidth = 3;
      g2.beginPath();
      g2.arc(h.x, h.y, 11, 0, 7);
      g2.stroke();
      g2.fillStyle = '#ffd23a';
      g2.font = 'bold 11px ' + FONT;
      g2.textAlign = 'center';
      g2.fillText('按住', h.x, h.y - 15);
    }
    // 筆順數字
    if (ft.marks.length > 1) {
      g2.font = 'bold 12px ' + FONT;
      g2.textAlign = 'center';
      g2.textBaseline = 'middle';
      for (const m of ft.marks) {
        const q = Q(m);
        g2.fillStyle = 'rgba(0,0,0,.7)';
        g2.beginPath();
        g2.arc(q.x, q.y - 12, 8, 0, 7);
        g2.fill();
        g2.fillStyle = '#fff';
        g2.fillText(String(m.n), q.x, q.y - 12);
      }
      g2.textBaseline = 'alphabetic';
    }
    // 移動亮點(2.2 秒一輪)
    const per = 2200;
    const k = (now % per) / per;
    const n = ft.pts.length - 1;
    const f = Math.min(1, k * 1.25) * n;
    const i0 = Math.min(n - 1, Math.floor(f));
    const a = Q(ft.pts[i0]);
    const b = Q(ft.pts[i0 + 1]);
    const t = f - i0;
    g2.fillStyle = '#fff';
    g2.beginPath();
    g2.arc(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, 5, 0, 7);
    g2.fill();
    g2.restore();
    dirty = true;
  }

  // ---- 輪詢 ----
  let raf = 0;
  const poll = () => {
    raf = requestAnimationFrame(poll);
    const c = ext.getCtx ? ext.getCtx() : null;
    spBuild();
    spPaint();
    const rOn = !!(ext.ringOn && ext.ringOn());
    ring.style.display = rOn && c ? '' : 'none';
    if (rOn && c) {
      buildRing(c);
      for (const it of ringIcons) {
        const off = it.g.kind === 'ult' ? !(c.ready || c.canUlt) : c.mp < it.g.cost * 256;
        it.d.classList.toggle('off', off);
        it.d.classList.toggle('lit', !off);
      }
    }
    if (Date.now() - manualAt >= 500) {
      const w = window.__cb && window.__cb.world;
      let r = null;
      if (w) {
        const f = w.fighters.find((x) => x.kind === 'human');
        if (f) r = w.defs[f.charId].hasUlt ? Math.min(1, (f.rage || 0) / RAGE_FULL) : 0;
      }
      if (r !== rageRatio) {
        rageRatio = r;
        paintRage();
      }
    }
    paint(performance.now());
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
      if (key === 'atk' && ext.onEvent) ext.onEvent('atk');
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
      resizeCv();
      spSig = '~';
      ringSig = '';
      spBuild();
      if (!raf) raf = requestAnimationFrame(poll);
    },
    hide() {
      root.classList.remove('show');
      cancelAnimationFrame(raf);
      raf = 0;
    },
    // 主程式可直接餵爆氣比例(0~1);null = 未知
    setRage(ratio) {
      manualAt = Date.now();
      if (ratio !== rageRatio) {
        rageRatio = ratio;
        paintRage();
      }
    },
    // 在回饋區顯示一行字(主程式用:時機不對 / 教學提示…)
    flash,
    // 測試與教學用:直接餵入一筆軌跡(等同手指畫完放開)
    feed(list, face) {
      return finish(list, face || 1);
    },
    // 手勢圈中心(CSS 像素,相對於 #touch),測試用
    padCenter,
    reset() {
      sid = null;
      gid = null;
      pts = [];
      trail = null;
      label = null;
      stickBits = 0;
      btnBits.atk = btnBits.def = 0;
      hint.style.display = '';
      base.style.display = 'none';
      knob.style.display = 'none';
      dirty = true;
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

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

// 小抄環上的迷你手勢圖(SVG 30x30)
function miniSvg(seq) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 30 30');
  svg.setAttribute('width', '30');
  svg.setAttribute('height', '30');
  const ft = fitTemplate(templatePath(seq), 30, 5);
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', ft.pts.map((p, i) => (i ? 'L' : 'M') + p.x.toFixed(1) + ' ' + p.y.toFixed(1)).join(' '));
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '2.4');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  const s = document.createElementNS(NS, 'circle');
  s.setAttribute('cx', ft.pts[0].x.toFixed(1));
  s.setAttribute('cy', ft.pts[0].y.toFixed(1));
  s.setAttribute('r', '2.4');
  s.setAttribute('fill', '#5f5');
  svg.append(s);
  return svg;
}

// 角度 → 8 向(畫面 y 向下為正)
function dirBits(ang) {
  const i = (Math.round(ang / (Math.PI / 4)) + 8) % 8;
  return [BIT.RIGHT, BIT.RIGHT | BIT.DOWN, BIT.DOWN, BIT.LEFT | BIT.DOWN, BIT.LEFT, BIT.LEFT | BIT.UP, BIT.UP, BIT.RIGHT | BIT.UP][i];
}
