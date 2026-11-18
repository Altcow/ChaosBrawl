// 練習場手勢訓練:指定一個手勢 → 手勢圈顯示範本;統計成功率;連續成功 5 次 = 熟練(手勢書打勾)
import { isMastered, setMastered } from './settings.js';
import { fitTemplate, templatePath, REASON_TEXT } from './gesture.js';

const NS = 'http://www.w3.org/2000/svg';
export const MASTER_STREAK = 5;

function mini(seq) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '24');
  svg.setAttribute('height', '24');
  const ft = fitTemplate(templatePath(seq), 24, 4);
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', ft.pts.map((q, i) => (i ? 'L' : 'M') + q.x.toFixed(1) + ' ' + q.y.toFixed(1)).join(' '));
  p.setAttribute('fill', 'none');
  p.setAttribute('stroke', 'currentColor');
  p.setAttribute('stroke-width', '2.2');
  p.setAttribute('stroke-linecap', 'round');
  p.setAttribute('stroke-linejoin', 'round');
  svg.append(p);
  return svg;
}

export function setupTrainer(root, { getSet, getCharId }) {
  let target = null;
  let free = true; // 不耗 MP / 爆氣常滿
  let sig = '';
  const stats = {}; // charId + id → { tries, ok, streak }
  let msg = '';
  const row = document.createElement('div');
  row.className = 'tr-row';
  const info = document.createElement('div');
  info.className = 'tr-info';
  const opt = document.createElement('div');
  opt.className = 'tr-opt';
  const bFree = document.createElement('button');
  bFree.type = 'button';
  const bOff = document.createElement('button');
  bOff.type = 'button';
  bOff.textContent = '取消指定';
  opt.append(bFree, bOff);
  root.append(row, info, opt);

  const key = () => getCharId() + ':' + target;
  const st = () => (stats[key()] = stats[key()] || { tries: 0, ok: 0, streak: 0 });
  const paintFree = () => {
    bFree.textContent = '不耗 MP / 爆氣常滿:' + (free ? '開' : '關');
  };
  bFree.onclick = () => {
    free = !free;
    paintFree();
  };
  bOff.onclick = () => api.setTarget(null);
  paintFree();

  function build() {
    const set = getSet() || [];
    const s = getCharId() + set.map((g) => g.id).join(',');
    if (s === sig) return;
    sig = s;
    row.innerHTML = '';
    for (const g of set) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tr-btn';
      b.dataset.id = g.id;
      b.title = g.name;
      b.append(mini(g.seq));
      b.onclick = () => api.setTarget(target === g.id ? null : g.id);
      row.append(b);
    }
    if (target && !set.some((g) => g.id === target)) target = null;
  }

  function paint() {
    build();
    const set = getSet() || [];
    for (const b of row.children) {
      b.classList.toggle('on', b.dataset.id === target);
      b.classList.toggle('done', isMastered(getCharId(), b.dataset.id));
    }
    bOff.style.display = target ? '' : 'none';
    info.innerHTML = '';
    if (!target) {
      info.textContent = '點上面的圖示選一個手勢來練習(圈上會出現範本)';
      return;
    }
    const g = set.find((x) => x.id === target);
    if (!g) return;
    const s = st();
    const b = document.createElement('b');
    b.textContent = g.name;
    const rate = s.tries ? Math.round((s.ok / s.tries) * 100) : 0;
    info.append(b, document.createTextNode('  成功 ' + s.ok + '/' + s.tries + '(' + rate + '%)  連續 ' + s.streak + '/' + MASTER_STREAK));
    if (isMastered(getCharId(), target)) {
      const star = document.createElement('span');
      star.className = 'star';
      star.textContent = '  ★熟練';
      info.append(star);
    }
    if (msg) info.append(document.createElement('br'), document.createTextNode(msg));
  }

  const api = {
    show() {
      root.classList.remove('hide');
      sig = '';
      paint();
    },
    hide() {
      root.classList.add('hide');
    },
    isShown: () => !root.classList.contains('hide'),
    setTarget(id) {
      target = id;
      msg = '';
      paint();
    },
    getTarget: () => target,
    // 手勢圈要顯示的範本;沒指定 = null
    template() {
      const g = target && (getSet() || []).find((x) => x.id === target);
      return g ? { seq: g.seq } : null;
    },
    freeMp: () => free,
    // 記錄一次畫完的結果(點一下不算)
    record(res) {
      if (!target || !res || res.reason === 'tap') return;
      const s = st();
      s.tries++;
      const set = getSet() || [];
      if (res.ok && res.id === target) {
        s.ok++;
        s.streak++;
        msg = '';
        if (s.streak >= MASTER_STREAK && !isMastered(getCharId(), target)) {
          setMastered(getCharId(), target);
          msg = '連續成功 ' + MASTER_STREAK + ' 次,熟練了!';
        }
      } else {
        s.streak = 0;
        if (res.ok) {
          const g = set.find((x) => x.id === res.id);
          msg = '畫成了「' + (g ? g.name : res.id) + '」,跟範本比對一下';
        } else {
          const near = res.nearest && set.find((x) => x.id === res.nearest);
          msg = (REASON_TEXT[res.reason] || '沒認出來') + (near ? '(像是:' + near.name + ')' : '');
        }
      }
      paint();
    },
    refresh: paint,
    stats
  };
  return api;
}
