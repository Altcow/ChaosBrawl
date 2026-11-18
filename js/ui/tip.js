// 第一次進入戰鬥的操作提示層:約 6 秒或點一下 / 按任意鍵關閉;localStorage 記住不再自動顯示,首頁「操作說明」可再看
const LS = 'chaosbrawl-tip-seen';

const TOUCH_LINES = [
  ['搖桿', '左半邊畫面按住滑動 = 走;推到最外圈(左或右)= 自動跑'],
  ['攻 / 跳 / 防', '右下三鈕:連按攻出連段、防要按住'],
  ['必殺技', '攻 / 跳 / 防 上方每招一顆按鈕,點一下就放出(吃 MP,不夠的灰色)'],
  ['最強必殺技', '爆氣條(HUD 金色「爆氣」細條)滿了,「最強」鈕會閃亮,點一下放最強必殺技'],
  ['招式表', '右上「招式表」看每招說明']
];
const KB_LINES = [
  ['移動', 'WASD(P2 方向鍵)'],
  ['攻 / 跳 / 防', 'J / K / L(P2 小鍵盤 1 / 2 / 3)'],
  ['必殺技', '防(L)+方向+攻(J)或跳(K),吃 MP;方向 → 是面對的方向'],
  ['最強必殺技', '爆氣條(HUD 金色「爆氣」細條)滿了,按 U 或 防+攻+跳 同時按'],
  ['招式表', '右上「招式表」或按 H 看每招說明']
];

export function setupTip(root, { isTouch }) {
  let timer = 0;
  const seen = () => {
    try {
      return !!localStorage.getItem(LS);
    } catch (e) {
      return false;
    }
  };
  const mark = () => {
    try {
      localStorage.setItem(LS, '1');
    } catch (e) { /* 隱私模式:不記住 */ }
  };
  function hide() {
    clearTimeout(timer);
    root.classList.add('hide');
  }
  function show(force) {
    if (!force && seen()) return;
    const lines = isTouch() ? TOUCH_LINES : KB_LINES;
    root.innerHTML = '';
    const card = document.createElement('div');
    card.className = 'tip-card';
    const h = document.createElement('h3');
    h.textContent = '操作提示(點一下關閉)';
    card.append(h);
    for (const [a, b] of lines) {
      const r = document.createElement('div');
      r.className = 'tip-row';
      const x = document.createElement('b');
      x.textContent = a;
      const y = document.createElement('span');
      y.textContent = b;
      r.append(x, y);
      card.append(r);
    }
    root.append(card);
    root.classList.remove('hide');
    mark();
    clearTimeout(timer);
    timer = setTimeout(hide, force ? 20000 : 6000);
  }
  root.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    hide();
  });
  window.addEventListener('keydown', (e) => {
    if (!root.classList.contains('hide') && e.code !== 'Enter') hide();
  });
  return { show, hide, isOpen: () => !root.classList.contains('hide') };
}
