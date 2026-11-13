// 選單:模式 + 8 個座位(關閉 / 本機玩家 / 電腦等級)+ 角色
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

export function setupMenu(root, chars, onStart) {
  const slotsEl = root.querySelector('#slots');
  const modeEl = root.querySelector('#sel-mode');
  const rows = [];
  for (let i = 0; i < 8; i++) {
    const row = document.createElement('div');
    row.className = 'slot';
    const label = document.createElement('span');
    label.textContent = String(i + 1);
    const kind = document.createElement('select');
    for (const [v, t] of KINDS) kind.append(new Option(t, v));
    const ch = document.createElement('select');
    for (const c of chars) ch.append(new Option(c.name, c.id));
    kind.value = i === 0 ? 'P1' : 'AI1';
    ch.selectedIndex = i % chars.length;
    const team = document.createElement('select');
    team.className = 'team';
    for (let t = 1; t <= 4; t++) team.append(new Option('隊 ' + t, String(t - 1)));
    team.value = String(i % 2);
    row.append(label, kind, ch, team);
    slotsEl.append(row);
    rows.push({ kind, ch, team });
  }
  const refresh = () => {
    slotsEl.classList.toggle('practice', modeEl.value === 'practice');
    for (const r of rows) r.team.style.display = modeEl.value === 'team' ? '' : 'none';
  };
  modeEl.addEventListener('change', refresh);
  refresh();
  root.querySelector('#btn-start').addEventListener('click', () => onStart(get()));

  function get() {
    return {
      mode: modeEl.value,
      ff: parseInt(root.querySelector('#sel-ff').value, 10),
      slots: rows.map((r) => ({ kind: r.kind.value, char: r.ch.value, team: parseInt(r.team.value, 10) }))
    };
  }
  return {
    get,
    show() { root.classList.remove('hide'); },
    hide() { root.classList.add('hide'); }
  };
}
