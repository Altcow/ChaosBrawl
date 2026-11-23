// 手機操作相關的本機設定與學習紀錄(localStorage;隱私模式 / 讀寫失敗時退回記憶體,不影響遊戲)
const LS = 'chaosbrawl-touchset';
const LS_MASTER = 'chaosbrawl-gesture-master';
const LS_BATTLES = 'chaosbrawl-battles';
const LS_TUT = 'chaosbrawl-tut2-seen';
const DEFAULTS = { assist: false, ring: 'on' }; // assist:新手輔助鈕(僅單機 / 練習場);ring:手勢小抄環 auto = 前 5 場 / on / off

let mem = null;
const memStore = {};
function read(key) {
  try {
    return localStorage.getItem(key);
  } catch (e) {
    return memStore[key] === undefined ? null : memStore[key];
  }
}
function write(key, val) {
  try {
    localStorage.setItem(key, val);
  } catch (e) {
    memStore[key] = val;
  }
}

export function getSettings() {
  if (mem) return mem;
  let p = null;
  try {
    p = JSON.parse(read(LS));
  } catch (e) { /* 壞掉的設定 → 預設 */ }
  mem = Object.assign({}, DEFAULTS, p || {});
  return mem;
}
export function setSetting(k, v) {
  getSettings()[k] = v;
  write(LS, JSON.stringify(mem));
}

// 戰鬥場數(前 5 場預設顯示手勢小抄環)
export function battles() {
  return parseInt(read(LS_BATTLES) || '0', 10) || 0;
}
export function addBattle() {
  write(LS_BATTLES, String(battles() + 1));
}
export function ringVisible() {
  const s = getSettings().ring;
  if (s === 'on') return true;
  if (s === 'off') return false;
  return battles() < 5;
}

// 熟練紀錄:{ charId: { gestureId: true } }
export function mastery() {
  try {
    return JSON.parse(read(LS_MASTER)) || {};
  } catch (e) {
    return {};
  }
}
export function isMastered(charId, gid) {
  const m = mastery();
  return !!(m[charId] && m[charId][gid]);
}
export function setMastered(charId, gid) {
  const m = mastery();
  (m[charId] = m[charId] || {})[gid] = true;
  write(LS_MASTER, JSON.stringify(m));
}

export function tutorialSeen() {
  return !!read(LS_TUT);
}
export function markTutorialSeen() {
  write(LS_TUT, '1');
}
