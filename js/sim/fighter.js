import { BIT } from '../core/input.js';
import { FX, toFx, clamp, px } from '../core/fixed.js';
import { detectCommand } from './command.js';
import { spawnProjectile } from './projectiles.js';
import { RAGE_MAX } from './ult.js';

export const S = {
  IDLE: 0, WALK: 1, RUN: 2, RUNSTOP: 3, SQUAT: 4, JUMP: 5, DASH: 6, ATTACK: 7,
  DEFEND: 8, ROLL: 9, HURT: 10, FALL: 11, LYING: 12, GETUP: 13, STUN: 14, SPECIAL: 15, DEAD: 16
};
export const STATE_NAMES = [
  'Idle', 'Walk', 'Run', 'RunStop', 'Squat', 'Jump', 'Dash', 'Attack',
  'Defend', 'Roll', 'Hurt', 'Fall', 'Lying', 'GetUp', 'Stun', 'Special', 'Dead'
];

const DOUBLE_TAP = 12; // 連按同向兩次的 tick 上限
const HEAL_DELAY = 180; // 灰血 3 秒後開始回復
const GRAY_RATIO = 3; // 傷害的 30% 變灰血(×3/10)
const KILL_CREDIT = 300; // 擊殺歸屬:最後 5 s 內造成傷害的人
const LONG_STUN = 40; // 控制遞減(護欄 6):硬直 >= 40 tick(或鎖定 / 擒抓)算「長控制」
const CTL_WINDOW = 180; // 同一目標 3 s 內再吃一次長硬直,硬直減半

// JSON 招式資料 → 執行用資料(速度轉定點數、預算總 tick)
export function compileChar(j) {
  const d = {
    id: j.id, name: j.name, color: j.color, armor: !!j.armor, assist: j.assist || null, ai: j.ai || {},
    hp: toFx(j.hp), mp: toFx(j.mp), mpStart: toFx(j.mpStart), mpRegen: Math.round((j.mpRegen * FX) / 60),
    walkX: toFx(j.walk.x), walkZ: toFx(j.walk.z), runX: toFx(j.run.x), runZ: toFx(j.run.z),
    jumpVy: toFx(j.jump.vy), gravity: toFx(j.jump.g), squat: j.jump.squat, jumpVx: toFx(j.jump.vx),
    dashVx: Math.round(toFx(j.run.x) * j.dash.keep), dashVy: toFx(j.dash.vy),
    runStop: j.runStop, roll: Object.assign({}, j.roll, { speed: toFx(j.roll.speed) }),
    lying: j.lying, getup: j.getup, stun: j.stun,
    body: j.body, moves: {}, projectiles: {}, hasUlt: false,
    // 被動(D9):lowHp = { pct, atk } 血量低於 pct% 時攻擊 +atk%;buffs = 計時增益(dur tick、atk / spd 百分比、armor 霸體、after 結束後的減益)
    passive: j.passive || {}, buffs: j.buffs || {}
  };
  for (const name in j.moves) {
    const m = j.moves[name];
    const frames = m.frames.map((f) => ({
      wait: f.wait, mvx: toFx(f.mvx || 0), itr: f.itr || null,
      spawn: f.spawn ? [].concat(f.spawn) : null, tp: f.tp || 0, tpAny: !!f.tpAny,
      // counter:true = 觸發名為 counter 的招式;字串 = 觸發該名稱的招式
      counter: f.counter === true ? 'counter' : f.counter || '',
      inv: !!f.inv, armor: !!f.armor, turn: !!f.turn, live: !!f.live, reflect: !!f.reflect,
      mark: !!f.mark, recall: !!f.recall, buff: f.buff || '', shake: f.shake || 0, // shake:招式格開始時發畫面震動事件(純畫面,E3)
      still: !!f.still, // still:這一格不吃 steer(方向鍵操控只在沒標 still 的格有效:起手 / 收招的破綻不能邊走邊收)
      heal: f.heal ? Math.floor((f.heal * FX) / f.wait) : 0, // 每 tick 回復量(先灰血再 HP)
      mpTick: f.mpSec ? Math.round((f.mpSec * FX) / 60) : 0,
      pull: f.pull ? { range: f.pull.range || 0, zr: f.pull.zr || 0, to: f.pull.to || 0, speed: toFx(f.pull.speed || 0), zspeed: toFx(f.pull.zspeed || 0), all: !!f.pull.all, front: !!f.pull.front } : null
    }));
    d.moves[name] = {
      frames, next: m.next || null, cancel: m.cancel || 0, cost: toFx(m.cost || 0),
      launch: m.launch ? { vx: toFx(m.launch.vx), vy: toFx(m.launch.vy) } : null,
      steer: m.steer ? { x: toFx(m.steer.x), z: toFx(m.steer.z || 0) } : null, // 招式中可用方向鍵移動(px / tick)
      lock: !!m.lock, // 鎖定演出招式(被 itr.lock 指到時,對手被釘在身前)
      holdDy: m.holdDy || 0, // 鎖定演出招式:被鎖定者畫面往上抬 N px(純畫面,E1)
      total: frames.reduce((s, f) => s + f.wait, 0), boom: false, first: 0, ult: null
    };
    if (m.ult) {
      // 大招:第一個出手格(有判定或 spawn)之前的 tick 數 = 無敵窗長度
      let first = 0;
      for (const f of frames) {
        if (f.itr || f.spawn || f.live) break;
        first += f.wait;
      }
      d.moves[name].first = first;
      d.moves[name].ult = { cap: m.ult.cap, type: m.ult.type || 'dodge', unblockable: !!m.ult.unblockable, name: m.ult.name || j.name };
      if (name === 'ultimate') d.hasUlt = true;
    }
  }
  for (const name in j.projectiles || {}) {
    const p = j.projectiles[name];
    d.projectiles[name] = {
      vx: toFx(p.vx || 0), life: p.life, chase: toFx(p.chase || 0), bdy: p.bdy || null,
      itr: p.itr || null, wall: !!p.wall, zone: p.zone || null,
      boomerang: !!p.boomerang, backVx: toFx(p.backVx || p.vx || 0), backVz: toFx(p.backVz || 3),
      pierce: !!p.pierce, limit: p.limit || 0
    };
  }
  // 會折返的射彈:招式標記起來,飛出去的帽子沒回來前不能再丟
  for (const name in d.moves) {
    for (const fr of d.moves[name].frames) {
      if (fr.spawn && fr.spawn.some((sp) => d.projectiles[sp.proj] && d.projectiles[sp.proj].boomerang)) d.moves[name].boom = true;
    }
  }
  return d;
}

