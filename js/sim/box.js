// 盒子:x 相對腳底、朝右為正;y 為高度。回傳世界座標(px)矩形
export function boxRect(ox, oy, face, b) {
  const x0 = face > 0 ? ox + b.x : ox - b.x - b.w;
  return { x0, x1: x0 + b.w, y0: oy + b.y, y1: oy + b.y + b.h };
}

export function overlaps(a, b) {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}
