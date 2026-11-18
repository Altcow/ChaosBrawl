// 輸入:鍵盤 / 手把 / 觸控 → 7 bit 位元組。來源:P1(鍵盤 WASD + 觸控)、P2(鍵盤方向鍵)、G1~G4(手把)
export const BIT = { UP: 1, DOWN: 2, LEFT: 4, RIGHT: 8, ATK: 16, JUMP: 32, DEF: 64 };

const KEYMAPS = {
  P1: { KeyW: BIT.UP, KeyS: BIT.DOWN, KeyA: BIT.LEFT, KeyD: BIT.RIGHT, KeyJ: BIT.ATK, KeyK: BIT.JUMP, KeyL: BIT.DEF },
  P2: { ArrowUp: BIT.UP, ArrowDown: BIT.DOWN, ArrowLeft: BIT.LEFT, ArrowRight: BIT.RIGHT, Numpad1: BIT.ATK, Numpad2: BIT.JUMP, Numpad3: BIT.DEF }
};
const PAD_DEAD = 0.35;
const ULT_KEY = 'KeyU'; // P1 鍵盤大招(也可防+攻+跳同時按);手把 Y(button 3)
const ULT_KEY_P2 = 'Numpad4';
const ULT_BITS = [BIT.DEF | BIT.ATK | BIT.JUMP, 0]; // 同 sim/ult.js ULT_MACRO(core 不反向 import sim)

export class Input {
  constructor() {
    this.keys = { P1: 0, P2: 0 };
    this.touch = 0;
    this.macros = {};
    this.runq = {};
    this.padY = {};
  }
  attach() {
    window.addEventListener('keydown', (e) => {
      if (!e.repeat && (e.code === ULT_KEY || e.code === ULT_KEY_P2)) {
        this.queueMacro(e.code === ULT_KEY ? 'P1' : 'P2', ULT_BITS);
        e.preventDefault();
      }
      for (const src in KEYMAPS) {
        const b = KEYMAPS[src][e.code];
        if (b) {
          this.keys[src] |= b;
          e.preventDefault();
        }
      }
    });
    window.addEventListener('keyup', (e) => {
      for (const src in KEYMAPS) {
        const b = KEYMAPS[src][e.code];
        if (b) {
          this.keys[src] &= ~b;
          e.preventDefault();
        }
      }
    });
    window.addEventListener('blur', () => this.clear());
  }
  setTouch(bits) {
    this.touch = bits;
  }
  // 排入一串逐 tick 的輸入(觸控必殺輔助鍵用)
  queueMacro(src, bytes) {
    this.macros[src] = bytes.slice();
  }
  // 觸控自動跑:把左右方向在接下來幾個 tick 內「放開、按下、放開、按下」,等於連點兩下(引擎判讀為跑)
  queueRun(src) {
    const q = [];
    for (let i = 0; i < 3; i++) q.push(1);
    for (let i = 0; i < 3; i++) q.push(0);
    for (let i = 0; i < 3; i++) q.push(1);
    this.runq[src] = q;
  }
  clear() {
    this.keys.P1 = 0;
    this.keys.P2 = 0;
    this.touch = 0;
    this.macros = {};
    this.runq = {};
  }
  _pad(n) {
    const list = navigator.getGamepads ? navigator.getGamepads() : [];
    let k = 0;
    let gp = null;
    for (let i = 0; i < list.length; i++) {
      if (list[i] && list[i].connected) {
        if (k === n) {
          gp = list[i];
          break;
        }
        k++;
      }
    }
    let b = 0;
    if (gp) {
      const pressed = (i) => !!(gp.buttons[i] && gp.buttons[i].pressed);
      const ax = gp.axes[0] || 0;
      const ay = gp.axes[1] || 0;
      if (pressed(12) || ay < -PAD_DEAD) b |= BIT.UP;
      if (pressed(13) || ay > PAD_DEAD) b |= BIT.DOWN;
      if (pressed(14) || ax < -PAD_DEAD) b |= BIT.LEFT;
      if (pressed(15) || ax > PAD_DEAD) b |= BIT.RIGHT;
      if (pressed(2)) b |= BIT.ATK; // X(□)
      if (pressed(0)) b |= BIT.JUMP; // A(×)
      if (pressed(1) || pressed(5)) b |= BIT.DEF; // B(○) / RB
      const y = pressed(3); // Y(△):按下瞬間排入大招
      if (y && !this.padY[n]) this.queueMacro('G' + (n + 1), ULT_BITS);
      this.padY[n] = y;
    }
    return b;
  }
  // 每 tick 每個來源讀一次
  read(src) {
    let b = 0;
    if (src === 'P1') b = this.keys.P1 | this.touch;
    else if (src === 'P2') b = this.keys.P2;
    else if (src && src[0] === 'G') b = this._pad(parseInt(src.slice(1), 10) - 1);
    const rq = this.runq[src];
    if (rq && rq.length && rq.shift()) b &= ~(BIT.LEFT | BIT.RIGHT);
    const m = this.macros[src];
    if (m && m.length) b |= m.shift();
    return b;
  }
}
