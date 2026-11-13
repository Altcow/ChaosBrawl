// 種子亂數 xorshift32,狀態為單一整數,可序列化
export class Rng {
  constructor(seed) {
    this.s = (seed | 0) || 1;
  }
  next() {
    let x = this.s;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.s = x | 0;
    return this.s >>> 0;
  }
  int(n) {
    return this.next() % n;
  }
  getState() {
    return this.s;
  }
  setState(s) {
    this.s = (s | 0) || 1;
  }
}
