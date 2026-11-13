import { toFx, px, clamp } from '../core/fixed.js';
import { boxRect, overlaps } from './box.js';

// 射彈 / 場地物件(書牆、安靜圈):獨立物件,有自己的 bdy / itr
export function spawnProjectile(w, owner, def, spec) {
  const pd = def.projectiles[spec.proj];
  if (!pd) return;
  if (pd.limit) {
    // 場上限制(例:避雷針只能有 1 支):超過就清掉本人最舊的同種射彈
    const mine = w.projectiles.filter((q) => q.owner === owner.id && q.kind === spec.proj && !q.dead);
    for (let i = 0; i <= mine.length - pd.limit; i++) mine[i].dead = true;
  }
  const p = {
    id: w.nextSeq++,
    owner: owner.id,
    ch: owner.charId,
    kind: spec.proj,
    x: owner.x + owner.face * toFx(spec.x || 0),
    y: owner.y + toFx(spec.y || 0),
    z: owner.z + toFx(spec.dz || 0),
    face: owner.face,
    vx: owner.face * pd.vx,
    vz: toFx(spec.vz || 0),
    life: pd.life,
    dead: false,
    hitLog: {}
  };
  if (owner.ult === 2 && owner.move === 'ultimate') p.ult = owner.ultSeq; // 大招射彈:帶發動序號,供傷害上限與保護判斷
  w.projectiles.push(p);
}

// 迴力射彈(D3):去程飛 life tick(或碰到場邊)後折返,朝本人目前位置飛回,到手消失;去、回各自重置命中紀錄,所以各可中一次。
// 去 / 回程不另存欄位(連線快照的射彈欄位固定):回程時 life 加上 BACK_LIFE,life >= BACK_LIFE 即回程
export const BACK_LIFE = 1000;
export const isBack = (p) => p.life >= BACK_LIFE;
function stepBoomerang(w, p, pd) {
  const o = w.fighters[p.owner];
  if (!isBack(p)) {
    p.x += p.vx;
    p.z = clamp(p.z + p.vz, 0, w.stage.d * 256);
    p.life--;
    if (p.life <= 0 || px(p.x) < 0 || px(p.x) > w.stage.w) {
      p.hitLog = {};
      p.life = BACK_LIFE + pd.life * 2 + 120; // 回程保險:本人跑太遠 / 追不到就消失
      p.vz = 0;
    }
    return;
  }
  p.life--;
  if (!o || o.dead || p.life <= BACK_LIFE) {
    p.dead = true;
    return;
  }
  const dx = o.x - p.x;
  const dz = o.z - p.z;
  const sx = Math.min(pd.backVx, Math.abs(dx));
  const sz = Math.min(pd.backVz, Math.abs(dz));
  p.x += dx >= 0 ? sx : -sx;
  p.z += dz >= 0 ? sz : -sz;
  p.face = dx >= 0 ? 1 : -1;
  p.vx = p.face * pd.backVx;
  if (Math.abs(o.x - p.x) <= pd.backVx && Math.abs(o.z - p.z) <= toFx(8)) p.dead = true; // 回到手上
}

export function stepProjectiles(w) {
  for (const p of w.projectiles) {
    const pd = w.defs[p.ch].projectiles[p.kind];
    if (pd.boomerang) {
      stepBoomerang(w, p, pd);
      continue;
    }
    if (pd.zone) {
      for (const f of w.fighters) {
        if (f.id === p.owner || f.dead || f.team === w.fighters[p.owner].team) continue;
        if (Math.abs(px(f.x - p.x)) <= pd.zone.r && Math.abs(px(f.z - p.z)) <= pd.zone.zr) f.silence = Math.max(f.silence, 3);
      }
    }
    if (pd.chase > 0) {
      let best = null;
      let bd = 1 << 30;
      for (const f of w.fighters) {
        if (f.id === p.owner || f.dead || (w.mode.ff !== 2 && f.team === w.fighters[p.owner].team)) continue;
        const d = Math.abs(f.x - p.x);
        if (d < bd) {
          bd = d;
          best = f;
        }
      }
      if (best) {
        const dz = best.z - p.z;
        if (dz > pd.chase) p.z += pd.chase;
        else if (dz < -pd.chase) p.z -= pd.chase;
        else p.z = best.z;
      }
    }
    p.x += p.vx;
    p.z += p.vz;
    p.life--;
    if (p.life <= 0 || px(p.x) < 0 || px(p.x) > w.stage.w || px(p.z) < -20 || px(p.z) > w.stage.d + 20) p.dead = true;
  }
  // 書牆擋射彈
  for (const q of w.projectiles) {
    const qd = w.defs[q.ch].projectiles[q.kind];
    if (!qd.wall || q.dead) continue;
    const wr = boxRect(px(q.x), px(q.y), q.face, qd.bdy);
    for (const p of w.projectiles) {
      if (p === q || p.dead || w.fighters[p.owner].team === w.fighters[q.owner].team) continue;
      const pd = w.defs[p.ch].projectiles[p.kind];
      if (!pd.itr) continue;
      if (Math.abs(px(p.z - q.z)) > qd.bdy.zr) continue;
      if (overlaps(wr, boxRect(px(p.x), px(p.y), p.face, pd.itr))) p.dead = true;
    }
  }
  w.projectiles = w.projectiles.filter((p) => !p.dead);
}
