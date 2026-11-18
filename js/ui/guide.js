// 招式手勢書:滿版頁面(只有左上返回鈕),含手勢動畫 SVG。招式名稱 / 說明 / MP 一律從角色 json 讀,手勢表讀 data/gestures.json。
import { buildSet, templatePath, fitTemplate, seqSym, TOKEN_TEXT } from './gesture.js';
import { isMastered } from './settings.js';

const NS = 'http://www.w3.org/2000/svg';
const sv = (tag, attrs) => {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
};
const h = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

// 手勢動畫:灰色路徑 + 金色筆跡逐步畫出 + 白點沿路徑移動;起點綠點、終點箭頭、多筆時標筆順數字、按住時顯示環
export function gestureSvg(seq, opts) {
  opts = opts || {};
  const W = 120;
  const H = 84;
  const svg = sv('svg', { viewBox: '0 0 ' + W + ' ' + H, width: W, height: H });
  const ft = fitTemplate(templatePath(seq), W, 14, H);
  const ox = 0;
  const pts = ft.pts.map((p) => ({ x: p.x + ox, y: p.y }));
  const d = pts.map((p, i) => (i ? 'L' : 'M') + p.x.toFixed(1) + ' ' + p.y.toFixed(1)).join(' ');
  svg.append(sv('path', { d, fill: 'none', stroke: '#4a5266', 'stroke-width': 4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  const hasHold = !!ft.hold;
  const dur = hasHold ? 3.2 : 2.4;
  const kt = hasHold ? '0;0.25;0.9;1' : '0;0.9;1';
  const trace = sv('path', { d, fill: 'none', stroke: '#ffd23a', 'stroke-width': 4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', pathLength: 1, 'stroke-dasharray': 1, 'stroke-dashoffset': 1 });
  if (!opts.still) {
    trace.append(sv('animate', { attributeName: 'stroke-dashoffset', values: hasHold ? '1;1;0;0' : '1;0;0', keyTimes: kt, dur: dur + 's', repeatCount: 'indefinite' }));
  } else trace.setAttribute('stroke-dashoffset', '0');
  svg.append(trace);
  // 終點箭頭
  const n = pts.length;
  let a = pts[n - 1];
  let b = pts[Math.max(0, n - 4)];
  const ang = Math.atan2(a.y - b.y, a.x - b.x);
  const tip = a;
  const L = 8;
  const arrow = sv('path', {
    d: 'M' + tip.x + ' ' + tip.y + ' L' + (tip.x - L * Math.cos(ang - 0.45)) + ' ' + (tip.y - L * Math.sin(ang - 0.45)) + ' L' + (tip.x - L * Math.cos(ang + 0.45)) + ' ' + (tip.y - L * Math.sin(ang + 0.45)) + ' Z',
    fill: '#ffd23a'
  });
  svg.append(arrow);
  // 起點
  svg.append(sv('circle', { cx: pts[0].x, cy: pts[0].y, r: 4.5, fill: '#5f5' }));
  if (ft.hold) {
    const hp = { x: ft.hold.x + ox, y: ft.hold.y };
    svg.append(sv('circle', { cx: hp.x, cy: hp.y, r: 10, fill: 'none', stroke: '#ffd23a', 'stroke-width': 2.5, 'stroke-dasharray': '4 3' }));
    const t = sv('text', { x: hp.x, y: hp.y - 14, fill: '#ffd23a', 'font-size': 10, 'text-anchor': 'middle' });
    t.textContent = '按住';
    svg.append(t);
  }
  if (ft.marks.length > 1) {
    for (const m of ft.marks) {
      const g = sv('g', {});
      g.append(sv('circle', { cx: m.x + ox, cy: m.y - 9, r: 7, fill: '#000', 'fill-opacity': 0.7 }));
      const t = sv('text', { x: m.x + ox, y: m.y - 5.5, fill: '#fff', 'font-size': 9, 'text-anchor': 'middle' });
      t.textContent = String(m.n);
      g.append(t);
      svg.append(g);
    }
  }
  if (!opts.still) {
    const dot = sv('circle', { r: 5, fill: '#fff' });
    const mp = sv('animateMotion', { path: d, dur: dur + 's', repeatCount: 'indefinite', calcMode: 'linear', keyTimes: kt, keyPoints: hasHold ? '0;0;1;1' : '0;1;1' });
    dot.append(mp);
    svg.append(dot);
  }
  return svg;
}

export function seqText(seq) {
  return seq.map((t) => TOKEN_TEXT[t] || t).join(' → ');
}

export function setupGuide(root, { chars, charIds, gd, onPractice, onToggle }) {
  root.innerHTML = '';
  const head = h('div', 'gd-head');
  const back = h('button', 'gd-back', '← 返回');
  back.type = 'button';
  head.append(back, h('h2', null, '招式手勢書'), h('span', 'gd-sub', '一筆畫完、放開才出招'));
  const tabs = h('div');
  tabs.id = 'gd-tabs';
  const body = h('div');
  body.id = 'gd-body';
  root.append(head, tabs, body);

  let cur = 'rules';
  const short = (id) => (chars[id].nicknames && chars[id].nicknames[0]) || chars[id].name;

  function tabBtn(id, text) {
    const b = h('button', null, text);
    b.type = 'button';
    b.dataset.id = id;
    b.onclick = () => {
      cur = id;
      render();
    };
    return b;
  }
  tabs.append(tabBtn('rules', '總則'));
  for (const id of charIds) tabs.append(tabBtn(id, short(id)));

  function card(charId, g) {
    const c = h('div', 'gd-card' + (g.kind === 'ult' ? ' ult' : '') + (isMastered(charId, g.id) ? ' done' : ''));
    const nm = h('div', 'gd-name');
    nm.append(h('span', null, (g.kind === 'ult' ? '★' : '') + g.name), h('span', 'gd-cost', g.kind === 'ult' ? '爆氣 100' : 'MP ' + g.cost));
    const sw = h('div', 'gd-svg');
    sw.append(gestureSvg(g.seq));
    c.append(nm, sw, h('div', 'gd-sym', seqSym(g.seq)));
    const fam = g.kind === 'ult' ? '最強:專屬簽名手勢' : g.family && gd.families[g.family] ? '家族:' + gd.families[g.family].name : '';
    if (fam) c.append(h('div', 'gd-fam', fam));
    c.append(h('div', 'gd-desc', g.desc));
    if (g.tip) c.append(h('div', 'gd-tip', '訣竅:' + g.tip));
    const act = h('div', 'gd-act');
    const bt = h('button', null, '去練習');
    bt.type = 'button';
    bt.onclick = () => onPractice && onPractice(charId, g.id);
    act.append(bt);
    if (isMastered(charId, g.id)) act.append(h('span', 'gd-ok', '✓ 熟練'));
    c.append(act);
    return c;
  }

  function renderChar(id) {
    const j = chars[id];
    const set = buildSet(j, gd);
    const info = h('div', 'gd-steps');
    const stepNames = gd.stepsHelp ? gd.stepsHelp.join(' ‧ ') : '';
    const b = h('b', null, j.name + ':');
    info.append(b, document.createTextNode(' 共通 → 前衝、← 後滑、↑ ↓ 縱步(月步,耗步力不耗 MP)。面向左時左右相反。'));
    void stepNames;
    body.append(info);
    const grid = h('div', 'gd-grid');
    for (const g of set.filter((x) => x.kind !== 'step')) grid.append(card(id, g));
    body.append(grid);
    const sh = h('div', 'gd-steps');
    sh.style.marginTop = '8px';
    for (const t of gd.stepsHelp || []) sh.append(h('div', null, '• ' + t));
    body.append(sh);
  }

  function renderRules() {
    body.append(h('h3', null, '怎麼畫'));
    const ul = h('ul');
    for (const t of gd.rules || []) ul.append(h('li', null, t));
    body.append(ul);
    body.append(h('h3', null, '月步(取消跳躍後的移動)'));
    const ul2 = h('ul');
    for (const t of gd.stepsHelp || []) ul2.append(h('li', null, t));
    body.append(ul2);
    body.append(h('h3', null, '10 種手勢家族(同類招式畫同一種形狀)'));
    const grid = h('div', 'gd-fams');
    for (const id of Object.keys(gd.families)) {
      const f = gd.families[id];
      const c = h('div', 'gd-fam-card');
      const sw = h('div', 'gd-svg');
      sw.append(gestureSvg(f.seq));
      const t = h('div', 't');
      const bb = h('b', null, f.name + '  ' + seqSym(f.seq));
      t.append(bb, h('div', null, f.image), h('div', null, f.type));
      c.append(sw, t);
      grid.append(c);
    }
    body.append(grid);
    body.append(h('h3', null, '畫完的回饋'));
    const lg = h('div', 'gd-legend');
    for (const [col, t] of [['#ffd23a', '金色 = 出招成功,顯示招式名'], ['#9aa0aa', '灰色 = MP 不足 / 爆氣未滿 / 時機不對'], ['#ff5a50', '紅色 = 沒認出來,會告訴你原因']]) {
      const s = h('span');
      const i = h('i');
      i.style.background = col;
      s.append(i, document.createTextNode(t));
      lg.append(s);
    }
    body.append(lg);
    body.append(h('div', 'gd-steps', '爆氣滿了,手勢圈外框會亮金光;圈外 4 個小圖示 = 3 招 + 最強,MP 夠就亮。練習場可以指定一招反覆練,連續成功 5 次就算熟練。'));
  }

  function render() {
    for (const b of tabs.children) b.classList.toggle('on', b.dataset.id === cur);
    body.innerHTML = '';
    body.scrollTop = 0;
    if (cur === 'rules') renderRules();
    else renderChar(cur);
    const on = tabs.querySelector('.on');
    if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest', inline: 'center' });
  }

  const api = {
    open(charId) {
      cur = charId && chars[charId] ? charId : charIds[0];
      root.classList.remove('hide');
      render();
      onToggle && onToggle(true);
    },
    openRules() {
      cur = 'rules';
      root.classList.remove('hide');
      render();
      onToggle && onToggle(true);
    },
    close() {
      if (root.classList.contains('hide')) return;
      root.classList.add('hide');
      onToggle && onToggle(false);
    },
    isOpen: () => !root.classList.contains('hide'),
    refresh: () => api.isOpen() && render()
  };
  back.onclick = () => api.close();
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Escape' && api.isOpen()) api.close();
  });
  return api;
}
