// 真實連線延遲實測(Node 22,無依賴):node tools/latency-node.mjs [資料庫網址] [取樣數]
// 兩條獨立的 SSE 連線(模擬兩台裝置)走同一個 Firebase 伺服器:A 寫入 → B 收到推送,量「寫入到對方收到」
// (同一台機器、同一個時鐘,所以是真實的單程中繼延遲,含上行 + 伺服器 + 下行)。另量 REST 往返。
// 測完會刪除自己寫的 latency/<id> 節點。只印實測數字。
import { FIREBASE_URL } from '../js/net/config.js';

const base = (process.argv[2] || FIREBASE_URL).replace(/\/+$/, '');
const N = parseInt(process.argv[3] || '100', 10);
const id = 'n' + Math.random().toString(36).slice(2, 8);
const url = (p) => base + '/latency/' + id + (p ? '/' + p : '') + '.json';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

async function sse(path, onPut) {
  const ac = new AbortController();
  const res = await fetch(url(path), { headers: { Accept: 'text/event-stream' }, signal: ac.signal });
  if (!res.ok) throw new Error('SSE HTTP ' + res.status);
  (async () => {
    const dec = new TextDecoder();
    let buf = '';
    try {
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = /event: (\w+)/.exec(block);
          const data = /data: (.*)/.exec(block);
          if (ev && ev[1] === 'put' && data) onPut(JSON.parse(data[1]), performance.now());
        }
      }
    } catch (e) { /* abort */ }
  })();
  return () => ac.abort();
}

async function main() {
  const rest = [];
  const oneWay = [];
  const sentAt = {};
  let stopB = null;
  try {
    // 先試寫
    const t0 = performance.now();
    const r = await fetch(url('probe'), { method: 'PUT', body: JSON.stringify({ t: 1 }) });
    if (!r.ok) throw new Error('寫入被拒 HTTP ' + r.status + '(請確認 RTDB 規則允許 latency/ 讀寫)');
    rest.push(performance.now() - t0);
    stopB = await sse('', (m, t) => {
      const d = m.data;
      if (d && typeof d === 'object' && d.q && sentAt[d.q] !== undefined) {
        oneWay.push(t - sentAt[d.q]);
        delete sentAt[d.q];
      }
    });
    await sleep(2000);
    for (let i = 1; i <= N; i++) {
      sentAt[i] = performance.now();
      const t1 = performance.now();
      const res = await fetch(url('ping'), { method: 'PUT', body: JSON.stringify({ q: i }) });
      rest.push(performance.now() - t1);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      await sleep(200);
    }
    await sleep(1500);
  } finally {
    if (stopB) stopB();
    const d = await fetch(url(''), { method: 'DELETE' }).catch(() => null);
    const chk = await fetch(url('')).then((x) => x.text()).catch(() => 'n/a');
    console.log('清理:DELETE HTTP ' + (d && d.status) + ',再讀回 = ' + chk.trim());
  }
  const f = (name, a) => a.length ? name + ': n=' + a.length + ' min=' + Math.min(...a).toFixed(0) + ' 中位=' + q(a, 0.5).toFixed(0) + ' p95=' + q(a, 0.95).toFixed(0) + ' max=' + Math.max(...a).toFixed(0) + ' ms' : name + ': 無資料';
  console.log(f('REST 寫入往返', rest));
  console.log(f('寫入 → 另一條連線收到(單程中繼)', oneWay));
  if (oneWay.length) console.log('判準(單程中位 ≤120、p95 ≤250):' + (q(oneWay, 0.5) <= 120 && q(oneWay, 0.95) <= 250 ? '達標' : '未達標'));
}
main().catch((e) => { console.error('失敗:' + e.message); process.exit(1); });
