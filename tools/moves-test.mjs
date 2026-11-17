// 招式表顯示資料檢查:node tools/moves-test.mjs
import { readFileSync } from 'node:fs';
import { listMoves, cmdText, ultKeyText, defaultDevice } from '../js/ui/moves.js';

let pass = 0;
let fail = 0;
const ok = (c, m) => {
  console.log((c ? 'PASS ' : 'FAIL ') + m);
  c ? pass++ : fail++;
};
const ids = JSON.parse(readFileSync(new URL('../data/chars/index.json', import.meta.url), 'utf8'));
for (const id of ids) {
  const j = JSON.parse(readFileSync(new URL('../data/chars/' + id + '.json', import.meta.url), 'utf8'));
  const sp = Object.keys(j.moves).filter((m) => /^sp_/.test(m));
  const list = listMoves(j);
  if (!sp.length && !j.moves.ultimate) { ok(list.length === 0 && !j.info, id + ' 尚無必殺 / 大招(僅基礎招式)'); continue; }
  ok(list.length >= 3 && list.length <= 4, id + ' 必殺數 3~4(' + list.length + ')');
  ok(sp.every((c) => list.some((m) => m.cmd === c && m.name && m.desc)), id + ' 每個 sp_ 招式都有名稱與說明');
  ok(list.every((m) => j.moves[m.cmd] && m.cost === j.moves[m.cmd].cost), id + ' 顯示的 MP 消耗與招式資料一致');
  ok(j.info && j.info.ult && j.info.ult.name === j.moves.ultimate.ult.name && j.info.ult.desc, id + ' 大招名稱與 moves.ultimate.ult.name 一致且有說明');
}
ok(cmdText('sp_fwd_atk', 'kb') === '防(L)+→+攻(J)', '鍵盤指令顯示');
ok(cmdText('sp_down_jump', 'kb') === '防(L)+↓(S)+跳(K)', '鍵盤下+跳');
ok(cmdText('sp_up_atk', 'touch', true) === '防+↑+攻', '簡寫');
ok(ultKeyText('kb').includes('U') && ultKeyText('touch').includes('大招'), '大招操作文字');
ok(defaultDevice('G1', false) === 'pad' && defaultDevice('P1', true) === 'touch' && defaultDevice('P2', false) === 'p2', '預設裝置');
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
