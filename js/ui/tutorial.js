// 首次戰鬥 4 步互動教學(手機):每步做對才進下一步,可隨時「跳過」。教學在練習場景進行(木樁不還手、不耗 MP、爆氣常滿)。
// 1 搖桿走路  2 普攻小鈕  3 月步(前衝 ×2、後滑 ×1)  4 畫出第一招(圈上顯示範本)
import { markTutorialSeen } from './settings.js';

export function setupTutorial(root, { gd, getSet, onDone }) {
  let step = -1;
  let moved = 0;
  let steps3 = { f: 0, b: 0 };
  const texts = (gd && gd.tutorial) || [];

  const mk = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };

  function first() {
    return (getSet() || []).find((g) => g.kind === 'sp') || null;
  }

  function paint() {
    root.innerHTML = '';
    if (step < 0) return;
    if (step >= 4) {
      root.append(mk('b', null, '教學完成!'));
      root.append(mk('div', null, '每個角色的手勢都在首頁「招式手勢書」,練習場可以反覆練習。'));
      const go = mk('button', null, '開始對戰');
      go.type = 'button';
      go.onclick = () => finish();
      root.append(go);
      return;
    }
    const t = texts[step] || { title: '', text: '' };
    root.append(mk('b', null, t.title));
    let txt = t.text;
    if (step === 2) txt += '(前衝 ' + steps3.f + '/2、後滑 ' + steps3.b + '/1)';
    if (step === 3) {
      const g = first();
      if (g) txt = '沿著虛線範本,在大圈畫出「' + g.name + '」,放開就出招';
    }
    root.append(mk('div', null, txt));
    const skip = mk('button', null, '跳過教學');
    skip.type = 'button';
    skip.onclick = () => finish();
    root.append(skip);
  }

  function next() {
    step++;
    paint();
    if (step >= 4) {
      markTutorialSeen();
    }
  }

  function finish() {
    if (step < 0) return;
    step = -1;
    markTutorialSeen();
    root.classList.add('hide');
    root.innerHTML = '';
    onDone && onDone();
  }

  return {
    start() {
      step = 0;
      moved = 0;
      steps3 = { f: 0, b: 0 };
      root.classList.remove('hide');
      paint();
    },
    isActive: () => step >= 0,
    // 事件:'stick' / 'atk'
    onEvent(type) {
      if (step === 0 && type === 'stick') {
        moved++;
        if (moved >= 6) next();
      } else if (step === 1 && type === 'atk') next();
    },
    // 一次手勢辨識結果
    onGesture(res) {
      if (!res || !res.ok) return;
      if (step === 2) {
        if (res.id === 'step_f' && steps3.f < 2) steps3.f++;
        else if (res.id === 'step_b' && steps3.b < 1) steps3.b++;
        if (steps3.f >= 2 && steps3.b >= 1) next();
        else paint();
      } else if (step === 3) {
        const g = first();
        if (g && res.id === g.id) next();
      }
    },
    // 手勢圈要顯示的範本
    template() {
      if (step === 2) return { seq: steps3.f < 2 ? ['F'] : ['B'] };
      if (step === 3) {
        const g = first();
        return g ? { seq: g.seq } : null;
      }
      return null;
    },
    skip: finish,
    // 中途離開(回選單):不算看過,下次還會再教
    cancel() {
      step = -1;
      root.classList.add('hide');
      root.innerHTML = '';
    }
  };
}
