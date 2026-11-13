import { BIT } from '../core/input.js';
import { FX, toFx, clamp } from '../core/fixed.js';
import { detectCommand } from './command.js';
import { spawnProjectile } from './projectiles.js';

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
    body: j.body, moves: {}, projectiles: {}
  };
  for (const name in j.moves) {
    const m = j.moves[name];
    const frames = m.frames.map((f) => ({
      wait: f.wait, mvx: toFx(f.mvx || 0), itr: f.itr || null,
      spawn: f.spawn ? [].concat(f.spawn) : null, tp: f.tp || 0, counter: !!f.counter
    }));
    d.moves[name] = {
      frames, next: m.next || null, cancel: m.cancel || 0, cost: toFx(m.cost || 0),
      launch: m.launch ? { vx: toFx(m.launch.vx), vy: toFx(m.launch.vy) } : null,
      total: frames.reduce((s, f) => s + f.wait, 0)
    };
  }
  for (const name in j.projectiles || {}) {
    const p = j.projectiles[name];
    d.projectiles[name] = {
      vx: toFx(p.vx || 0), life: p.life, chase: toFx(p.chase || 0), bdy: p.bdy || null,
      itr: p.itr || null, wall: !!p.wall, zone: p.zone || null
    };
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
    hitstop: 0, rollCd: 0, getupDir: 0, stunT: 0, airHits: 0, inv: 0, silence: 0,
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

function teleport(f, w, range) {
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
    if (fr.tp) teleport(f, w, fr.tp);
    if (fr.spawn) for (const sp of fr.spawn) spawnProjectile(w, f, def, sp);
  }
  if (!air) f.vx = f.face * fr.mvx;
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
  if (!isProj && d.state === S.SPECIAL && d.move && def.moves.counter && def.moves[d.move].frames[d.mf].counter) {
    d.face = -dirAway;
    startMove(d, def, w, 'counter', S.SPECIAL);
    return 'counter';
  }

  if (itr.kind !== 'grab' && d.state === S.DEFEND && -dirAway === d.face) {
    // 防住正面:傷害只吃 10%(擦傷不致死),累積 bdef
    d.hp = Math.max(FX, d.hp - Math.floor((itr.dmg * FX) / 10));
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
  // 霸體:輕攻擊不打斷普攻(仍扣血、累積 fall)
  if (def.armor && d.state === S.ATTACK && itr.fall < 35 && !knock) return 'hit';
  d.move = null;
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
    if (!wasFall) d.airHits = 0;
    if (d.y === 0) d.y = 1;
  } else {
    d.state = S.HURT;
    d.st = 0;
    d.stunT = itr.stun;
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
        f.vx = f.face * def.runX;
        f.vz = dirZ * def.runZ;
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
  f.vx = dirX * def.walkX;
  f.vz = dirZ * def.walkZ;
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
  }
}
