// 手勢辨識器(純邏輯,不碰 DOM,可在 node 測試)。文法見 docs/手機滑動出招設計.md 第 1 節。
// 輸入:一筆軌跡 points = [{x, y, t}](螢幕座標,y 向下;t 毫秒)+ 起筆時的角色面向 face(+1 右 / -1 左)+ 手勢表 set。
// 輸出:{ id, ok, reason, nearest, tokens, dur }。id = 'sp_xxx' | 'ultimate' | 'step_f' | 'step_b' | 'step_u' | 'step_d'。
//
// 流程:左右鏡像(面向左時)→ 5px 重新取樣 + 3 點平均 → 逐點方向角 θ(展開成連續角度)
//       → 對 θ(弧長) 做分段線性擬合(動態規劃,每段是「平坦 = 直線」或「斜坡 = 轉彎」)
//       → 平坦 = 直線 token(F B U D)、斜坡依累積轉角 / 弦長 = 轉角 / 半月 / 一圈 / 兩圈 / 8 字 → token 序列
//       → 與目前角色的 8 個手勢比對(精確;MP 招與月步再給編輯距離 1 的寬鬆比對;最強只收完全相同)。

export const PARAMS = {
  step: 5, // 重新取樣間距 px
  holdMove: 10, // 位移小於此算「沒動」
  holdMs: 600, // 按住多久算 ●
  tapMs: 450, // 點一下上限(僅供 UI 用)
  lambda: 1500, // 分段懲罰(deg²):越大越不容易切段
  flatI: 50, // 一段內部轉角小於此 = 平坦(直線)
  cornerRampL: 16, // 斜坡路徑 ≤ 此且轉角夠大 = 轉角
  cornerMin: 30, // 轉角至少多少度才切開兩筆(擬合會低估轉角,真 90° 常量到 50~60°)
  mergeRatio: 2.6, // 同向相鄰斜坡斜率比小於此才合併成一個弧
  dropEnd: 12, // 頭尾直線短於此丟掉(落指 / 離指抖動)
  dropMid: 14, // 兩轉角之間的直線短於此視為轉角的一部分(Z 字尖端)
  minStroke: 24, // 直線至少多長(含半個轉角)
  lineTol: 35, // 直線方向與四向的容忍角(超過 55 度為斜向 → 不認)
  diagTol: 55,
  arcMin: 70, // 半月累積轉角下限(文件 130;弧尾常被擬合分給接下來的轉角,量到會偏小)
  arcMax: 270, // 半月上限(之上 = 圈)
  circleMax: 520, // 一圈上限(之上 = 兩圈)
  circle2Max: 930,
  c8Min: 260, // 8 字每個圈至少
  cornerMaxA: 215, // 轉彎累積角度超過此就不可能是轉角(接近封閉的小圈)
  uChord: 26, // 反折(U 型)的弦長上限;超過才算半月
  quarterChord: 20, // 小於半圓的轉彎,弦長超過這個才被視為「弧度不夠」,否則是轉角
  arcChordMin: 18, // 半月弦長下限(文件 32)
  arcLenMin: 30, // 半月路徑長下限(文件 50)
  circleLenMin: 38, // 一圈路徑長下限
  chordTol: 55, // 半月弦與水平 / 垂直的容忍角
  maxMs: 2500, // MP 招 / 月步一筆時限
  maxMsUlt: 3500, // 最強時限
  maxPoints: 420 // 重新取樣後最多點數(超過視為亂畫)
};

// 失敗原因 → 顯示文字
export const REASON_TEXT = {
  tap: '點一下不會出招(普攻在左邊小鈕)',
  hold: '按住之後要往前畫',
  slow: '太慢了,一口氣畫完',
  short: '太短了,畫大一點',
  size: '畫太小了',
  arc: '弧度不夠,畫成半圓',
  diag: '方向要直,不要斜',
  circle: '圈數不對',
  unknown: '沒認出來'
};

