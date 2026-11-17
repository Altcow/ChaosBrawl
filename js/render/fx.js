// 命中火花(僅繪圖用,不進模擬狀態)
export class Fx {
  constructor() {
    this.list = [];
    this.shake = 0; // 畫面震動剩餘 tick(招式格 shake 事件,E3)
  }
  clear() {
    this.list.length = 0;
    this.shake = 0;
  }
  add(e) {
    if (e.t === 'ult') return; // 大招演出由 render/ult.js 讀 w.ult 畫
    if (e.t === 'shake') {
      this.shake = Math.max(this.shake, e.n || 0);
      return;
    }
    this.list.push({ t: e.t, x: e.x, y: e.y, z: e.z, age: 0, big: e.big });
  }
  // 畫面震動位移 px(隨剩餘 tick 衰減)
  shakeOff() {
    if (this.shake <= 0) return { x: 0, y: 0 };
    const a = Math.min(7, this.shake / 3);
    return { x: Math.sin(this.shake * 2.9) * a, y: Math.cos(this.shake * 3.7) * a * 0.6 };
  }
  tick() {
    if (this.shake > 0) this.shake--;
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