export function createFighter(w, spec, id) {
  const def = w.defs[spec.charId];
  return {
    id, team: spec.team !== undefined ? spec.team : id, charId: spec.charId, kind: spec.kind || 'human', seatHuman: (spec.kind || 'human') === 'human',
    x: toFx(spec.x), y: 0, z: toFx(spec.z), vx: 0, vy: 0, vz: 0, face: spec.face || 1,
    state: S.IDLE, st: 0, nextState: S.JUMP, takeoffVx: 0,
    hp: def.hp, gray: 0, mp: def.mpStart, fall: 0, bdef: 0, sinceHit: 999,
    hitstop: 0, rollCd: 0, getupDir: 0, stunT: 0, airHits: 0, inv: 0, silence: 0, ctlT: 0,
    held: -1, mkx: 0, mkz: 0, buf: '', bufT: 0, aftT: 0,
    rage: 0, ult: 0, ultSeq: 0, ultDmg: {}, ultGuard: 0, ultGuardBy: 0,
    dead: false, deadTick: 0, kills: 0, lastAtk: -1, lastAtkTick: -999,
    move: null, mf: 0, mt: 0, mtot: 0, mseq: 0, hf: -1, hm: null,
    prev: 0, pend: 0, hist: [], tapDir: 0, tapT: -99,
    ai: { lvl: spec.lvl || 0, cd: spec.period || 30, period: spec.period || 30, tgt: -1, q: [], script: [], defUntil: 0, reactCd: 0, cdA: 0, zOff: 0, spT: 0, lastIn: 0 },
    hitLog: {}
  };
}

export function isInvuln(f, def) {
  if (f.state === S.LYING || f.state === S.GETUP || f.state === S.DEAD) return true;
  if (f.inv > 0) return true;
  if (f.ult === 1) return true; // 排隊 / 特寫中
  if (f.ult === 2 && f.move === 'ultimate' && f.mtot <= def.moves.ultimate.first) return true; // 到第一個出手格為止
  if (f.move) {
    const fr = def.moves[f.move] && def.moves[f.move].frames[f.mf];
    if (fr && fr.inv) return true; // 招式格無敵(D2)
  }
  if (f.state === S.ROLL) return f.st >= def.roll.invFrom && f.st <= def.roll.invTo;
  return false;
}