// token 的口語名稱(手勢書、提示用)
export const TOKEN_TEXT = {
  F: '往前', B: '往後', U: '往上', D: '往下',
  'AU>': '上半月往前', 'AU<': '上半月往回', 'AD>': '下半月往前', 'AD<': '下半月往回',
  'AF↓': '前半月由上往下', 'AF↑': '前半月由下往上', 'AB↓': '後半月由上往下', 'AB↑': '後半月由下往上',
  C1: '畫一圈', C2: '連畫兩圈', C8: '8 字', H: '按住不動'
};

// token → 簡短符號
export const TOKEN_SYM = {
  F: '→', B: '←', U: '↑', D: '↓',
  'AU>': '◠→', 'AU<': '◠←', 'AD>': '◡→', 'AD<': '◡←',
  'AF↓': '⊃', 'AF↑': '⊃↑', 'AB↓': '⊂', 'AB↑': '⊂↑',
  C1: '○', C2: '◎', C8: '∞', H: '●'
};
export const seqSym = (seq) => seq.map((t) => TOKEN_SYM[t] || t).join(' ');

const DEG = 180 / Math.PI;
const wrap = (a) => {
  while (a > 180) a -= 360;
  while (a <= -180) a += 360;
  return a;
};

// ---------------------------------------------------------------- 取樣
function resample(pts, step) {
  const out = [{ x: pts[0].x, y: pts[0].y }];
  let carry = 0;
  let px = pts[0].x;
  let py = pts[0].y;
  for (let i = 1; i < pts.length; i++) {
    let x = pts[i].x;
    let y = pts[i].y;
    let d = Math.hypot(x - px, y - py);
    if (d < 1e-6) continue;
    while (carry + d >= step) {
      const r = (step - carry) / d;
      px += (x - px) * r;
      py += (y - py) * r;
      out.push({ x: px, y: py });
      d = Math.hypot(x - px, y - py);
      carry = 0;
    }
    carry += d;
    px = x;
    py = y;
  }
  // 最後一小段(>= 2px)也留下,讓終點準確
  const last = pts[pts.length - 1];
  const tail = out[out.length - 1];
  if (Math.hypot(last.x - tail.x, last.y - tail.y) >= 2) out.push({ x: last.x, y: last.y });
  return out;
}

function smooth3(q) {
  const out = q.map((p) => ({ x: p.x, y: p.y }));
  for (let i = 1; i < q.length - 1; i++) {
    out[i].x = (q[i - 1].x + q[i].x + q[i + 1].x) / 3;
    out[i].y = (q[i - 1].y + q[i].y + q[i + 1].y) / 3;
  }
  return out;
}

// ---------------------------------------------------------------- 分段線性擬合 θ(i)
function segmentDP(th, lambda) {
  const m = th.length;
  const Sx = new Float64Array(m + 1);
  const Sy = new Float64Array(m + 1);
  const Sxx = new Float64Array(m + 1);
  const Sxy = new Float64Array(m + 1);
  const Syy = new Float64Array(m + 1);
  for (let i = 0; i < m; i++) {
    Sx[i + 1] = Sx[i] + i;
    Sy[i + 1] = Sy[i] + th[i];
    Sxx[i + 1] = Sxx[i] + i * i;
    Sxy[i + 1] = Sxy[i] + i * th[i];
    Syy[i + 1] = Syy[i] + th[i] * th[i];
  }
  const fit = (s, e) => {
    const c = e - s;
    const sx = Sx[e] - Sx[s];
    const sy = Sy[e] - Sy[s];
    const cxx = Sxx[e] - Sxx[s] - (sx * sx) / c;
    const cxy = Sxy[e] - Sxy[s] - (sx * sy) / c;
    const cyy = Syy[e] - Syy[s] - (sy * sy) / c;
    const slope = cxx > 1e-9 ? cxy / cxx : 0;
    const rss = cxx > 1e-9 ? Math.max(0, cyy - (cxy * cxy) / cxx) : Math.max(0, cyy);
    const mean = sy / c;
    const xm = sx / c;
    return { slope, rss, mean, xm };
  };
  const minLen = 1;
  const best = new Float64Array(m + 1).fill(Infinity);
  const prev = new Int32Array(m + 1).fill(-1);
  best[0] = 0;
  for (let e = minLen; e <= m; e++) {
    for (let s = 0; s <= e - minLen; s++) {
      if (best[s] === Infinity) continue;
      const c = best[s] + fit(s, e).rss + lambda;
      if (c < best[e]) {
        best[e] = c;
        prev[e] = s;
      }
    }
  }
  const segs = [];
  let e = m;
  while (e > 0) {
    const s = prev[e];
    if (s < 0) break;
    const f = fit(s, e);
    const a = s;
    const b = e - 1;
    segs.push({ a, b, slope: f.slope, fs: f.mean + f.slope * (a - f.xm), fe: f.mean + f.slope * (b - f.xm) });
    e = s;
  }
  segs.reverse();
  return segs;
}

