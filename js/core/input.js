// 輸入:鍵盤 / 手把 / 觸控 → 7 bit 位元組。來源:P1(鍵盤 WASD + 觸控)、P2(鍵盤方向鍵)、G1~G4(手把)
export const BIT = { UP: 1, DOWN: 2, LEFT: 4, RIGHT: 8, ATK: 16, JUMP: 32, DEF: 64 };

const KEYMAPS = {
  P1: { KeyW: BIT.UP, KeyS: BIT.DOWN, KeyA: BIT.LEFT, KeyD: BIT.RIGHT, KeyJ: BIT.ATK, KeyK: BIT.JUMP, KeyL: BIT.DEF },
  P2: { ArrowUp: BIT.UP, ArrowDown: BIT.DOWN, ArrowLeft: BIT.LEFT, ArrowRight: BIT.RIGHT, Numpad1: BIT.ATK, Numpad2: BIT.JUMP, Numpad3: BIT.DEF }
};
const PAD_DEAD = 0.35;

export class Input {
  constructor() {
    this.keys = { P1: 0, P2: 0 };
    this.touch = 0;
    this.macros = {};
  }
  attach() {
    window.addEventListener('keydown', (e) => {
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
  clear() {
    this.keys.P1 = 0;
    this.keys.P2 = 0;
    this.touch = 0;
    this.macros = {};
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
    }
    return b;
  }
  // 每 tick 每個來源讀一次
  read(src) {
    let b = 0;
    if (src === 'P1') b = this.keys.P1 | this.touch;
    else if (src === 'P2') b = this.keys.P2;
    else if (src && src[0] === 'G') b = this._pad(parseInt(src.slice(1), 10) - 1);
    const m = this.macros[src];
    if (m && m.length) b |= m.shift();
    return b;
  }
}