// ---- 招式 ----
export function startMove(f, def, w, name, state) {
  f.move = name;
  f.mf = 0;
  f.mt = 0;
  f.mtot = 0;
  f.mseq = w.nextSeq++;
  if (state !== undefined) {
    f.state = state;
    f.st = 0;
  }
}

// 增益 / 被動(D9)
export function buffSpec(f, def) {
  if (!f.buf) return null;
  const b = def.buffs[f.buf];
  if (!b) return null;
  if (f.bufT > 0) return b;
  return f.aftT > 0 ? b.after || null : null;
}
const spdAdj = (f, def, v) => {
  const b = buffSpec(f, def);
  return b && b.spd ? v + Math.trunc((v * b.spd) / 100) : v;
};
// 攻擊倍率(百分比):被動 lowHp 與增益 atk 相加
export function atkPct(f, def) {
  let p = 100;
  const lh = def.passive.lowHp;
  if (lh && f.hp * 100 < def.hp * lh.pct) p += lh.atk;
  const b = buffSpec(f, def);
  if (b && b.atk) p += b.atk;
  return p;
}
function startBuff(f, def, id) {
  if (!def.buffs[id]) return;
  f.buf = id;
  f.bufT = def.buffs[id].dur;
  f.aftT = 0;
}
// 霸體:只擋近戰輕攻擊(呼叫端排除射彈 / 投技 / fall >= 35)。常駐(def.armor,僅普攻)、招式格 armor、增益 armor
export function armorNow(f, def) {
  if (def.armor && f.state === S.ATTACK) return true;
  if (!f.move || (f.state !== S.ATTACK && f.state !== S.SPECIAL)) return false;
  const fr = def.moves[f.move] && def.moves[f.move].frames[f.mf];
  if (fr && fr.armor) return true;
  const b = buffSpec(f, def);
  return !!(b && b.armor);
}

// 自我回血(D8):先回灰血再回 HP;被打中斷由 takeHit 清掉招式處理
function healStep(f, def, amt) {
  if (f.dead) return;
  const g = Math.min(f.gray, amt);
  f.hp += g;
  f.gray -= g;
  const rest = amt - g;
  if (rest > 0) f.hp = Math.min(def.hp, f.hp + rest);
  if (f.gray > def.hp - f.hp) f.gray = def.hp - f.hp;
}

// 吸引(D7):範圍內(all = 全場)敵人往施放者拉到 to px 以內;無敵中(翻滾 / 倒地)不受影響
function applyPull(w, f, pl) {
  for (const o of w.fighters) {
    if (o === f || o.dead || o.team === f.team || o.state === S.DEAD) continue;
    if (isInvuln(o, w.defs[o.charId])) continue;
    if (!pl.all) {
      const dxp = px(o.x - f.x) * f.face;
      if (dxp < -20 || dxp > pl.range || Math.abs(px(o.z - f.z)) > pl.zr) continue;
    }
    const dir = pl.all && !pl.front ? (o.x >= f.x ? 1 : -1) : f.face;
    const dest = f.x + dir * toFx(pl.to);
    if (pl.front) o.x += clamp(dest - o.x, -pl.speed, pl.speed); // 一律拉到施放者面前(含背後的人)
    else if (dir * (o.x - dest) > 0) o.x -= dir * Math.min(pl.speed, dir * (o.x - dest));
    if (pl.zspeed) o.z += clamp(f.z - o.z, -pl.zspeed, pl.zspeed);
    o.x = clamp(o.x, 16 * FX, (w.stage.w - 16) * FX);
  }
}

// 鎖定(D13):被鎖定的人釘在鎖定者身前,直到鎖定招式結束或被打出 HURT
export function stepHolds(w) {
  for (const d of w.fighters) {
    if (d.held < 0) continue;
    const a = w.fighters[d.held];
    const am = a && !a.dead && a.move ? w.defs[a.charId].moves[a.move] : null;
    if (!am || !am.lock || d.dead || d.state !== S.HURT) {
      d.held = -1;
      continue;
    }
    d.x = clamp(a.x + a.face * toFx(36), 16 * FX, (w.stage.w - 16) * FX);
    d.z = a.z;
    d.vx = 0;
  }
}