// ---------------------------------------------------------------- 軌跡 → token
// 回傳 { tokens, bad, dur, hold }
export function tokenize(points, face, P) {
  P = P || PARAMS;
  const sgn = face < 0 ? -1 : 1;
  const raw = [];
  for (const p of points) {
    const last = raw[raw.length - 1];
    const x = p.x * sgn;
    if (last && Math.hypot(x - last.x, p.y - last.y) < 0.5 && p.t - last.t < 1000) continue;
    raw.push({ x, y: p.y, t: p.t });
  }
  const res = { tokens: [], bad: null, dur: 0, hold: false };
  if (raw.length < 2) {
    res.bad = 'tap';
    return res;
  }
  const total = raw[raw.length - 1].t - raw[0].t;
  const p0 = raw[0];
  let j = -1;
  for (let i = 1; i < raw.length; i++) {
    if (Math.hypot(raw[i].x - p0.x, raw[i].y - p0.y) >= P.holdMove) {
      j = i;
      break;
    }
  }
  if (j < 0) {
    if (total >= P.holdMs) {
      res.tokens = ['H'];
      res.bad = 'hold';
      res.hold = true;
    } else res.bad = 'tap';
    res.dur = total;
    return res;
  }
  let lead = false;
  let path = raw;
  if (raw[j].t - p0.t >= P.holdMs) {
    lead = true;
    // 筆畫從「離開原位」那一刻算起,起點仍用按住的位置
    path = [{ x: p0.x, y: p0.y, t: raw[j - 1].t }].concat(raw.slice(j));
  }
  res.dur = path[path.length - 1].t - path[0].t;
  res.hold = lead;

  let q = resample(path, P.step);
  if (q.length > P.maxPoints) {
    res.bad = 'unknown';
    return res;
  }
  const out = lead ? ['H'] : [];
  if (q.length < 4) {
    if (!lead) res.bad = 'short';
    else res.bad = 'hold';
    res.tokens = out;
    return res;
  }
  q = smooth3(q);
  // 逐點方向角(連續展開)
  const th = [];
  let prevA = null;
  let acc = 0;
  for (let i = 0; i + 1 < q.length; i++) {
    const a = Math.atan2(q[i + 1].y - q[i].y, q[i + 1].x - q[i].x) * DEG;
    if (prevA === null) acc = a;
    else acc += wrap(a - prevA);
    prevA = a;
    th.push(acc);
  }
  // 累積弧長
  const cum = [0];
  for (let i = 1; i < q.length; i++) cum.push(cum[i - 1] + Math.hypot(q[i].x - q[i - 1].x, q[i].y - q[i - 1].y));

  const segs = segmentDP(th, P.lambda);
  const runs = buildRuns(segs, q, cum, P);
  res.runs = runs;
  res.segs = segs;
  const r = runsToTokens(runs, q, P);
  res.bad = r.bad;
  res.tokens = out.concat(r.tokens);
  if (!r.tokens.length && !r.bad) res.bad = lead ? 'hold' : 'short';
  if (r.bad && lead && !r.tokens.length && r.bad === 'short') res.bad = 'hold';
  return res;
}

