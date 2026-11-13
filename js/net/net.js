// Net 介面(草案 5-3-1):房間路徑與訊息收送,底下的傳輸層可抽換(Firebase / 本機模擬 / 未來 WebRTC)。
// transport 介面:get / getEtag / set / update / remove / setIf / listen / onState / online
export class Net {
  constructor(tr, clock, code) {
    this.tr = tr;
    this.clock = clock;
    this.code = code;
    this.root = 'rooms/' + code;
    this.unsubC = null;
    this.unsubH = null;
  }
  path(p) {
    return this.root + '/' + p;
  }
  // 客戶端監聽 c(snap / host / ev);回呼收到 c 節點完整值
  listenClient(cb) {
    if (this.unsubC) this.unsubC();
    this.unsubC = this.tr.listen(this.path('c'), cb);
  }
  // 房主監聽 h/in(各座位輸入);回呼收到 {座位: 封包}
  listenHost(cb) {
    if (this.unsubH) this.unsubH();
    this.unsubH = this.tr.listen(this.path('h/in'), cb);
  }
  stopClient() {
    if (this.unsubC) this.unsubC();
    this.unsubC = null;
  }
  stopHost() {
    if (this.unsubH) this.unsubH();
    this.unsubH = null;
  }
  sendInput(seat, pkt) {
    return this.tr.set(this.path('h/in/' + seat), pkt, { lossy: true });
  }
  broadcast(msg) {
    return this.tr.set(this.path('c/snap'), msg, { lossy: true });
  }
  save(obj) {
    return this.tr.set(this.path('save'), obj);
  }
  getSave() {
    return this.tr.get(this.path('save'));
  }
  getSaveEtag() {
    return this.tr.getEtag(this.path('save'));
  }
  claimHost(etag, obj) {
    return this.tr.setIf(this.path('save'), obj, etag);
  }
  announceHost(e, seat) {
    return this.tr.set(this.path('c/host'), { e, seat });
  }
  publishEvent(ev) {
    return this.tr.set(this.path('c/ev'), ev);
  }
  getMeta() {
    return this.tr.get(this.path('meta'));
  }
  getSeats() {
    return this.tr.get(this.path('seats'));
  }
  touch() {
    return this.tr.update(this.path('meta'), { lastSeen: this.clock.wall() });
  }
}