function teleport(f, w, range, any) {
  if (any) {
    // 鏈式(D13):瞬移到最近一名「這招還沒打過」的敵人身邊(用 hitLog 判斷,不另存狀態)
    let tb = null;
    let tbd = 1 << 30;
    for (const o of w.fighters) {
      if (o === f || o.dead || o.team === f.team || o.state === S.DEAD) continue;
      const l = f.hitLog[o.id];
      if (l && l.seq === f.mseq) continue;
      const d = Math.abs(o.x - f.x) + Math.abs(o.z - f.z) * 2;
      if (d < tbd) {
        tbd = d;
        tb = o;
      }
    }
    if (tb) {
      const dir = tb.x >= f.x ? 1 : -1;
      f.x = clamp(tb.x + dir * toFx(30), 16 * FX, (w.stage.w - 16) * FX);
      f.z = tb.z;
      f.face = -dir;
    }
    return;
  }
  let best = null;
  let bd = 1 << 30;
  for (const o of w.fighters) {
    if (o === f || o.dead) continue;
    const dx = ((o.x - f.x) >> 8) * f.face;
    if (dx > -30 && dx <= range + 30) {
      const d = Math.abs(dx) + Math.abs((o.z - f.z) >> 8);
      if (d < bd) {
        bd = d;
        best = o;
      }
    }
  }
  if (best) {
    f.x = best.x + f.face * toFx(30);
    f.z = best.z;
    f.face = -f.face;
  } else {
    f.x += f.face * toFx(range);
  }
}

// 回傳 true = 招式結束
function stepMove(f, def, w, air) {
  const m = def.moves[f.move];
  const fr = m.frames[f.mf];
  if (f.mt === 0) {
    if (fr.turn) f.face = -f.face;
    if (fr.mark) {
      f.mkx = f.x;
      f.mkz = f.z;
    }
    if (fr.recall) {
      f.x = f.mkx;
      f.z = f.mkz;
    }
    if (fr.tp) teleport(f, w, fr.tp, fr.tpAny);
    if (fr.buff) startBuff(f, def, fr.buff);
    if (fr.spawn) for (const sp of fr.spawn) spawnProjectile(w, f, def, sp);
    if (fr.shake) w.events.push({ t: 'shake', x: f.x, y: f.y, z: f.z, n: fr.shake });
  }
  if (fr.heal) healStep(f, def, fr.heal);
  if (fr.mpTick) f.mp = Math.min(def.mp, f.mp + fr.mpTick);
  if (fr.pull) applyPull(w, f, fr.pull);
  if (!air) {
    f.vx = f.face * fr.mvx;
    if (m.steer && !fr.still) {
      const h = f.hist.length ? f.hist[f.hist.length - 1] : 0;
      f.vx = ((h & BIT.RIGHT ? 1 : 0) - (h & BIT.LEFT ? 1 : 0)) * m.steer.x;
      f.vz = ((h & BIT.DOWN ? 1 : 0) - (h & BIT.UP ? 1 : 0)) * m.steer.z;
    }
  }
  f.hf = f.mf;
  f.hm = f.move;
  f.mt++;
  f.mtot++;
  if (f.mt >= fr.wait) {
    f.mf++;
    f.mt = 0;
    if (f.mf >= m.frames.length) {
      f.move = null;
      return true;
    }
  }
  return false;
}

function tryCommand(f, def, w, pr) {
  if (f.silence > 0) return false;
  const trig = pr & BIT.ATK ? BIT.ATK : pr & BIT.JUMP ? BIT.JUMP : 0;
  if (!trig) return false;
  const name = detectCommand(f.hist, trig, f.face);
  if (!name) return false;
  const m = def.moves[name];
  if (!m || f.mp < m.cost) return false;
  if (m.boom && boomOut(w, f)) return false; // 迴力帽沒回來前不能再丟
  f.mp -= m.cost;
  f.vx = 0;
  startMove(f, def, w, name, S.SPECIAL);
  if (m.launch) {
    f.state = S.JUMP;
    f.vy = m.launch.vy;
    f.vx = f.face * m.launch.vx;
    f.y = 1;
  }
  return true;
}

// 自己有射彈還在外面飛(迴力類)
export function boomOut(w, f) {
  for (const p of w.projectiles) {
    if (p.owner === f.id && w.defs[p.ch].projectiles[p.kind].boomerang) return true;
  }
  return false;
}

// ---- 大招 ----
// 輸入:防 + 攻 + 跳 在最近 4 tick 內都剛按下(第 5 格以前沒按住)、現在三鍵都按著
const ULT_BITS = [BIT.DEF, BIT.ATK, BIT.JUMP];
function ultChord(f) {
  const h = f.hist;
  const n = h.length;
  const M = BIT.DEF | BIT.ATK | BIT.JUMP;
  if (n === 0 || (h[n - 1] & M) !== M) return false;
  if (n >= 5) for (const b of ULT_BITS) if (h[n - 5] & b) return false;
  return true;
}