// 把分段結果整理成「直線 S / 轉彎 R / 8 字 E / 轉角 C」的順序列
function buildRuns(segs, q, cum, P) {
  const items = [];
  segs.forEach((s, i) => {
    const I = s.fe - s.fs;
    const L = cum[s.b + 1] - cum[s.a];
    items.push({ k: Math.abs(I) < P.flatI ? 'S' : 'R', a: s.a, b: s.b, I, L, mean: (s.fs + s.fe) / 2 });
    if (i + 1 < segs.length) items.push({ k: 'C', ang: segs[i + 1].fs - s.fe, L: 0, j: true });
  });
  // 很短但轉很多的斜坡 = 轉角
  let list = items.map((it) => (it.k === 'R' && it.L <= P.cornerRampL && Math.abs(it.I) >= 30 ? { k: 'C', ang: it.I, L: it.L } : it));

  // 整理:相鄰轉角相加 → 夾在轉角之間的短直線併入(Z 字尖端)→ 太小的轉角視為沒有 → 相鄰直線 / 同向弧合併
  const tidy = () => {
    for (let round = 0; round < 3; round++) {
      let out = [];
      for (const e of list) {
        const pr = out[out.length - 1];
        if (e.k === 'C' && pr && pr.k === 'C') {
          pr.ang += e.ang;
          pr.L += e.L;
        } else out.push(Object.assign({}, e));
      }
      for (let i = 1; i + 1 < out.length; i++) {
        if (out[i].k === 'S' && out[i - 1].k === 'C' && out[i + 1].k === 'C' && out[i].L < P.dropMid) {
          out[i - 1].ang += out[i + 1].ang;
          out[i - 1].L += out[i].L + out[i + 1].L;
          out.splice(i, 2);
          i--;
        }
      }
      out = out.filter((e) => e.k !== 'C' || Math.abs(e.ang) >= P.cornerMin);
      list = [];
      for (const e of out) {
        const pr = list[list.length - 1];
        if (pr && pr.k === 'S' && e.k === 'S') {
          pr.mean = pr.mean + (wrap(e.mean - pr.mean) * e.L) / (pr.L + e.L);
          pr.L += e.L;
          pr.b = e.b;
        } else if (pr && pr.k === 'R' && e.k === 'R' && pr.I * e.I > 0) {
          const r1 = Math.abs(pr.I) / pr.L;
          const r2 = Math.abs(e.I) / e.L;
          const ratio = Math.max(r1, r2) / Math.max(1e-6, Math.min(r1, r2));
          if (ratio <= P.mergeRatio) {
            pr.I += e.I;
            pr.L += e.L;
            pr.b = e.b;
          } else list.push(e);
        } else list.push(e);
      }
    }
  };
  tidy();
  // 8 字:兩個相反方向、各夠大的相鄰斜坡
  for (let i = 0; i + 1 < list.length; i++) {
    const a = list[i];
    const b = list[i + 1];
    if (a.k === 'R' && b.k === 'R' && a.I * b.I < 0 && Math.abs(a.I) >= P.c8Min && Math.abs(b.I) >= P.c8Min && a.L + b.L >= P.circleLenMin * 1.6) {
      a.k = 'E';
      a.I += b.I;
      a.L += b.L;
      a.b = b.b;
      list.splice(i + 1, 1);
    }
  }
  // 圓弧不夠大、弦很短的轉彎 = 圓角的轉角(例:手指畫的 L 形圓角)
  let changed = false;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (e.k !== 'R') continue;
    const aa = Math.abs(e.I);
    if (aa >= P.cornerMaxA) continue;
    const p0 = q[e.a];
    const p1 = q[Math.min(q.length - 1, e.b + 1)];
    const chord = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    const pr = list[i - 1];
    const nx = list[i + 1];
    const isC = (x) => x && x.k === 'C' && Math.abs(x.ang) >= 40;
    if (aa < P.arcMin && chord >= 14 && ((isC(pr) && (isC(nx) || !nx)) || (!pr && isC(nx)))) {
      // 夾在轉角之間(或轉角與端點之間)、被手指畫彎的一筆(Z 字 / ⊓ 形中間那筆):用起訖點當作直線
      e.k = 'S';
      e.mean = Math.atan2(p1.y - p0.y, p1.x - p0.x) * DEG;
      changed = true;
    } else if (chord < (aa >= P.arcMin ? P.uChord : P.quarterChord)) {
      e.k = 'C';
      e.ang = e.I;
      changed = true;
    }
  }
  if (changed) tidy();
  return list;
}

