import { drawFighter, drawProjectileArt, drawMoveFx } from './sprites.js';
import { drawUltOverlay } from './ult.js';
import { drawHud, drawOverhead, drawResult, SLOT_COLORS } from './hud.js';
import { drawBoxes } from './debug.js';
import { S } from '../sim/fighter.js';
import { Fx } from './fx.js';

export const LW = 800;
export const LH = 450;
const FLOOR_Y = 190; // z = 0 的畫面 y

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.fx = new Fx();
    this.debug = false;
    this.prev = [];
    this.k = 1;
    this.zoom = this.zoomMax || 1;
    this.camX = 0;
    this.resize();
  }
  // 16:9 邏輯解析度等比縮放;canvas 內部解析度依裝置像素比放大
  resize() {
    const view = this.canvas.parentElement;
    const vw = view.clientWidth;
    const vh = view.clientHeight;
    const s = Math.min(vw / LW, vh / LH);
    this.canvas.style.width = Math.floor(LW * s) + 'px';
    this.canvas.style.height = Math.floor(LH * s) + 'px';
    const k = Math.max(1, Math.min(3, Math.round(s * (window.devicePixelRatio || 1))));
    this.k = k;
    this.canvas.width = LW * k;
    this.canvas.height = LH * k;
  }
  capturePrev(w) {
    this.prev = w.fighters.map((f) => ({ x: f.x, y: f.y, z: f.z }));
  }
  // focus:鏡頭要框住的角色 id(本機玩家);空 = 全部存活角色
  draw(w, alpha, stats, focus, nameOf) {
    const ctx = this.ctx;
    const pos = (f, i) => {
      const p = this.prev[i] || f;
      return {
        x: (p.x + (f.x - p.x) * alpha) / 256,
        y: (p.y + (f.y - p.y) * alpha) / 256,
        z: (p.z + (f.z - p.z) * alpha) / 256
      };
    };
    // 鏡頭:框住本機玩家,縮放 0.6~1.0
    let list = (focus || []).filter((i) => w.fighters[i] && !w.fighters[i].dead);
    if (!list.length) list = w.fighters.map((f, i) => i).filter((i) => !w.fighters[i].dead);
    if (!list.length) list = [0];
    let minX = 1e9;
    let maxX = -1e9;
    for (const i of list) {
      const x = pos(w.fighters[i], i).x;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
    }
    const tz = Math.max(this.zoomMin || 0.6, Math.min(this.zoomMax || 1, LW / (maxX - minX + 360)));
    this.zoom += (tz - this.zoom) * 0.12;
    const zoom = this.zoom;
    const vw = LW / zoom;
    let tcam = (minX + maxX) / 2 - vw / 2;
    tcam = vw >= w.stage.w ? (w.stage.w - vw) / 2 : Math.max(0, Math.min(w.stage.w - vw, tcam));
    this.camX += (tcam - this.camX) * 0.2;
    const camX = this.camX;
    const ty = (LH * (1 - zoom)) / 2;

    ctx.setTransform(this.k, 0, 0, this.k, 0, 0);
    // 背景(全畫面):天空 + 地面底色
    const horizon = ty + FLOOR_Y * zoom;
    const g = ctx.createLinearGradient(0, 0, 0, horizon);
    g.addColorStop(0, '#1d2540');
    g.addColorStop(1, '#3a3f66');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, LW, horizon);
    ctx.fillStyle = '#4a4538';
    ctx.fillRect(0, horizon, LW, LH - horizon);

    ctx.setTransform(this.k * zoom, 0, 0, this.k * zoom, 0, this.k * ty);
    this._world(ctx, w, camX, vw);

    const order = w.fighters.map((f, i) => i).filter((i) => w.fighters[i].state !== S.DEAD).sort((a, b) => w.fighters[a].z - w.fighters[b].z);
    for (const i of order) {
      const f = w.fighters[i];
      const p = pos(f, i);
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.beginPath();
      ctx.ellipse(p.x - camX, FLOOR_Y + p.z, 18 - p.y / 14, 6, 0, 0, Math.PI * 2);
      ctx.fill();
      if (w.mode.type !== 'practice') {
        ctx.strokeStyle = SLOT_COLORS[f.team % 8];
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.ellipse(p.x - camX, FLOOR_Y + p.z, 20, 7, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    for (const i of order) {
      const f = w.fighters[i];
      const p = pos(f, i);
      const sx = p.x - camX;
      const sy = FLOOR_Y + p.z - p.y;
      ctx.globalAlpha = f.inv > 0 && (f.inv & 4) ? 0.4 : 1;
      drawMoveFx(ctx, f, w.defs[f.charId], sx, sy, f.face, true);
      drawFighter(ctx, f, w.defs[f.charId], sx, sy, f.face, f.hitstop > 0 && f.sinceHit < 6);
      drawMoveFx(ctx, f, w.defs[f.charId], sx, sy, f.face, false);
      ctx.globalAlpha = 1;
      if (i > 0 || w.mode.type !== 'practice') {
        // 頭上血條與縮放脫鉤:用畫面座標(寬度固定 44),位置貼在縮小後的頭頂上方
        ctx.save();
        ctx.setTransform(this.k, 0, 0, this.k, 0, 0);
        drawOverhead(ctx, w, f, sx * zoom, ty + sy * zoom - 64 * zoom - 12 + 78);
        ctx.restore();
      }
    }
    // 射彈與場地物件
    for (const pr of w.projectiles) {
      const pd = w.defs[pr.ch].projectiles[pr.kind];
      const sx = pr.x / 256 - camX;
      const sy = FLOOR_Y + pr.z / 256 - pr.y / 256;
      if (pd.zone) {
        ctx.strokeStyle = 'rgba(160,120,255,0.8)';
        ctx.fillStyle = 'rgba(160,120,255,0.12)';
        ctx.beginPath();
        ctx.ellipse(sx, sy, pd.zone.r, pd.zone.zr, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      } else if (pd.wall) {
        ctx.fillStyle = '#8a5a2a';
        ctx.fillRect(sx - 6, sy - 80, 12, 80);
      } else if (!drawProjectileArt(ctx, pr.ch, pr.kind, pr.life, sx, sy, pr.face)) {
        ctx.fillStyle = '#ffd24a';
        ctx.fillRect(sx - 8, sy - 8, 16, 16);
        ctx.strokeStyle = '#a60';
        ctx.strokeRect(sx - 7.5, sy - 7.5, 15, 15);
      }
    }
    this.fx.draw(ctx, camX, FLOOR_Y);
    if (this.debug) drawBoxes(ctx, w, camX, FLOOR_Y);

    ctx.setTransform(this.k, 0, 0, this.k, 0, 0);
    drawHud(ctx, w, stats, this.debug);
    drawUltOverlay(ctx, w);
    drawResult(ctx, w, nameOf || ((i) => '#' + (i + 1)));
  }
  _world(ctx, w, camX, vw) {
    // 遠景色塊(視差 0.4)
    ctx.fillStyle = '#2b3052';
    for (let i = 0; i < 24; i++) {
      const bx = i * 140 - ((camX * 0.4) % 3360) - 140;
      ctx.fillRect(bx, FLOOR_Y - 60 - ((i * 37) % 50), 90, 120);
    }
    ctx.fillStyle = '#4a4538';
    ctx.fillRect(-camX, FLOOR_Y, w.stage.w, w.stage.d);
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineWidth = 1;
    for (let z = 0; z <= w.stage.d; z += 40) {
      ctx.beginPath();
      ctx.moveTo(-camX, FLOOR_Y + z + 0.5);
      ctx.lineTo(w.stage.w - camX, FLOOR_Y + z + 0.5);
      ctx.stroke();
    }
    for (let x = 0; x <= w.stage.w; x += 100) {
      ctx.beginPath();
      ctx.moveTo(x - camX + 0.5, FLOOR_Y);
      ctx.lineTo(x - camX + 0.5, FLOOR_Y + w.stage.d);
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.strokeRect(-camX + 0.5, FLOOR_Y + 0.5, w.stage.w, w.stage.d);
  }
}