// 可發動時機:地面的站、走、跑、防、普攻取消窗(含剛出手 4 tick 內與蹲伏 4 tick 內,讓三鍵不同時按下仍成立)
function ultAllowed(f, def) {
  if (f.dead || f.y > 0) return false;
  switch (f.state) {
    case S.IDLE:
    case S.WALK:
    case S.RUN:
    case S.DEFEND:
      return true;
    case S.SQUAT:
      return f.st <= 4;
    case S.ATTACK: {
      if (!f.move) return false;
      const m = def.moves[f.move];
      return f.mtot <= 4 || m.total - f.mtot <= m.cancel;
    }
    default:
      return false;
  }
}

// 滿條 + 三鍵 + 時機成立 → 進入排隊(f.ult = 1,無敵待命),由 world 排演出。回傳 true = 已發動
export function ultTrigger(f, def, w) {
  if (!def.hasUlt || !w.ult.on || f.ult || f.rage < RAGE_MAX || f.silence > 0 || w.mode.over) return false;
  if (!ultChord(f) || !ultAllowed(f, def)) return false;
  f.rage = 0;
  f.ult = 1;
  f.ultSeq = w.nextSeq++;
  f.ultDmg = {};
  f.vx = 0;
  f.vz = 0;
  f.pend = 0;
  startMove(f, def, w, 'ultimate', S.SPECIAL);
  w.ult.q.push(f.id);
  return true;
}

// 演出暫停中:只記錄輸入(與 hitstop 相同),並讓滿條者仍可排隊發動
export function bufferInput(f, w, inb) {
  const def = w.defs[f.charId];
  if ((inb & (BIT.LEFT | BIT.RIGHT)) === (BIT.LEFT | BIT.RIGHT)) inb &= ~(BIT.LEFT | BIT.RIGHT);
  if ((inb & (BIT.UP | BIT.DOWN)) === (BIT.UP | BIT.DOWN)) inb &= ~(BIT.UP | BIT.DOWN);
  const pr = (inb & ~f.prev) | f.pend;
  f.prev = inb;
  f.hist.push(inb);
  if (f.hist.length > 16) f.hist.shift();
  f.hf = -1;
  f.hm = null;
  if (f.state === S.DEAD || f.hitstop > 0) {
    f.pend = pr;
    return;
  }
  f.pend = pr;
  ultTrigger(f, def, w);
}

function startJump(f, def, dirX, dash) {
  f.state = S.SQUAT;
  f.st = 0;
  f.vx = 0;
  f.nextState = dash ? S.DASH : S.JUMP;
  if (dash) f.takeoffVx = f.face * def.dashVx;
  else {
    if (dirX) f.face = dirX;
    f.takeoffVx = dirX * def.jumpVx;
  }
}

function startRoll(f, dir) {
  f.state = S.ROLL;
  f.st = 0;
  f.face = dir;
  f.getupDir = dir;
}

function knockLand(f) {
  f.y = 0;
  f.vy = 0;
  f.vx = 0;
  f.airHits = 0;
  f.state = S.LYING;
  f.st = 0;
  f.getupDir = 0;
}