function dirOfLine(angDeg, P) {
  const a = wrap(angDeg);
  const cand = [['F', 0], ['D', 90], ['B', 180], ['U', -90]];
  let best = null;
  for (const [t, c] of cand) {
    const d = Math.abs(wrap(a - c));
    if (!best || d < best.d) best = { t, d };
  }
  return best.d <= P.lineTol ? best.t : null;
}

function runsToTokens(runs, q, P) {
  const tokens = [];
  let bad = null;
  const setBad = (b) => {
    if (!bad) bad = b;
  };
  const n = runs.length;
  let lastWasLine = false;
  let cornerAng = 0; // 上一個 token 之後遇到的最大轉角
  for (let i = 0; i < n; i++) {
    const r = runs[i];
    if (r.k === 'C') {
      cornerAng = Math.max(cornerAng, Math.abs(r.ang));
      continue;
    }
    if (r.k !== 'S') lastWasLine = false;
    if (r.k === 'S') {
      // 兩端接轉角時,轉角附近的取樣點被分給轉角,補回約一個取樣間距
      let len = r.L;
      if (i > 0 && runs[i - 1].k === 'C') len += runs[i - 1].L / 2 + 6;
      if (i + 1 < n && runs[i + 1].k === 'C') len += runs[i + 1].L / 2 + 6;
      const atEnd = i === 0 || i === n - 1;
      if (atEnd && len < P.dropEnd) continue;
      // 緊接在圈 / 弧後面(或前面)的短小尾巴 = 落指 / 收指的手勢殘跡,直接丟掉
      const nb = i === 0 ? runs[1] : i === n - 1 ? runs[n - 2] : null;
      if (atEnd && len < P.minStroke && nb && (nb.k === 'R' || nb.k === 'E')) continue;
      if (len < P.minStroke) {
        setBad('short');
        continue;
      }
      const d = dirOfLine(r.mean, P);
      if (!d) setBad('diag');
      else if (tokens.length && tokens[tokens.length - 1] === d && lastWasLine) {
        // 同方向被轉角切開:輕微彎折 = 同一筆,合併;大反折(Z 字中間那筆被吃掉)= 認不出來
        if (cornerAng >= 100) setBad('unknown');
      } else tokens.push(d);
      lastWasLine = !!d;
      cornerAng = 0;
      continue;
    }
    if (r.k === 'E') {
      tokens.push('C8');
      cornerAng = 0;
      continue;
    }
    // 轉彎 R
    const aa = Math.abs(r.I);
    const p0 = q[r.a];
    const p1 = q[Math.min(q.length - 1, r.b + 1)];
    const chord = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    if (aa >= P.arcMax) {
      if (r.L < P.circleLenMin) setBad('size');
      else if (aa < P.circleMax) tokens.push('C1');
      else if (aa < P.circle2Max) tokens.push('C2');
      else setBad('circle');
      continue;
    }
    if (aa < P.arcMin) {
      setBad('arc');
      continue;
    }
    if (chord < P.arcChordMin || r.L < P.arcLenMin) {
      setBad('size');
      continue;
    }
    const tk = arcToken(q, r, p0, p1, P);
    if (!tk) setBad('diag');
    else tokens.push(tk);
  }
  return { tokens, bad };
}

