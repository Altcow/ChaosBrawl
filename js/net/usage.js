// 用量計(草案 5-3-5):依 5-3-2 的估算值累計 RTDB 下載位元組,房主每 60 s 把房間合計寫到 usage/<YYYYMM>
// 官方用量頁仍為最終依據;REST 的 {".sv":{"increment":n}} 支援度待真實連線實測【不確定】
export const SPARK_LIMIT_BYTES = 10e9;
const SSE_OVERHEAD = 120; // JSON/SSE/TLS 包裝(估算)
const INPUT_COST = 100; // 一則輸入下載(5-3-2)
const WRITE_RESP = 80; // 寫入回應(5-3-2)

export class Usage {
  constructor(tr, clock) {
    this.tr = tr;
    this.clock = clock;
    this.pending = 0;
    this.total = 0;
    this.lastFlush = clock.now();
  }
  snapshotSent(jsonLen, receivers) {
    this.add((jsonLen + SSE_OVERHEAD) * receivers + WRITE_RESP);
  }
  inputReceived() {
    this.add(INPUT_COST + WRITE_RESP);
  }
  writeDone() {
    this.add(WRITE_RESP);
  }
  add(n) {
    this.pending += n;
    this.total += n;
  }
  monthKey() {
    const d = new Date(this.clock.wall());
    return d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, '0');
  }
  async flush() {
    if (!this.pending) return;
    const n = Math.round(this.pending);
    this.pending = 0;
    this.lastFlush = this.clock.now();
    try {
      await this.tr.set('usage/' + this.monthKey(), { '.sv': { increment: n } });
    } catch (e) {
      this.pending += n; // 失敗下次再送
    }
  }
  // 大廳顯示用:本月估計已用 / 10 GB;>= 90% 時 canStartMatch 回 false(待決 #2:是否禁止開局)
  async monthUsed() {
    const v = await this.tr.get('usage/' + this.monthKey());
    return typeof v === 'number' ? v : 0;
  }
  static canStartMatch(usedBytes) {
    return usedBytes < SPARK_LIMIT_BYTES * 0.9;
  }
}