// ---- 受擊(由 hit.js 呼叫) ----
// 回傳 'hit' | 'block' | 'counter' | null(無敵或穿過)
export function takeHit(w, d, attX, itr, owner, isProj) {
  const def = w.defs[d.charId];
  if (isInvuln(d, def)) return null;
  if (d.state === S.FALL) {
    // 空中追打上限:被擊飛後最多再中 3 下,之後穿過並強制落地
    if (d.airHits >= 3) {
      if (d.vy > -8 * FX) d.vy = -8 * FX;
      return null;
    }
    d.airHits++;
  }
  const dirAway = attX >= d.x ? -1 : 1; // 被打後飛離攻擊者的方向
  d.sinceHit = 0;
  d.hitstop = itr.stop;

  // 反擊架式:被近戰碰到就反擊
  const cn = !isProj && d.state === S.SPECIAL && d.move ? def.moves[d.move].frames[d.mf].counter : '';
  if (cn && def.moves[cn]) {
    d.face = -dirAway;
    startMove(d, def, w, cn, S.SPECIAL);
    return 'counter';
  }

  if (itr.kind !== 'grab' && !itr.unb && d.state === S.DEFEND && -dirAway === d.face) {
    // 防住正面:傷害只吃 10%(大招 25%,見角色名單設計第 2 節),擦傷不致死、不累積爆氣,累積 bdef
    d.hp = Math.max(FX, d.hp - Math.floor((itr.dmg * FX * (itr.ult ? 25 : 10)) / 100));
    d.vx = dirAway * (toFx(itr.kx) >> 1);
    d.bdef += itr.bdef;
    if (d.bdef >= 100) {
      d.bdef = 0;
      d.state = S.STUN;
      d.st = 0;
      d.vx = 0;
    }
    return 'block';
  }

  const dmg = itr.dmg * FX;
  d.hp = Math.max(0, d.hp - dmg);
  d.gray += Math.floor((dmg * GRAY_RATIO) / 10);
  if (d.gray > def.hp - d.hp) d.gray = def.hp - d.hp;
  d.mp = Math.min(def.mp, d.mp + 3 * FX);
  if (def.hasUlt && w.ult.on) d.rage = Math.min(RAGE_MAX, d.rage + Math.floor((dmg * 3) / 10)); // 受傷每 10 點 +3
  d.fall += itr.fall;
  d.lastAtk = owner;
  d.lastAtkTick = w.tick;
  if (d.hp <= 0 && !d.dead) {
    d.dead = true;
    d.deadTick = w.tick;
    d.gray = 0;
    const k = w.fighters[owner];
    if (k && k !== d && k.team !== d.team && w.tick - d.lastAtkTick <= KILL_CREDIT) k.kills++;
    w.events.push({ t: 'kill', x: d.x, y: d.y, z: d.z, by: owner, id: d.id });
  }
  if (d.state === S.STUN) d.bdef = 0;
  const knock = d.fall >= 100 || d.hp <= 0 || d.y > 0;
  // 霸體:只擋近戰輕攻擊(不擋射彈與投技),不打斷招式(仍扣血、累積 fall)
  if (!isProj && itr.kind !== 'grab' && itr.fall < 35 && !knock && armorNow(d, def)) return 'hit';
  d.move = null;
  d.ult = 0;
  d.hf = -1;
  d.hm = null;
  d.face = -dirAway;
  d.vx = dirAway * toFx(itr.kx);
  d.vz = 0;
  if (knock) {
    const wasFall = d.state === S.FALL;
    d.state = S.FALL;
    d.st = 0;
    d.fall = 0;
    d.vy = toFx(Math.max(itr.ky || 0, wasFall ? 3 : 5));
    if (!wasFall) {
      d.airHits = 0;
      if (def.hasUlt && w.ult.on) d.rage = Math.min(RAGE_MAX, d.rage + 5 * FX); // 被擊倒 +5
    }
    if (d.y === 0) d.y = 1;
  } else {
    d.state = S.HURT;
    d.st = 0;
    let stun = itr.stun;
    if (stun >= LONG_STUN || itr.lock) {
      // 控制遞減(E4):3 s 內第二次(含)長硬直減半;擒抓(lock)不減,但會刷新計時
      if (!itr.lock && d.ctlT > 0 && w.tick + 1 - d.ctlT < CTL_WINDOW) stun = Math.floor(stun / 2);
      d.ctlT = w.tick + 1;
    }
    d.stunT = stun;
  }
  return 'hit';
}