function arcToken(q, r, p0, p1, P) {
  const cx = p1.x - p0.x;
  const cy = p1.y - p0.y;
  const clen = Math.hypot(cx, cy);
  // 弧頂 = 離弦最遠的取樣點
  let apex = null;
  let far = -1;
  for (let i = r.a; i <= Math.min(q.length - 1, r.b + 1); i++) {
    const d = Math.abs(cx * (q[i].y - p0.y) - cy * (q[i].x - p0.x)) / clen;
    if (d > far) {
      far = d;
      apex = q[i];
    }
  }
  const phi = Math.atan2(cy, cx) * DEG;
  const ph = Math.abs(phi);
  if (ph <= P.chordTol || ph >= 180 - P.chordTol) {
    const dirT = ph <= P.chordTol ? '>' : '<';
    // 弦線在弧頂 x 位置的 y
    const yLine = p0.y + ((apex.x - p0.x) * cy) / (Math.abs(cx) < 1e-6 ? 1e-6 : cx);
    return (apex.y < yLine ? 'AU' : 'AD') + dirT;
  }
  if (Math.abs(ph - 90) <= P.chordTol) {
    const dirT = phi > 0 ? '↓' : '↑';
    const xLine = p0.x + ((apex.y - p0.y) * cx) / (Math.abs(cy) < 1e-6 ? 1e-6 : cy);
    return (apex.x > xLine ? 'AF' : 'AB') + dirT;
  }
  return null;
}

// ---------------------------------------------------------------- 比對
const SIMILAR = { 'C1|C2': 0.4 };
for (const a of ['AU>', 'AU<', 'AD>', 'AD<', 'AF↓', 'AF↑', 'AB↓', 'AB↑']) {
  SIMILAR[a + '|C1'] = 0.5;
  for (const b of ['AU>', 'AU<', 'AD>', 'AD<', 'AF↓', 'AF↑', 'AB↓', 'AB↑']) if (a !== b) SIMILAR[a + '|' + b] = 0.5;
}
// 弧 ↔ 直線:弦方向一致時算相近
const ARCLINE = { 'AU>': 'F', 'AD>': 'F', 'AU<': 'B', 'AD<': 'B', 'AF↓': 'D', 'AB↓': 'D', 'AF↑': 'U', 'AB↑': 'U' };
for (const a in ARCLINE) SIMILAR[a + '|' + ARCLINE[a]] = 0.4;
function subCost(a, b) {
  if (a === b) return 0;
  return SIMILAR[a + '|' + b] || SIMILAR[b + '|' + a] || 1;
}
export function editDistance(a, b) {
  const n = a.length;
  const m = b.length;
  const d = [];
  for (let i = 0; i <= n; i++) {
    d.push(new Array(m + 1).fill(0));
    d[i][0] = i;
  }
  for (let j = 0; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + subCost(a[i - 1], b[j - 1]));
  }
  return d[n][m];
}
const same = (a, b) => a.length === b.length && a.every((t, i) => t === b[i]);

