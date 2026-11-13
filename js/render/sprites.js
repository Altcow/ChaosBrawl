import { S } from '../sim/fighter.js';

// 佔位人形:色塊 + 頭 + 手臂;依狀態改姿勢
const STATE_TINT = {
  [S.HURT]: '#e05050', [S.STUN]: '#d0d040', [S.FALL]: '#e05050'
};

export function drawFighter(ctx, f, def, sx, sy, face, hitFlash) {
  const body = def.color;
  const lying = f.state === S.LYING || f.state === S.FALL || f.state === S.GETUP;
  ctx.save();
  ctx.translate(sx, sy);
  // 影子(貼地,不隨跳躍)由呼叫端畫
  if (lying) {
    ctx.rotate((face > 0 ? -1 : 1) * (f.state === S.GETUP ? 0.7 : 1.45));
  } else if (f.state === S.SQUAT) {
    ctx.scale(1.1, 0.85);
  } else if (f.state === S.ROLL) {
    ctx.translate(0, -16);
    ctx.rotate(face * (f.st * 0.7));
    ctx.translate(0, 16);
    ctx.scale(1, 0.55);
  }
  const color = hitFlash ? '#ffffff' : STATE_TINT[f.state] || body;
  ctx.fillStyle = color;
  ctx.fillRect(-12, -46, 24, 34); // 身
  ctx.fillRect(-10, -14, 8, 14); // 腿
  ctx.fillRect(2, -14, 8, 14);
  ctx.fillStyle = '#f2d2a8';
  ctx.beginPath();
  ctx.arc(0, -54, 10, 0, Math.PI * 2); // 頭
  ctx.fill();
  ctx.fillStyle = '#222';
  ctx.fillRect(face > 0 ? 3 : -7, -57, 4, 4); // 眼
  // 手臂
  ctx.strokeStyle = color;
  ctx.lineWidth = 6;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(0, -40);
  if (f.move && f.hf >= 0) ctx.lineTo(face * 38, -34);
  else if (f.state === S.DEFEND) ctx.lineTo(face * 14, -44);
  else if (f.state === S.WALK || f.state === S.RUN) ctx.lineTo(face * 6 * (f.st & 8 ? 1 : -1), -26);
  else ctx.lineTo(face * 4, -26);
  ctx.stroke();
  if (f.state === S.DEFEND) {
    ctx.strokeStyle = '#6cf';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(face * 16, -30, 24, -1.2, 1.2);
    ctx.stroke();
  }
  ctx.restore();
}