// ---- 每 tick 更新 ----
export function updateFighter(f, w, inb) {
  const def = w.defs[f.charId];
  if ((inb & (BIT.LEFT | BIT.RIGHT)) === (BIT.LEFT | BIT.RIGHT)) inb &= ~(BIT.LEFT | BIT.RIGHT);
  if ((inb & (BIT.UP | BIT.DOWN)) === (BIT.UP | BIT.DOWN)) inb &= ~(BIT.UP | BIT.DOWN);
  const pr = (inb & ~f.prev) | f.pend;
  f.prev = inb;
  f.hist.push(inb);
  if (f.hist.length > 16) f.hist.shift();

  f.hf = -1;
  f.hm = null;
  if (f.state === S.DEAD) return;
  if (f.ult === 1) {
    f.pend = 0; // 排隊中:無敵待命,等演出
    return;
  }
  if (f.hitstop > 0) {
    f.hitstop--;
    f.pend = pr;
    return;
  }
  f.pend = 0;

  // 計時與回復
  f.sinceHit++;
  if (f.inv > 0) f.inv--;
  if (f.silence > 0) f.silence--;
  if (f.bufT > 0) {
    f.bufT--;
    if (f.bufT === 0) f.aftT = def.buffs[f.buf] && def.buffs[f.buf].after ? def.buffs[f.buf].after.dur : 0;
  } else if (f.aftT > 0) f.aftT--;
  if (f.bufT === 0 && f.aftT === 0) f.buf = '';
  if (f.sinceHit > 20 && f.fall > 0) f.fall--;
  if (f.sinceHit > 30 && f.bdef > 0 && (f.sinceHit & 1) === 0) f.bdef--;
  if (f.sinceHit >= HEAL_DELAY && f.gray > 0 && !f.dead) {
    const heal = Math.min(f.gray, Math.round((10 * FX) / 60));
    f.hp += heal;
    f.gray -= heal;
  }
  if (f.rollCd > 0) f.rollCd--;
  const missing10 = Math.floor(((def.hp - f.hp) * 10) / def.hp);
  f.mp = Math.min(def.mp, f.mp + Math.floor((def.mpRegen * (10 + missing10)) / 10));

  if (ultTrigger(f, def, w)) return;

  const dirX = (inb & BIT.RIGHT ? 1 : 0) - (inb & BIT.LEFT ? 1 : 0);
  const dirZ = (inb & BIT.DOWN ? 1 : 0) - (inb & BIT.UP ? 1 : 0);
  f.vz = 0;

  switch (f.state) {
    case S.IDLE:
    case S.WALK:
      groundFree(f, def, w, pr, inb, dirX, dirZ);
      break;

    case S.RUN:
      if (pr & BIT.JUMP) startJump(f, def, dirX, true);
      else if (pr & BIT.ATK) {
        startMove(f, def, w, 'runatk', S.ATTACK);
        stepAttack(f, def, w);
      } else if (dirX === 0) {
        f.state = S.IDLE;
        f.vx = 0;
      } else if (dirX !== f.face) {
        f.state = S.RUNSTOP;
        f.st = 0;
      } else {
        f.vx = f.face * spdAdj(f, def, def.runX);
        f.vz = dirZ * spdAdj(f, def, def.runZ);
      }
      break;

    case S.RUNSTOP:
      f.vx = Math.floor((f.face * def.runX * (def.runStop - f.st)) / def.runStop);
      if (f.st >= def.runStop) {
        f.state = S.IDLE;
        f.vx = 0;
      }
      break;

    case S.SQUAT:
      f.vx = 0;
      if (f.st >= def.squat) {
        f.state = f.nextState;
        f.st = 0;
        f.vy = f.nextState === S.DASH ? def.dashVy : def.jumpVy;
        f.vx = f.takeoffVx;
      }
      break;

    case S.JUMP:
    case S.DASH:
      if (!f.move && pr & BIT.ATK) startMove(f, def, w, f.state === S.DASH ? 'dashatk' : 'jumpatk');
      if (f.move) stepMove(f, def, w, true);
      f.y += f.vy;
      f.vy -= def.gravity;
      if (f.y <= 0 && f.vy < 0) {
        f.y = 0;
        f.vy = 0;
        f.vx = 0;
        f.move = null;
        f.state = S.IDLE;
      }
      break;

    case S.ATTACK:
    case S.SPECIAL:
      stepAttack(f, def, w, pr);
      break;

    case S.DEFEND:
      defendActions(f, def, w, pr, inb);
      break;

    case S.ROLL:
      if (f.st < def.roll.specialCancel && pr & (BIT.ATK | BIT.JUMP) && tryCommand(f, def, w, pr)) {
        stepAttack(f, def, w);
        break;
      }
      f.vx = f.getupDir * def.roll.speed;
      if (f.st >= def.roll.dur) {
        f.state = S.IDLE;
        f.vx = 0;
        f.rollCd = def.roll.cd;
      }
      break;

    case S.HURT:
      f.vx = Math.trunc((f.vx * 3) / 4);
      if (f.st >= f.stunT) {
        f.state = S.IDLE;
        f.vx = 0;
      }
      break;

    case S.FALL:
      f.y += f.vy;
      f.vy -= def.gravity;
      if (f.y <= 0 && f.vy <= 0) knockLand(f);
      break;

    case S.LYING:
      f.vx = 0;
      if (pr & BIT.LEFT) f.getupDir = -1;
      else if (pr & BIT.RIGHT) f.getupDir = 1;
      if (f.st >= def.lying) {
        if (f.hp <= 0) {
          if (w.mode.type === 'practice') {
            f.hp = def.hp;
            f.gray = 0;
            f.dead = false;
          } else {
            f.state = S.DEAD;
            f.st = 0;
            break;
          }
        }
        f.state = S.GETUP;
        f.st = 0;
        if (f.getupDir) f.face = f.getupDir;
      }
      break;

    case S.GETUP:
      f.vx = f.getupDir * def.roll.speed;
      if (f.st >= def.getup) {
        f.state = S.IDLE;
        f.vx = 0;
        f.getupDir = 0;
      }
      break;

    case S.STUN:
      f.vx = 0;
      if (f.st >= def.stun) f.state = S.IDLE;
      break;
  }

  f.x += f.vx;
  f.z += f.vz;
  f.x = clamp(f.x, 16 * FX, (w.stage.w - 16) * FX);
  f.z = clamp(f.z, 0, w.stage.d * FX);
  f.st++;
}