// set: [{ id, kind: 'sp'|'ult'|'step', seq: [...], strict? }]
export function recognize(points, face, set, P) {
  P = P || PARAMS;
  const tk = tokenize(points, face, P);
  const res = { id: null, ok: false, reason: null, nearest: null, tokens: tk.tokens, dur: tk.dur };
  const hasHold = set.some((g) => g.seq[0] === 'H');
  const near = () => {
    let best = null;
    for (const g of set) {
      const d = editDistance(tk.tokens, g.seq);
      if (!best || d < best.d) best = { id: g.id, d };
    }
    return best && best.d <= 1.5 ? best.id : null;
  };
  if (tk.bad && !tk.tokens.length) {
    res.reason = tk.bad === 'hold' && !hasHold ? 'tap' : tk.bad;
    return res;
  }
  // 寬鬆模式:斜向 / 弧度不夠的筆畫都不再整筆作廢,直接拿辨識到的筆畫找最接近的招(放錯招也沒關係)
  let hit = set.find((g) => same(g.seq, tk.tokens));
  if (!hit && tk.tokens.every((t) => t === 'H')) {
    res.reason = 'hold';
    return res;
  }
  if (!hit) {
    const cand = set.map((g) => ({ g, d: editDistance(tk.tokens, g.seq) })).sort((a, b) => a.d - b.d || (a.g.strict ? 1 : 0) - (b.g.strict ? 1 : 0));
    const pick = cand.find((c) => !c.g.strict) || null;
    const ult = cand.find((c) => c.g.strict);
    if (ult && ult.d <= 1 && (!pick || ult.d < pick.d)) hit = ult.g;
    else if (pick) hit = pick.g;
  }
  if (!hit) {
    res.reason = tk.bad || 'unknown';
    res.nearest = near();
    return res;
  }
  const limit = hit.strict ? P.maxMsUlt : P.maxMs;
  if (tk.dur > limit + 1) {
    res.reason = 'slow';
    res.nearest = hit.id;
    return res;
  }
  res.id = hit.id;
  res.ok = true;
  res.loose = !same(hit.seq, tk.tokens);
  return res;
}

// 按住進度(0~1);只在沒移動時有意義。UI 畫蓄力環用
export function holdProgress(points, now, P) {
  P = P || PARAMS;
  if (!points.length) return 0;
  const p0 = points[0];
  for (const p of points) if (Math.hypot(p.x - p0.x, p.y - p0.y) >= P.holdMove) return 0;
  return Math.min(1, Math.max(0, (now - p0.t) / P.holdMs));
}

// ---------------------------------------------------------------- 手勢表
export const STEP_IDS = ['step_f', 'step_b', 'step_u', 'step_d'];

// j = 角色 json、gd = data/gestures.json。回傳 [{ id, kind, seq, strict, name, cost, tip, family }]
export function buildSet(j, gd) {
  const g = (gd.chars && gd.chars[j.id]) || {};
  const out = [];
  const moves = (j.info && j.info.moves) || {};
  for (const cmd of Object.keys(moves)) {
    const e = g[cmd];
    if (!e) continue;
    const seq = e.seq || (gd.families[e.family] && gd.families[e.family].seq);
    if (!seq) continue;
    out.push({ id: cmd, kind: 'sp', seq: seq.slice(), strict: false, name: moves[cmd].name, desc: moves[cmd].desc, cost: j.moves[cmd] ? j.moves[cmd].cost || 0 : 0, tip: e.tip || '', family: e.family || null });
  }
  const u = g.ultimate;
  if (u && u.seq) {
    out.push({ id: 'ultimate', kind: 'ult', seq: u.seq.slice(), strict: true, name: (j.info && j.info.ult && j.info.ult.name) || '最強必殺技', desc: (j.info && j.info.ult && j.info.ult.desc) || '', cost: 0, tip: u.tip || '', family: 'sig' });
  }
  for (const id of STEP_IDS) {
    const c = gd.common && gd.common[id];
    if (c) out.push({ id, kind: 'step', seq: c.seq.slice(), strict: false, name: c.name, desc: c.desc || '', cost: 0, tip: '', family: 'step' });
  }
  return out;
}

