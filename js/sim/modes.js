import { S, respawnFighter } from './fighter.js';

// 模式規則(草案 4-1):大亂鬥 = 單命、5 分鐘;時間賽 = 3 分鐘、倒下 3 s 重生(無敵 2 s)、同分加賽 30 s
export const MODE_DEF = {
  practice: { limit: 0 },
  brawl: { limit: 18000 },
  team: { limit: 18000 },
  timed: { limit: 10800, respawn: 180, overtime: 1800 }
};

// ff:友軍傷害 0 = 關、1 = 部分(射彈/投擲物/爆炸/陷阱會中、近戰穿過)、2 = 全開(草案 1-8)
export function initMode(w, type, ff) {
  w.mode = { type, t: 0, limit: MODE_DEF[type].limit, over: false, winner: -1, overtime: false, ff: ff || 0 };
}

// 開局站位:兩側面對面站在舞台中段(座位 0 在左側面向右,座位 1 在右側面向左,依序輪流),
// 真人與電腦在同一個畫面區域內;sides 可指定每個座位站左(0)或右(1)(分隊戰讓同隊站同側)。
export function layoutSpawns(n, stage, sides) {
  const cx = Math.round(stage.w / 2);
  const side = [];
  for (let i = 0; i < n; i++) side.push(sides ? sides[i] % 2 : i % 2);
  const per = [0, 0];
  for (const s of side) per[s]++;
  const seen = [0, 0];
  const out = [];
  for (let i = 0; i < n; i++) {
    const s = side[i];
    const k = seen[s]++;
    const dx = 120 + (k % 2) * 70; // 兩欄交錯,避免疊在一起
    const z = Math.round(50 + ((k + 0.5) * 140) / Math.max(1, per[s]));
    out.push({ x: cx + (s ? dx : -dx), z, face: s ? -1 : 1 });
  }
  return out;
}

function finish(w, winner) {
  w.mode.over = true;
  w.mode.winner = winner;
  w.events.push({ t: 'over', winner });
}

export function stepMode(w) {
  const m = w.mode;
  if (m.type === 'practice' || m.over) return;
  m.t++;
  if (m.type === 'brawl') {
    const alive = w.fighters.filter((f) => !f.dead);
    if (w.fighters.length > 1 && alive.length <= 1) return finish(w, alive.length ? alive[0].id : -1);
    if (m.t >= m.limit) {
      let best = -1;
      let bv = -1;
      for (const f of alive) {
        const v = f.hp / w.defs[f.charId].hp;
        if (v > bv) {
          bv = v;
          best = f.id;
        }
      }
      finish(w, best);
    }
    return;
  }
  if (m.type === 'team') {
    // 分隊戰:最後存活的隊伍獲勝(winner = 隊伍編號);時間到比隊伍剩餘 HP% 總和
    const hp = {};
    for (const f of w.fighters) if (!f.dead) hp[f.team] = (hp[f.team] || 0) + f.hp / w.defs[f.charId].hp;
    const teams = Object.keys(hp);
    if (teams.length <= 1) return finish(w, teams.length ? parseInt(teams[0], 10) : -1);
    if (m.t >= m.limit) {
      let best = -1;
      let bv = -1;
      for (const t of teams) if (hp[t] > bv) { bv = hp[t]; best = parseInt(t, 10); }
      finish(w, best);
    }
    return;
  }
  // timed
  for (const f of w.fighters) {
    if (f.dead && f.state === S.DEAD && w.tick - f.deadTick >= MODE_DEF.timed.respawn) {
      respawnFighter(f, w.defs[f.charId], 100 + w.rng.int(w.stage.w - 200), w.rng.int(w.stage.d));
    }
  }
  if (m.t >= m.limit) {
    let top = -1;
    let tv = -1;
    let tie = false;
    for (const f of w.fighters) {
      if (f.kills > tv) {
        tv = f.kills;
        top = f.id;
        tie = false;
      } else if (f.kills === tv) tie = true;
    }
    if (tie && !m.overtime) {
      m.overtime = true;
      m.limit += MODE_DEF.timed.overtime;
    } else finish(w, tie ? -1 : top);
  }
}
