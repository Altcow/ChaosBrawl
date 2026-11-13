// 最小 PNG 讀寫(只用 node:zlib):讀 8-bit 灰階/灰階+α/RGB/RGBA/調色盤(非交錯),寫 RGBA 8-bit
import { inflateSync, deflateSync } from 'node:zlib';

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// 回傳 { w, h, data: Uint8Array(RGBA) }
export function decodePng(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIG)) throw new Error('不是 PNG 檔');
  let p = 8;
  let ihdr = null;
  let plte = null;
  let trns = null;
  const idat = [];
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    const body = buf.subarray(p + 8, p + 8 + len);
    p += 12 + len;
    if (type === 'IHDR') ihdr = body;
    else if (type === 'PLTE') plte = body;
    else if (type === 'tRNS') trns = body;
    else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
  }
  if (!ihdr) throw new Error('PNG 缺 IHDR');
  const w = ihdr.readUInt32BE(0);
  const h = ihdr.readUInt32BE(4);
  const depth = ihdr[8];
  const ctype = ihdr[9];
  if (depth !== 8) throw new Error('只支援 8-bit PNG(此檔 ' + depth + '-bit)');
  if (ihdr[12] !== 0) throw new Error('不支援交錯(interlaced)PNG');
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype];
  if (!ch) throw new Error('不支援的 PNG 色彩類型 ' + ctype);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const px = new Uint8Array(stride * h);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = px.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0;
      const b = prev[i];
      const c = i >= ch ? prev[i - ch] : 0;
      let v = line[i];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a);
        const pb = Math.abs(pp - b);
        const pc = Math.abs(pp - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (ft !== 0) throw new Error('PNG 濾波型別錯誤 ' + ft);
      cur[i] = v & 255;
    }
    prev = cur;
  }
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    if (ctype === 6) {
      data.set(px.subarray(i * 4, i * 4 + 4), o);
    } else if (ctype === 2) {
      data[o] = px[i * 3];
      data[o + 1] = px[i * 3 + 1];
      data[o + 2] = px[i * 3 + 2];
      data[o + 3] = 255;
    } else if (ctype === 0) {
      data[o] = data[o + 1] = data[o + 2] = px[i];
      data[o + 3] = 255;
    } else if (ctype === 4) {
      data[o] = data[o + 1] = data[o + 2] = px[i * 2];
      data[o + 3] = px[i * 2 + 1];
    } else {
      const idx = px[i];
      if (!plte) throw new Error('調色盤 PNG 缺 PLTE');
      data[o] = plte[idx * 3];
      data[o + 1] = plte[idx * 3 + 1];
      data[o + 2] = plte[idx * 3 + 2];
      data[o + 3] = trns && idx < trns.length ? trns[idx] : 255;
    }
  }
  return { w, h, data };
}

function chunk(type, body) {
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, 'latin1');
  body.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
}

// img = { w, h, data: Uint8Array(RGBA) } → Buffer
export function encodePng(img) {
  const { w, h, data } = img;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(data.buffer, data.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
