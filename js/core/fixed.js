// 定點數:1 px = 256 單位(整數)
export const FX = 256;
export const toFx = (v) => Math.round(v * FX);
export const px = (v) => v >> 8;
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const sign = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);
