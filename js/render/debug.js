import { px } from '../core/fixed.js';
import { boxRect } from '../sim/hit.js';

// 盒子除錯顯示:藍 = bdy、紅 = itr(含 z 容許帶)
export function drawBoxes(ctx, w, camX, floorY) {
  const rect = (r, z, color, fill) => {
    const sx = r.x0 - camX;
    const sy = floorY + z - r.y1;
    ctx.strokeStyle = color;
    ctx.fillStyle = fill;
    ctx.lineWidth = 1;
    ctx.fillRect(sx, sy, r.x1 - r.x0, r.y1 - r.y0);
    ctx.strokeRect(sx + 0.5, sy + 0.5, r.x1 - r.x0, r.y1 - r.y0);
  };
  for (const f of w.fighters) {
    const def = w.defs[f.charId];
    rect(boxRect(px(f.x), px(f.y), f.face, def.body), px(f.z), '#4af', 'rgba(70,170,255,0.18)');
    if (f.hf >= 0 && f.hm) {
      const fr = def.moves[f.hm].frames[f.hf];
      for (const itr of fr.itr || []) {
        const r = boxRect(px(f.x), px(f.y), f.face, itr);
        rect(r, px(f.z), '#f44', 'rgba(255,60,60,0.3)');
        // z 容許帶:腳底高度上的橫帶
        ctx.fillStyle = 'rgba(255,60,60,0.18)';
        ctx.fillRect(r.x0 - camX, floorY + px(f.z) - itr.zr, r.x1 - r.x0, itr.zr * 2);
      }
    }
  }
  for (const p of w.projectiles) {
    const pd = w.defs[p.ch].projectiles[p.kind];
    if (pd.itr) rect(boxRect(px(p.x), px(p.y), p.face, pd.itr), px(p.z), '#f44', 'rgba(255,60,60,0.3)');
    else if (pd.bdy) rect(boxRect(px(p.x), px(p.y), p.face, pd.bdy), px(p.z), '#4af', 'rgba(70,170,255,0.18)');
  }
}
