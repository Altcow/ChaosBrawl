// 房主遷移與回歸(草案 5-5、5-6)
// 流程:客戶端 1.5 s 沒快照 → 凍結 → 依接班順序錯開 k×0.7 s → 兩次 GET save(間隔 1 s,ETag 沒變才算房主掛了)
//       → 以 ETag 條件寫入搶位(epoch+1)→ 成為新房主、舊房主角色交 AI → 1 s「繼續!」後開跑。
// 防雙房主:安全規則要求 save.e 不得變小、c/snap.e 必須等於 save.e;舊房主的寫入被拒 → 降為一般玩家並走回歸流程。
import { restoreWorld, serializeWorld } from '../sim/world.js';
import { decodeWorld, encodeWorld, b64dec, b64enc } from './codec.js';

const STAGGER_MS = 700;
const ETAG_GAP_MS = 1000;
const RESUME_MS = 1000;

const sleep = (clock, ms) => new Promise((r) => clock.setTimeout(r, ms));

export class Migrator {
  constructor(s) {
    this.s = s;
    this.running = false;
  }
  begin() {
    if (!this.running) this.run();
  }
  async run() {
    const s = this.s;
    this.running = true;
    try {
      while (s.frozen && s.role === 'client') {
        const list = (s.succ || []).filter((x) => x !== s.hostSeat);
        const k = list.indexOf(s.seat);
        if (k < 0) {
          await sleep(s.clock, 500);
          continue;
        }
        await sleep(s.clock, k * STAGGER_MS);
        if (!s.frozen || s.role !== 'client') break;
        if (s.tr.online === false) {
          await sleep(s.clock, 1000);
          continue;
        }
        try {
          const r1 = await s.net.getSaveEtag();
          await sleep(s.clock, ETAG_GAP_MS);
          if (!s.frozen || s.role !== 'client') break;
          const r2 = await s.net.getSaveEtag();
          if (r1.etag !== r2.etag) {
            // 房主還活著(save 每 0.5 s 會改):是自己的網路問題,回到等待
            s.lastSnapAt = s.clock.now();
            s.frozen = false;
            break;
          }
          const save = r2.v;
          if (!save) {
            await sleep(s.clock, 1000);
            continue;
          }
          // 以自己最新的快照(全狀態)或 save 之中較新者為底
          let state = decodeWorld(b64dec(save.d), s.ctx);
          const last = s.snaps.length ? s.snaps[s.snaps.length - 1] : null;
          if (last && last.S.tick > state.tick) state = last.S;
          const rec = { e: save.e + 1, seat: s.seat, tick: state.tick, d: b64enc(encodeWorld(state, s.ctx)) };
          const ok = await s.net.claimHost(r2.etag, rec);
          if (ok) {
            await promote(s, rec.e, state);
            break;
          }
          await sleep(s.clock, 1000); // 別人搶到,等新房主的快照
        } catch (e) {
          await sleep(s.clock, 1000);
        }
      }
    } finally {
      this.running = false;
    }
  }
}

// 成為新房主
export async function promote(s, epoch, state) {
  const now = s.clock.now();
  s.net.stopClient();
  s.role = 'host';
  s.epoch = epoch;
  s.hostSeat = s.seat;
  s.frozen = false;
  s.stats.migrations++;
  const { buildNetWorld } = await import('./sync.js');
  s.world = buildNetWorld(s.chars, s.stage, s.cfg);
  restoreWorld(s.world, state);
  s.rollbackTo = state.tick; // 供測試比對「回溯 tick」
  s._hostInit(now);
  for (const f of s.world.fighters) {
    if (!f.seatHuman) continue;
    if (s.fidSeat[f.id] === s.seat) f.kind = 'human';
    else {
      // 其他真人先交 AI 暫代;他們的第一筆輸入到達即取回
      f.kind = 'ai';
      f.ai.lvl = 1;
      f.ai.script = [];
      f.ai.q = [];
    }
  }
  await s.net.announceHost(epoch, s.seat);
  s.net.listenHost((v) => s.onHostIn(v));
  s._publishSucc();
  s.resumeAt = now + RESUME_MS;
  s.hostReady = true;
  if (s.onNotice) s.onNotice('繼續!');
}

// 舊房主寫入被拒 → 降為一般玩家,走回歸流程
export function demote(s) {
  if (s.role !== 'host') return;
  s.hostReady = false;
  s.net.stopHost();
  s.role = 'client';
  s.synced = false;
  s.frozen = false;
  s.snaps = [];
  s.demotedAt = s.clock.now();
  s.stats.demotions = (s.stats.demotions || 0) + 1;
  s.startClient();
}
