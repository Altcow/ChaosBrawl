// 命中火花(僅繪圖用,不進模擬狀態)
export class Fx {
  constructor() {
    this.list = [];
  }
  clear() {
    this.list.length = 0;
  }
  add(e) {
    if (e.t === 'ult') return; // 大招演出由 render/ult.js 讀 w.ult 畫
    this.list.push({ t: e.t, x: e.x, y: e.y, z: e.z, age: 0, big: e.big });
  }
  tick() {
    for (const s of this.list) s.age++;
    this.list = this.list.filter((s) => s.age < 14);
  }
  draw(ctx, camX, floorY) {
    for (const s of this.list) {
      const sx = s.x / 256 - camX;
      const sy = floorY + s.z / 256 - s.y / 256;
      const r = (s.big ? 22 : 14) * (0.5 + s.age / 14);
      ctx.save();
      ctx.translate(sx, sy);
      ctx.strokeStyle = s.t === 'block' ? '#8cf' : '#ffe26a';
      ctx.globalAlpha = 1 - s.age / 14;
      ctx.lineWidth = 3;
      ctx.beginPath();
      for (let i = 0; i < 8; i++) {
        const a = (i * Math.PI) / 4;
        ctx.moveTo(Math.cos(a) * r * 0.4, Math.sin(a) * r * 0.4);
        ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      ctx.stroke();
      ctx.restore();
    }
  }
}