// 重生(時間賽):由 modes.js 呼叫
export function respawnFighter(f, def, x, z) {
  f.hp = def.hp;
  f.gray = 0;
  f.mp = def.mpStart;
  f.dead = false;
  f.state = S.IDLE;
  f.st = 0;
  f.x = toFx(x);
  f.z = toFx(z);
  f.y = 0;
  f.vx = 0;
  f.vy = 0;
  f.fall = 0;
  f.bdef = 0;
  f.move = null;
  f.inv = 120;
  f.hitstop = 0;
  f.silence = 0;
  f.sinceHit = 999;
  f.ctlT = 0;
  f.rage = Math.floor(f.rage / 2); // 時間賽復活保留 50% 爆氣
  f.ult = 0;
  f.ultGuard = 0;
  f.held = -1;
  f.buf = '';
  f.bufT = 0;
  f.aftT = 0;
}

function groundFree(f, def, w, pr, inb, dirX, dirZ) {
  if (tryCommand(f, def, w, pr)) {
    stepAttack(f, def, w);
    return;
  }
  if (pr & BIT.JUMP) {
    startJump(f, def, dirX, false);
    return;
  }
  if (pr & BIT.ATK) {
    startMove(f, def, w, 'attack1', S.ATTACK);
    stepAttack(f, def, w);
    return;
  }
  if (inb & BIT.DEF) {
    f.state = S.DEFEND;
    f.st = 0;
    f.vx = 0;
    defendActions(f, def, w, pr, inb);
    return;
  }
  // 連按同向兩次 → 跑
  const edge = pr & BIT.LEFT ? -1 : pr & BIT.RIGHT ? 1 : 0;
  if (edge) {
    if (f.tapDir === edge && w.tick - f.tapT <= DOUBLE_TAP) {
      f.state = S.RUN;
      f.st = 0;
      f.face = edge;
      f.vx = f.face * def.runX;
      f.vz = dirZ * def.runZ;
      f.tapDir = 0;
      return;
    }
    f.tapDir = edge;
    f.tapT = w.tick;
  }
  if (dirX) f.face = dirX;
  f.vx = dirX * spdAdj(f, def, def.walkX);
  f.vz = dirZ * spdAdj(f, def, def.walkZ);
  f.state = dirX || dirZ ? S.WALK : S.IDLE;
}

function defendActions(f, def, w, pr, inb) {
  if (!(inb & BIT.DEF)) {
    f.state = S.IDLE;
    f.vx = 0;
    return;
  }
  if (tryCommand(f, def, w, pr)) {
    stepAttack(f, def, w);
    return;
  }
  if (pr & (BIT.LEFT | BIT.RIGHT) && f.rollCd === 0) {
    startRoll(f, pr & BIT.LEFT ? -1 : 1);
    f.vx = f.getupDir * def.roll.speed;
    return;
  }
  f.vx = Math.trunc((f.vx * 3) / 4);
}

// 攻擊/必殺:取消窗內可接下一段或必殺
function stepAttack(f, def, w, pr) {
  if (f.ult === 1) return;
  if (f.state === S.JUMP) return; // 空中必殺(大跳壓)由空中分支推進
  if (pr && f.move) {
    const m = def.moves[f.move];
    if (m.total - f.mtot <= m.cancel) {
      if (tryCommand(f, def, w, pr)) {
        if (f.state === S.JUMP) return;
      } else if (pr & BIT.ATK && m.next) {
        startMove(f, def, w, m.next, S.ATTACK);
      }
    }
  }
  if (stepMove(f, def, w, false)) {
    f.state = S.IDLE;
    f.vx = 0;
    f.ult = 0;
  }
}
