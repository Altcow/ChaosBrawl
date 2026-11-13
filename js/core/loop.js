// 固定 60Hz 時步:累加器,單幀最多補 4 tick
export const TICK_MS = 1000 / 60;
const MAX_CATCHUP = 4;

export class Loop {
  constructor(step, render) {
    this.step = step;
    this.render = render;
    this.acc = 0;
    this.last = 0;
    this.paused = true;
    this.fps = 0;
    this._frames = 0;
    this._fpsT = 0;
    this.tps = 0;
    this._ticks = 0;
    this._frame = this._frame.bind(this);
  }
  start() {
    requestAnimationFrame(this._frame);
  }
  setPaused(p) {
    this.paused = p;
    this.acc = 0;
    this.last = 0;
  }
  _frame(t) {
    requestAnimationFrame(this._frame);
    if (!this.last) this.last = t;
    const dt = Math.min(t - this.last, 250);
    this.last = t;
    if (!this.paused) {
      this.acc += dt;
      let n = 0;
      while (this.acc >= TICK_MS && n < MAX_CATCHUP) {
        this.step();
        this.acc -= TICK_MS;
        n++;
      }
      if (n === MAX_CATCHUP) this.acc = 0;
      this._ticks += n;
    }
    this.render(this.paused ? 1 : this.acc / TICK_MS);
    this._frames++;
    if (t - this._fpsT >= 1000) {
      this.fps = this._frames;
      this.tps = this._ticks;
      this._frames = 0;
      this._ticks = 0;
      this._fpsT = t;
    }
  }
}