// ---------------------------------------------------------------- 範本軌跡(單位座標,面向右)
// 回傳 { pts:[{x,y}], marks:[{x,y,n,t}], hold:{x,y}|null }。1 單位 = 一條直線長 = 半月直徑。
export function templatePath(seq) {
  const pts = [{ x: 0, y: 0 }];
  const marks = [];
  let hold = null;
  let pos = { x: 0, y: 0 };
  let lastDir = null; // 上一條直線方向,用來把來回的線錯開一點好看
  const push = (x, y) => {
    pos = { x, y };
    pts.push({ x, y });
  };
  const DIRS = { F: [1, 0], B: [-1, 0], U: [0, -1], D: [0, 1] };
  seq.forEach((t, idx) => {
    const m = { x: pos.x, y: pos.y, n: idx + 1, t };
    if (t === 'H') {
      hold = { x: pos.x, y: pos.y };
      return;
    }
    marks.push(m);
    if (DIRS[t]) {
      const [dx, dy] = DIRS[t];
      if (lastDir && lastDir[0] === -dx && lastDir[1] === -dy) {
        // 來回:往垂直方向錯開 0.16
        push(pos.x + (dy !== 0 ? 0.16 : 0), pos.y + (dx !== 0 ? 0.16 : 0));
      }
      push(pos.x + dx, pos.y + dy);
      lastDir = [dx, dy];
      return;
    }
    lastDir = null;
    if (t[0] === 'A') {
      const r = 0.5;
      const sx = pos.x;
      const sy = pos.y;
      const N = 20;
      for (let i = 1; i <= N; i++) {
        const u = (i / N) * Math.PI;
        if (t[1] === 'U' || t[1] === 'D') {
          const d = t[2] === '>' ? 1 : -1;
          const b = t[1] === 'U' ? -1 : 1;
          push(sx + d * r * (1 - Math.cos(u)), sy + b * r * Math.sin(u));
        } else {
          const e = t[2] === '↓' ? 1 : -1;
          const f = t[1] === 'F' ? 1 : -1;
          push(sx + f * r * Math.sin(u), sy + e * r * (1 - Math.cos(u)));
        }
      }
      return;
    }
    if (t === 'C1' || t === 'C2') {
      const r = 0.36;
      const cx = pos.x;
      const cy = pos.y - r;
      const loops = t === 'C2' ? 2 : 1;
      const N = 28 * loops;
      for (let i = 1; i <= N; i++) {
        const al = (90 + (i / N) * 360 * loops) / DEG;
        push(cx + r * Math.cos(al), cy + r * Math.sin(al));
      }
      return;
    }
    if (t === 'C8') {
      const r = 0.3;
      let cx = pos.x;
      let cy = pos.y - r;
      const sx = pos.x;
      const sy = pos.y;
      void sx;
      void sy;
      for (let i = 1; i <= 28; i++) {
        const al = (90 + (i / 28) * 360) / DEG;
        push(cx + r * Math.cos(al), cy + r * Math.sin(al));
      }
      cy = pos.y + r;
      cx = pos.x;
      for (let i = 1; i <= 28; i++) {
        const al = (270 - (i / 28) * 360) / DEG;
        push(cx + r * Math.cos(al), cy + r * Math.sin(al));
      }
    }
  });
  return { pts, marks, hold };
}

// 把單位座標範本縮放到 size×size 的方框內置中:回傳 { pts, marks, hold, scale }
export function fitTemplate(tp, size, pad, sizeH) {
  pad = pad || 0;
  sizeH = sizeH || size;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of tp.pts) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  const w = Math.max(0.3, x1 - x0);
  const h = Math.max(0.3, y1 - y0);
  const s = Math.min((size - pad * 2) / w, (sizeH - pad * 2) / h);
  const ox = (size - w * s) / 2 - x0 * s;
  const oy = (sizeH - h * s) / 2 - y0 * s;
  const f = (p) => ({ x: p.x * s + ox, y: p.y * s + oy });
  return { pts: tp.pts.map(f), marks: tp.marks.map((m) => Object.assign({}, m, f(m))), hold: tp.hold ? f(tp.hold) : null, scale: s };
}
