// 아이마우스 — WebGazer.js gaze engine (not a verified Eye Tracking API).
// Gaze (x,y) from WebGazer drives the soft cursor and edge dwell counts.
// Calibration (wg11/wg12): 9 dots (3×3 grid), NO tap. Each dot shows a ~2 s countdown; once the
// eyes have settled, a few distinct face-present camera frames are recorded for that dot; it
// auto-advances when the countdown ends with enough samples, otherwise the same dot is retried.
// The finished model is saved (wg12: under our own localforage key, loaded by us) so the next
// visit skips calibration; 다시 맞추기 wipes it and calibrates again.
// wg5: edge dots flush on the 4 screen edges, per-axis edge map after calibration, slower cursor.
// wg6: DWELL 1.5s, ambient edge glow, in-app shorts feed demo (not native overlay).
// wg7: up/down only (left/right dwell disabled: no back, no comments), slower cursor.
// wg8: wider bottom count zone, down-biased edge map (WebGazer undershoots down), slightly
//      shorter dwell for down (and earlier commit when deeply near the bottom).
// wg9: hide dwell gauge rails; ambient edge light builds while charging toward up/down,
//      brighter flash on count (unchanged); gaze cursor halved.
// wg10: slower gaze cursor (lower SMOOTH + MAX_SPEED); 1500 ms count cooldown after
//       successful up/down (clears dwell / ambient charge during cooldown).
// wg11: 9-point countdown calibration (no tap); left/right dwell re-enabled (left = 뒤로/댓글 닫기,
//       right = 댓글 열기); ambient glow + cooldown for all four edges; saved calib key v3.
// wg12: accuracy back to wg10 level — stock 50-sample WebGazer window again (wg11's 144 put the
//       ridge fit at n≈120 features, its noisiest point), center 10 + 8×5 samples, longer settle
//       before sampling, edge map from the 4 edge-midpoint dots only, mapped to the true screen
//       edges (as wg10); own storage key so /wg10/ A/B on the same origin can't clobber it; v4.
// wg12-ud: optional up/down-only mode (<html data-dirs="ud"> as in the iOS app, or ?dirs=ud):
//       left/right never count (no back / comments) and their cards/tags/zones are hidden.
//       Calibration (9 dots), saved key, cursor, dwell, glow and cooldown are identical.

const DWELL_MS = 1500; // wg6: was 2000
const DWELL_MS_DOWN = 1200; // wg8: slightly easier to finish a down count
const DWELL_MS_DOWN_DEEP = 1050; // wg8: when ny > DOWN_EARLY_NY
const DOWN_EARLY_NY = 0.72; // wg8: accept near-bottom earlier
const FACE_GRACE_MS = 400;
// wg5: much heavier cursor damping (was 0.28 per frame ≈ 50 ms lag, which felt twitchy/fast).
// CURSOR_SMOOTH is the EMA alpha per 60 fps frame (applied frame-rate independently): 0.06 ≈ 270 ms
// time constant. On top of that the raw WebGazer points go through a short median filter and the
// cursor has a top speed, so single-frame spikes can't fling it to an edge and back.
const CURSOR_SMOOTH = 0.02; // wg10: was 0.035 (≈ 820 ms time constant now)
const CURSOR_MEDIAN_N = 7; // raw gaze points in the median window (~0.25–0.45 s of camera frames)
const CURSOR_MAX_SPEED = 0.45; // viewport widths/heights per second (wg10: was 0.7)
const COUNT_COOLDOWN_MS = 1500; // wg10/wg11: block new counting after any successful count (all 4 dirs)
const CURSOR_HIDE_MS = 1500; // keep the cursor (frozen) through short face/gaze drop-outs
// wg5: edge mapping. Ridge regression shrinks toward the mean of the training targets, so the raw
// gaze never quite reaches the calibration dots and drifts back to the middle. After calibration
// we predict the stored samples of the 4 edge dots and fit a per-axis linear stretch so looking
// at the left/right/top/bottom dot lands the cursor on that screen edge.
const EDGE_MAP_MIN_SPREAD = 0.08; // need at least this much raw left↔right / top↔bottom separation
const EDGE_MAP_GAIN_MIN = 0.7;
const EDGE_MAP_GAIN_MAX = 3.5;
const EDGE_MAP_PER_DOT = 5; // stored samples predicted per edge-midpoint dot (wg12: as wg10)
const READY_MS = 1000;
const COMMIT_HOLD_MS = 700;
// Edge bands (normalized viewport height). Top stays 22%; bottom is wider so looking down
// registers more easily (WebGazer often undershoots the lower edge).
const EDGE_FRAC = 0.22; // left/right side strips (wg11: active again)
const EDGE_FRAC_UP = 0.22; // wg8: unchanged top band
const EDGE_FRAC_DOWN = 0.30; // wg8: bottom 30% (within 28–32%)
const ZONE_HYST = 0.03; // wg11: the zone being dwelt in grows by this much (no flicker at borders)
// Extra Y push toward the bottom after the linear edge map (fraction of viewport height at ny=1).
const EDGE_DOWN_BIAS = 0.10;
// wg11/wg12: no-tap countdown calibration. Each dot: COUNTDOWN_MS visible countdown; frames are
// recorded only after SETTLE_MS (saccade done + WebGazer's frame latency on iPhone), at most one
// per camera frame and spaced a little, only while a face is detected. Too few → retry that dot.
const COUNTDOWN_MS = 2000; // wg12: was 1800
const SETTLE_MS = 750; // wg12: was 380 (early frames could still be mid-saccade / stale)
const FIRST_LEAD_MS = 900; // extra "준비" time before the very first dot's countdown
const RETRY_PAUSE_MS = 700; // short pause (warning shown) before a retried dot restarts
const MIN_POINT_FRAC = 0.6; // need ceil(60%) of a dot's cap (3 of 5, 6 of 10)
const SKIP_AFTER_ATTEMPTS = 4; // after this many tries, accept a dot with >= 2 samples
// wg12: WebGazer 3.5.3's stock 50-sample click window (no patch). Its ridge regression has 120
// eye features and a tiny ridge term and is refit every frame; wg11's 144-sample window landed
// at n≈120 samples, where the least-squares fit is the most noise-sensitive, and was ~3× slower.
// Center keeps 2 shares (10 samples, like wg10), the 8 other dots 1 share (5 each) → 50.
const WG_CLICK_WINDOW = 50;
const CENTER_SHARES = 2;
// wg12: own saved-calibration key (WebGazer's own "webgazerGlobalData" auto-load is off), so the
// untouched wg10 build at /wg10/ on the same origin can't load / overwrite this model.
const SAVE_KEY = "eyemouse.wg12.data";
// wg5: v2 = edge-flush dots. wg11: v3 = 9-point countdown. wg12: v4 (wg11 saves are discarded).
const META_KEY = "eyemouse.wg.calib.v4";
const META_VERSION = 4;
const OLD_META_KEYS = ["eyemouse.wg.calib.v3"]; // wg11 (wg10's v2 is left alone for /wg10/)
const MIN_SAVED_SAMPLES = 10;
const CHECK_MIN_MS = 1500;
const CHECK_MAX_MS = 5000;
const CHECK_MIN_PREDS = 8;
const BEGIN_TIMEOUT_MS = 60000;
// WebGazer 3.5.3 runs face mesh through MediaPipe's legacy WASM solution and, by default,
// looks for its assets at "./mediapipe/face_mesh" relative to the page. This site does not
// host them, so every asset request returned the HTML fallback page ("Unexpected token '<'")
// and begin() rejected with "TypeError: t is not a function". Point it at the matching
// assets that ship inside the same WebGazer npm package.
const WG_FACEMESH_PATH = "https://cdn.jsdelivr.net/npm/webgazer@3.5.3/dist/mediapipe/face_mesh";

// wg11: 3×3 grid. Center first (anchors WebGazer's model), then clockwise around the edge:
// corners + edge midpoints, slightly inset (CSS --calib-inset) so Safari chrome can't clip them.
// t/m/b = top/middle/bottom row, l/c/r = left/center/right column.
const CALIB_ORDER = ["mc", "tl", "tc", "tr", "mr", "br", "bc", "bl", "ml"];

const DIR_META = {
  up: { watch: "위로 보는 중", name: "위" },
  down: { watch: "아래로 보는 중", name: "아래" },
  left: { watch: "왼쪽으로 보는 중", name: "왼쪽" },
  right: { watch: "오른쪽으로 보는 중", name: "오른쪽" },
};
const DIRS = ["up", "down", "left", "right"];
// wg11: all four directions count / drive the feed again (left = 뒤로, right = 댓글).
// wg12-ud: up/down-only when <html data-dirs="ud"> (iOS app) or the URL has ?dirs=ud.
const DIR_MODE = (() => {
  const q = new URLSearchParams(location.search).get("dirs");
  const mode = q === "ud" || q === "4" ? q : document.documentElement.getAttribute("data-dirs") === "ud" ? "ud" : "4";
  document.documentElement.setAttribute("data-dirs", mode); // CSS hides left/right UI in "ud"
  return mode;
})();
const UP_DOWN_ONLY = DIR_MODE === "ud";
const BUILD = UP_DOWN_ONLY ? "wg12-ud" : "wg12";
const ACTIVE_DIRS = UP_DOWN_ONLY ? ["up", "down"] : ["up", "down", "left", "right"];
const EDGE_WORDS = UP_DOWN_ONLY ? "위·아래" : "위·아래·왼쪽·오른쪽";
const DIR_ACT = { up: "다음", down: "이전", left: "뒤로", right: "댓글" };
const DIR_HINT = { up: "위 · 다음", down: "아래 · 이전", left: "왼쪽 · 뒤로", right: "오른쪽 · 댓글" };
const AMBIENT_FLASH_MS = 950; // one light sweep along the committed edge

const CALIB_NAME = {
  mc: "가운데",
  tl: "왼쪽 위",
  tc: "위 가운데",
  tr: "오른쪽 위",
  mr: "오른쪽 가운데",
  br: "오른쪽 아래",
  bc: "아래 가운데",
  bl: "왼쪽 아래",
  ml: "왼쪽 가운데",
};
function calibText(key) {
  return (CALIB_NAME[key] || "") + " 점을 보세요";
}

const cam = document.querySelector("#cam");
const statusEl = document.querySelector("#status");
const gateStatus = document.querySelector("#gate-status");
const gate = document.querySelector("#gate");
const startBtn = document.querySelector("#start");
const clearBtn = document.querySelector("#clear");
const focusEl = document.querySelector("#focus");
const calibDot = document.querySelector("#calib-dot");
const calibCountEl = document.querySelector("#calib-count");
const baselineTrack = document.querySelector("#baseline-track");
const baselineFill = document.querySelector("#baseline-fill");
const calibStepEl = document.querySelector("#calib-step");
const recalibBtn = document.querySelector("#recalib");
const stageEl = document.querySelector(".stage");
const gazeCursor = document.querySelector("#gaze-cursor");
const gazeCursorLabel = document.querySelector("#gaze-cursor-label");
const rails = new Map([...document.querySelectorAll(".rail")].map((el) => [el.dataset.dir, el]));
const countCards = new Map([...document.querySelectorAll(".count")].map((el) => [el.dataset.dir, el]));
const edgeTags = new Map([...document.querySelectorAll(".edge-tag")].map((el) => [el.dataset.dir, el]));
const calibInfo = document.querySelector("#calib-info");
const zones = new Map([...document.querySelectorAll(".zone")].map((el) => [el.dataset.dir, el]));

const counts = { up: 0, down: 0, left: 0, right: 0 };

let running = false;
let started = false;
let phase = "idle"; // idle | check (saved model) | calib | ready | count
let calibIndex = 0;
let sampling = null; // wg11: {key, start, end, base, cap, gap, x, y, lastRec} for the active dot
let recordedTotal = 0; // eye-feature samples actually added to WebGazer (counted in addData)
let pointBase = 0; // recordedTotal when the current dot first appeared (samples accumulate over retries)
let pointAttempts = 0;
let retryTimer = 0;
let backstopTimer = 0;
let checkStart = 0;
let checkPreds = [];
let lastGazeAt = 0;
let lastTick = 0;
let dwellDir = null;
let dwellAcc = 0;
let holdUntil = 0;
let holdDir = null;
let countCooldownUntil = 0; // wg10: performance.now() until which new counting is blocked
let readyAt = 0;
let cursorX = 0.5;
let cursorY = 0.5;
let haveCursor = false;
let cursorVisible = false;
let latestGaze = null; // {x,y} viewport px (raw WebGazer)
let gazeHist = []; // recent raw gaze points for the median filter
let lastCursorAt = 0;
let edgeMap = null; // {ax,bx,ay,by} raw px → screen px, null = identity
let edgeMapJob = 0;
let rafId = 0;

// ---- wg6: ambient edge glow + in-app shorts feed demo ----
const ambientCanvas = document.querySelector("#ambient-glow");
const ambientCtx = ambientCanvas ? ambientCanvas.getContext("2d") : null;
let ambientW = 0;
let ambientH = 0;
let ambientDpr = 1;
// wg9: ambient builds while dwelling (charge), then a brighter flash on commit.
let ambientFlash = null; // {dir, start} while a commit sweep is playing
let ambientCharge = null; // {dir, amount 0..1} while dwelling toward an edge
let ambientDirty = false; // canvas has pixels that need clearing

const feedEl = document.querySelector("#feed");
const feedTrack = document.querySelector("#feed-track");
const feedViewport = document.querySelector("#feed-viewport");
const commentPanel = document.querySelector("#comment-panel");
const commentList = document.querySelector("#comment-list");
const commentCountEl = document.querySelector("#comment-count");
const commentCloseBtn = document.querySelector("#comment-close");
const feedToastEl = document.querySelector("#feed-toast");
let feedIndex = 0;
let feedItems = [];
let commentOpen = false;
let feedToastTimer = 0;
let feedHistory = []; // mild history stack for demo "뒤로가기"
const FEED_DATA = [
  { user: "@시선데모", title: "바다 위를 걷는 듯한 노을", likes: "12.4만", comments: 86, bg: "linear-gradient(145deg,#1b3a4b,#0e8f7a 55%,#f0c27a)" },
  { user: "@아이마우스", title: "카페에서 듣는 비 오는 소리", likes: "8.1만", comments: 42, bg: "linear-gradient(160deg,#2c1810,#c97b4a 50%,#f2d6a2)" },
  { user: "@웹게이저", title: "한강 야경 타임랩스", likes: "21만", comments: 190, bg: "linear-gradient(150deg,#0b1220,#1e3a5f 45%,#6ec6ff)" },
  { user: "@숏폼연습", title: "고양이 vs 레이저 포인터", likes: "33만", comments: 512, bg: "linear-gradient(140deg,#1a1028,#7b3fe4 50%,#ff9bd2)" },
  { user: "@데모피드", title: "요리 30초 레시피 · 계란말이", likes: "5.6만", comments: 73, bg: "linear-gradient(155deg,#1f1408,#d97706 48%,#fde68a)" },
  { user: "@gaze.lab", title: "도시 자전거 출퇴근 브이로그", likes: "9.9만", comments: 118, bg: "linear-gradient(145deg,#0f172a,#334155 50%,#94a3b8)" },
  { user: "@릴스느낌", title: "오늘 들은 플리 · 새벽 감성", likes: "15만", comments: 240, bg: "linear-gradient(160deg,#1a0b2e,#4c1d95 45%,#c4b5fd)" },
  { user: "@인앱시뮬", title: "공원 산책 · 단풍 시작", likes: "6.2만", comments: 55, bg: "linear-gradient(150deg,#1c1917,#b45309 48%,#fcd34d)" },
];
const FAKE_COMMENTS = [
  ["민수", "와 이거 진짜 예쁘다"],
  ["지아", "사운드 뭐예요? 저장함"],
  ["현우", "시선으로 넘긴다는 게 신기함"],
  ["소연", "앱 안 데모라고? 오케이 이해"],
  ["태호", "다음 영상도 넘기고 싶다"],
  ["유나", "댓글도 시선으로 연다고?"],
  ["준혁", "오버레이 아니고 시뮬레이션이구나"],
  ["하늘", "1.5초 응시 느낌 괜찮다"],
  ["별이", "왼쪽이면 뒤로가기군요"],
  ["코코", "연습용으로 최고"],
  ["루나", "커서 부드러움 굿"],
  ["도윤", "다시 맞추기 눌러볼게"],
];


function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = "status" + (kind ? " " + kind : "");
  if (!gate.classList.contains("hidden")) gateStatus.textContent = text;
}

function showLive(text, kind, focusText) {
  setStatus(text, kind);
  focusEl.textContent = focusText;
  focusEl.className = "focus-msg" + (kind ? " " + kind : "");
}

function renderCounts() {
  for (const dir of DIRS) {
    document.querySelector("#n-" + dir).textContent = String(counts[dir]);
  }
}

function popCount(dir) {
  const num = document.querySelector("#n-" + dir);
  num.classList.remove("pop");
  void num.offsetWidth;
  num.classList.add("pop");
}

function zeroCounts() {
  for (const dir of DIRS) counts[dir] = 0;
  renderCounts();
}

function setGauge(dir, amount) {
  const clamped = clamp(amount || 0, 0, 1);
  // wg9: dwell feedback via ambient charge (rails are CSS-hidden).
  if (dir && ACTIVE_DIRS.includes(dir) && clamped > 0) {
    ambientCharge = { dir, amount: clamped };
  } else {
    ambientCharge = null;
  }
  for (const name of DIRS) {
    const el = rails.get(name);
    if (el) {
      const fill = el.querySelector(".rail-fill");
      const on = name === dir && clamped > 0;
      el.classList.toggle("hot", on);
      el.setAttribute("aria-valuenow", on ? String(Math.round(clamped * 100)) : "0");
      if (fill) {
        const scale = on ? clamped : 0;
        if (name === "left" || name === "right") fill.style.transform = "scaleY(" + scale + ")";
        else fill.style.transform = "scaleX(" + scale + ")";
      }
    }
    const card = countCards.get(name);
    if (card) card.classList.toggle("hot", name === dir);
    const tag = edgeTags.get(name);
    if (tag) tag.classList.toggle("hot", name === dir);
    const zone = zones.get(name);
    if (zone) zone.classList.toggle("hot", name === dir);
  }
}

function clearCharge() {
  dwellDir = null;
  dwellAcc = 0;
  holdUntil = 0;
  holdDir = null;
  setGauge(null, 0);
}

// ---- wg6 ambient glow ----
function resizeAmbient() {
  if (!ambientCanvas || !ambientCtx) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = window.innerWidth || 1;
  const h = window.innerHeight || 1;
  if (w === ambientW && h === ambientH && dpr === ambientDpr) return;
  ambientW = w;
  ambientH = h;
  ambientDpr = dpr;
  ambientCanvas.width = Math.round(w * dpr);
  ambientCanvas.height = Math.round(h * dpr);
  ambientCanvas.style.width = w + "px";
  ambientCanvas.style.height = h + "px";
  ambientCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

/** wg7/wg9: start a brighter light sweep along the edge that just counted. */
function flashAmbient(dir) {
  if (!ambientCtx || !ACTIVE_DIRS.includes(dir)) return;
  ambientFlash = { dir, start: performance.now() };
  ambientCharge = null; // commit flash replaces the charge build
}

/**
 * wg11: run `fn(ctx, w, h, top)` in a frame where the target edge is the top (top=true) or bottom
 * (top=false) edge of a w×h rect. Left/right swap the axes, so the same painters draw along the
 * vertical edges (flow runs top→bottom there).
 */
function withEdgeFrame(ctx, w, h, dir, fn) {
  const side = dir === "left" || dir === "right";
  ctx.save();
  if (side) ctx.transform(0, 1, 1, 0, 0, 0); // (u,v) → (x=v, y=u)
  try {
    return fn(ctx, side ? h : w, side ? w : h, dir === "up" || dir === "left");
  } finally {
    ctx.restore();
  }
}

/** Draw soft dwell-charge glow along one edge (amount 0..1). */
function paintAmbientCharge(ctx, w, h, dir, amount, now) {
  return withEdgeFrame(ctx, w, h, dir, (c, ww, hh, top) => paintChargeEdge(c, ww, hh, top, amount, now));
}

function paintChargeEdge(ctx, w, h, top, amount, now) {
  const a = Math.max(0, Math.min(1, amount));
  if (a <= 0.001) return;
  const band = Math.max(22, Math.min(48, Math.min(w, h) * 0.065)) * (0.55 + 0.45 * a);
  const gold = "255,213,106";
  const ey0 = top ? band : h - band;
  const ey1 = top ? 0 : h;
  // Soft base that grows with charge.
  const base = ctx.createLinearGradient(0, ey0, 0, ey1);
  base.addColorStop(0, "rgba(" + gold + ",0)");
  base.addColorStop(1, "rgba(" + gold + "," + (0.12 + 0.38 * a).toFixed(3) + ")");
  ctx.fillStyle = base;
  ctx.fillRect(0, top ? 0 : h - band, w, band);
  // Gentle left→right flow that intensifies as charge builds.
  const t = (now % 1800) / 1800;
  const span = w * (0.35 + 0.25 * a);
  const head = -span * 0.35 + t * (w + span * 0.7);
  const xg = ctx.createLinearGradient(head - span, 0, head + span * 0.2, 0);
  xg.addColorStop(0, "rgba(" + gold + ",0)");
  xg.addColorStop(0.7, "rgba(" + gold + "," + (0.18 + 0.42 * a).toFixed(3) + ")");
  xg.addColorStop(0.88, "rgba(255,244,214," + (0.22 + 0.48 * a).toFixed(3) + ")");
  xg.addColorStop(1, "rgba(" + gold + ",0)");
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, top ? 0 : h - band, w, band);
  ctx.clip();
  ctx.fillStyle = xg;
  ctx.fillRect(0, top ? 0 : h - band, w, band);
  ctx.globalCompositeOperation = "destination-in";
  const fade = ctx.createLinearGradient(0, ey0, 0, ey1);
  fade.addColorStop(0, "rgba(0,0,0,0)");
  fade.addColorStop(0.55, "rgba(0,0,0,0.65)");
  fade.addColorStop(1, "rgba(0,0,0,1)");
  ctx.fillStyle = fade;
  ctx.fillRect(0, top ? 0 : h - band, w, band);
  ctx.restore();
}

/** Draw the brighter commit flash (existing wg7 sweep), on any of the 4 edges. */
function paintAmbientFlash(ctx, w, h, f, now) {
  const p = (now - f.start) / AMBIENT_FLASH_MS;
  if (p >= 1 || p < 0) return false;
  return withEdgeFrame(ctx, w, h, f.dir, (c, ww, hh, top) => paintFlashEdge(c, ww, hh, top, p));
}

function paintFlashEdge(ctx, w, h, top, p) {
  const band = Math.max(26, Math.min(54, Math.min(w, h) * 0.07));
  const env = p < 0.15 ? p / 0.15 : Math.pow(1 - (p - 0.15) / 0.85, 1.6);
  const gold = "255,213,106";
  const ey0 = top ? band : h - band;
  const ey1 = top ? 0 : h;
  const base = ctx.createLinearGradient(0, ey0, 0, ey1);
  base.addColorStop(0, "rgba(" + gold + ",0)");
  base.addColorStop(1, "rgba(" + gold + "," + (0.28 * env).toFixed(3) + ")");
  ctx.fillStyle = base;
  ctx.fillRect(0, top ? 0 : h - band, w, band);
  const ease = 1 - Math.pow(1 - p, 2.2);
  const span = w * 0.55;
  const head = -span * 0.3 + ease * (w + span * 0.6);
  const xg = ctx.createLinearGradient(head - span, 0, head + span * 0.18, 0);
  xg.addColorStop(0, "rgba(" + gold + ",0)");
  xg.addColorStop(0.75, "rgba(" + gold + "," + (0.55 * env).toFixed(3) + ")");
  xg.addColorStop(0.86, "rgba(255,244,214," + (0.9 * env).toFixed(3) + ")");
  xg.addColorStop(1, "rgba(" + gold + ",0)");
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, top ? 0 : h - band, w, band);
  ctx.clip();
  ctx.fillStyle = xg;
  ctx.fillRect(0, top ? 0 : h - band, w, band);
  ctx.globalCompositeOperation = "destination-in";
  const fade = ctx.createLinearGradient(0, ey0, 0, ey1);
  fade.addColorStop(0, "rgba(0,0,0,0)");
  fade.addColorStop(0.6, "rgba(0,0,0,0.7)");
  fade.addColorStop(1, "rgba(0,0,0,1)");
  ctx.fillStyle = fade;
  ctx.fillRect(0, top ? 0 : h - band, w, band);
  ctx.restore();
  return true;
}

/** wg9: paint dwell charge and/or commit flash; otherwise clear. */
function paintAmbient(now) {
  if (!ambientCtx || !ambientCanvas) return;
  now = now || performance.now();
  const f = ambientFlash;
  const c = ambientCharge;
  const flashLive = f && ((now - f.start) / AMBIENT_FLASH_MS) < 1 && ((now - f.start) / AMBIENT_FLASH_MS) >= 0;
  if (!flashLive && f) ambientFlash = null;
  if (!flashLive && !c) {
    if (ambientDirty) {
      ambientCtx.clearRect(0, 0, ambientW, ambientH);
      ambientDirty = false;
    }
    return;
  }
  resizeAmbient();
  const w = ambientW;
  const h = ambientH;
  const ctx = ambientCtx;
  ctx.clearRect(0, 0, w, h);
  ambientDirty = true;
  // Charge under flash: if flash is playing, only flash (brighter).
  if (flashLive) {
    paintAmbientFlash(ctx, w, h, f, now);
  } else if (c && ACTIVE_DIRS.includes(c.dir)) {
    paintAmbientCharge(ctx, w, h, c.dir, c.amount, now);
  }
}

// ---- wg6 in-app feed demo ----
function buildFeed() {
  if (!feedTrack) return;
  feedTrack.innerHTML = "";
  feedItems = FEED_DATA.map((d, i) => {
    const el = document.createElement("article");
    el.className = "feed-item";
    el.style.setProperty("--feed-bg", d.bg);
    el.style.backgroundImage = "linear-gradient(180deg,rgba(0,0,0,0.05) 0%,rgba(0,0,0,0.5) 55%,rgba(0,0,0,0.82) 100%)," + d.bg;
    el.innerHTML =
      '<span class="feed-index">' + (i + 1) + "/" + FEED_DATA.length + "</span>" +
      '<div class="feed-side">' +
        '<span><span class="ico">♥</span>' + d.likes + "</span>" +
        '<span><span class="ico">💬</span>댓글</span>' +
        '<span><span class="ico">↗</span>공유</span>' +
      "</div>" +
      '<div class="feed-meta">' +
        '<span class="feed-user">' + d.user + "</span>" +
        '<p class="feed-title">' + d.title + "</p>" +
        '<span class="feed-stats">좋아요 ' + d.likes + " · 댓글 " + d.comments + "</span>" +
      "</div>";
    feedTrack.appendChild(el);
    return el;
  });
  feedIndex = 0;
  layoutFeedItems();
  applyFeedTransform(false);
}

function layoutFeedItems() {
  if (!feedViewport || !feedItems.length) return;
  const h = feedViewport.clientHeight || 1;
  feedItems.forEach((el, i) => {
    el.style.top = i * h + "px";
    el.style.height = h + "px";
  });
  feedTrack.style.height = feedItems.length * h + "px";
}

function applyFeedTransform(animate) {
  if (!feedTrack || !feedViewport) return;
  const h = feedViewport.clientHeight || 1;
  if (!animate) feedTrack.style.transition = "none";
  feedTrack.style.transform = "translateY(" + (-feedIndex * h) + "px)";
  if (!animate) {
    void feedTrack.offsetWidth;
    feedTrack.style.transition = "";
  }
}

function showFeed() {
  if (!feedEl) return;
  if (!feedItems.length) buildFeed();
  feedEl.hidden = false;
  document.body.classList.add("feed-on");
  layoutFeedItems();
  applyFeedTransform(false);
  closeComments(false);
}

function hideFeed() {
  if (!feedEl) return;
  feedEl.hidden = true;
  document.body.classList.remove("feed-on");
  closeComments(false);
  feedHistory = [];
}

function showFeedToast(text) {
  if (!feedToastEl) return;
  feedToastEl.hidden = false;
  feedToastEl.textContent = text;
  window.clearTimeout(feedToastTimer);
  feedToastTimer = window.setTimeout(() => {
    feedToastEl.hidden = true;
  }, 900);
}

function openComments() {
  if (!commentPanel || !commentList) return;
  commentList.innerHTML = "";
  const item = FEED_DATA[feedIndex] || FEED_DATA[0];
  const n = item.comments || FAKE_COMMENTS.length;
  if (commentCountEl) commentCountEl.textContent = String(n);
  for (const [user, text] of FAKE_COMMENTS) {
    const li = document.createElement("li");
    li.innerHTML = '<span class="c-user">' + user + "</span>" + text;
    commentList.appendChild(li);
  }
  commentPanel.hidden = false;
  commentOpen = true;
  feedHistory.push({ type: "comments", index: feedIndex });
  showFeedToast("댓글 열림");
}

function closeComments(toast) {
  if (commentPanel) commentPanel.hidden = true;
  commentOpen = false;
  if (toast) showFeedToast("댓글 닫힘 · 뒤로가기");
}

/** wg11: moving to another video closes an open comment panel (quietly). */
function dropComments() {
  if (!commentOpen) return;
  while (feedHistory.length && feedHistory[feedHistory.length - 1].type === "comments") feedHistory.pop();
  closeComments(false);
}

function feedNext() {
  if (!feedItems.length) return;
  dropComments();
  if (feedIndex >= feedItems.length - 1) {
    showFeedToast("마지막 영상");
    return;
  }
  feedIndex += 1;
  applyFeedTransform(true);
  showFeedToast("위로 스와이프 · 다음");
}

function feedPrev() {
  if (!feedItems.length) return;
  dropComments();
  if (feedIndex <= 0) {
    showFeedToast("첫 영상");
    return;
  }
  feedIndex -= 1;
  applyFeedTransform(true);
  showFeedToast("아래로 스와이프 · 이전");
}

function feedBack() {
  if (commentOpen) {
    // Pop comment overlay.
    while (feedHistory.length && feedHistory[feedHistory.length - 1].type === "comments") feedHistory.pop();
    closeComments(true);
    return;
  }
  if (feedHistory.length) {
    feedHistory.pop();
    showFeedToast("뒤로가기 (데모 기록)");
    return;
  }
  // Mild history-style back: step to previous item if possible, else toast.
  if (feedIndex > 0) {
    feedIndex -= 1;
    applyFeedTransform(true);
    showFeedToast("뒤로가기 · 이전 영상");
  } else {
    showFeedToast("뒤로가기 (데모 · 더 이상 없음)");
  }
}

function onFeedAction(dir) {
  if (feedEl && feedEl.hidden) return;
  if (!ACTIVE_DIRS.includes(dir)) return; // wg12-ud: left/right off
  // wg11: up = 다음, down = 이전, left = 뒤로가기 (댓글 닫기), right = 댓글 열기.
  if (dir === "up") feedNext();
  else if (dir === "down") feedPrev();
  else if (dir === "left") feedBack();
  else if (dir === "right") {
    if (commentOpen) showFeedToast("댓글 열려 있음 · 왼쪽 = 닫기");
    else openComments();
  }
}


function setBaselineUi(active, amount) {
  baselineTrack.hidden = !active;
  calibStepEl.hidden = !active;
  baselineFill.style.transform = "scaleX(" + clamp(amount, 0, 1) + ")";
}

function showGazeCursor(on) {
  cursorVisible = on;
  gazeCursor.hidden = !on;
  gazeCursorLabel.hidden = !on;
  gazeCursor.classList.toggle("on", on);
}

function applyEdgeMap(p) {
  if (!p) return p;
  let x = p.x;
  let y = p.y;
  if (edgeMap) {
    x = edgeMap.ax * p.x + edgeMap.bx;
    y = edgeMap.ay * p.y + edgeMap.by;
  }
  // wg8: WebGazer often undershoots looking down — stretch the lower half further toward the bottom.
  const vh = window.innerHeight || 1;
  const ny = y / vh;
  if (ny > 0.5 && EDGE_DOWN_BIAS > 0) {
    y = y + (ny - 0.5) * 2 * EDGE_DOWN_BIAS * vh;
  }
  return { x, y };
}

function pushGaze(p) {
  gazeHist.push(p);
  if (gazeHist.length > CURSOR_MEDIAN_N) gazeHist.shift();
}

/** Median-filtered, edge-mapped gaze in viewport px (null if no recent gaze). */
function filteredGaze() {
  if (!gazeHist.length) return null;
  return applyEdgeMap({ x: median(gazeHist.map((p) => p.x)), y: median(gazeHist.map((p) => p.y)) });
}

/** Smoothed cursor position in viewport px, or null if no cursor yet. */
function cursorPx() {
  if (!haveCursor) return null;
  return { x: cursorX * (window.innerWidth || 1), y: cursorY * (window.innerHeight || 1) };
}

function resetCursor() {
  haveCursor = false;
  gazeHist = [];
  lastCursorAt = 0;
  showGazeCursor(false);
}

/**
 * gaze: filtered/mapped viewport px, or null when gaze is stale. A brief drop-out freezes the
 * cursor where it is (no reset → no jump back to center when gaze returns); it only hides after
 * CURSOR_HIDE_MS. Motion = frame-rate independent EMA + top speed.
 */
function updateGazeCursor(gaze, now) {
  if (!running) {
    resetCursor();
    return;
  }
  now = now || performance.now();
  const dt = lastCursorAt ? Math.min(100, Math.max(0, now - lastCursorAt)) : 16.7;
  lastCursorAt = now;
  if (!gaze) {
    if (haveCursor && now - lastGazeAt > CURSOR_HIDE_MS) showGazeCursor(false);
    return;
  }
  const vw = window.innerWidth || 1;
  const vh = window.innerHeight || 1;
  // Edge-calibrated: the cursor may sit right on any screen edge.
  const tx = clamp(gaze.x / vw, 0, 1);
  const ty = clamp(gaze.y / vh, 0, 1);
  if (!haveCursor) {
    cursorX = tx;
    cursorY = ty;
    haveCursor = true;
  } else {
    const a = 1 - Math.pow(1 - CURSOR_SMOOTH, dt / 16.7);
    const maxStep = (CURSOR_MAX_SPEED * dt) / 1000;
    cursorX += clamp((tx - cursorX) * a, -maxStep, maxStep);
    cursorY += clamp((ty - cursorY) * a, -maxStep, maxStep);
  }
  gazeCursor.style.left = cursorX * vw + "px";
  gazeCursor.style.top = cursorY * vh + "px";
  showGazeCursor(true);
}

/**
 * Map the (edge-mapped, smoothed) gaze to an edge zone, or null = empty center.
 * Zones (normalized viewport; wg8 asymmetric up/down, wg11 left/right side strips):
 *   up    = full-width band, y < EDGE_FRAC_UP (0.22)
 *   down  = full-width band, y > 1 - EDGE_FRAC_DOWN (0.70)
 *   left  = x < EDGE_FRAC (0.22), between the up and down bands
 *   right = x > 1 - EDGE_FRAC, between the up and down bands
 * Up/down win in the corners (same bands as wg8–wg10). The zone being dwelt in grows by
 * ZONE_HYST so edge jitter does not reset the dwell timer.
 */
function inZone(d, nx, ny, extra) {
  const upEdge = EDGE_FRAC_UP;
  const downEdge = 1 - EDGE_FRAC_DOWN;
  switch (d) {
    case "up":
      return ny < upEdge + extra;
    case "down":
      return ny > downEdge - extra;
    case "left":
      return nx < EDGE_FRAC + extra && ny >= upEdge - extra && ny <= downEdge + extra;
    case "right":
      return nx > 1 - EDGE_FRAC - extra && ny >= upEdge - extra && ny <= downEdge + extra;
    default:
      return false;
  }
}

function directionFromGaze(gaze, current) {
  if (!gaze) return null;
  const vw = window.innerWidth || 1;
  const vh = window.innerHeight || 1;
  const nx = clamp(gaze.x / vw, 0, 1);
  const ny = clamp(gaze.y / vh, 0, 1);
  if (current && ACTIVE_DIRS.includes(current) && inZone(current, nx, ny, ZONE_HYST)) return current;
  for (const d of ["up", "down", "left", "right"]) {
    if (ACTIVE_DIRS.includes(d) && inZone(d, nx, ny, 0)) return d;
  }
  return null;
}

/** Draw the zones exactly as directionFromGaze splits them. */
function layoutZones() {
  const aUp = EDGE_FRAC_UP * 100 + "%";
  const bDown = (1 - EDGE_FRAC_DOWN) * 100 + "%";
  const a = EDGE_FRAC * 100 + "%";
  const b = (1 - EDGE_FRAC) * 100 + "%";
  const shapes = {
    up: `polygon(0 0, 100% 0, 100% ${aUp}, 0 ${aUp})`,
    down: `polygon(0 100%, 100% 100%, 100% ${bDown}, 0 ${bDown})`,
    left: `polygon(0 ${aUp}, ${a} ${aUp}, ${a} ${bDown}, 0 ${bDown})`,
    right: `polygon(100% ${aUp}, ${b} ${aUp}, ${b} ${bDown}, 100% ${bDown})`,
  };
  for (const [dir, el] of zones) {
    el.style.clipPath = shapes[dir];
    el.style.webkitClipPath = shapes[dir];
  }
}

function placeCalibDot(key) {
  calibDot.hidden = false;
  calibDot.className = "calib-dot p-" + key;
  calibDot.style.setProperty("--p", "0");
  if (calibCountEl) calibCountEl.textContent = "";
  calibDot.setAttribute("aria-label", calibText(key));
}

function hideCalibDot() {
  calibDot.hidden = true;
  calibDot.className = "calib-dot";
  calibDot.style.setProperty("--p", "0");
  if (calibCountEl) calibCountEl.textContent = "";
}

function stepLabel() {
  return calibIndex + 1 + "/" + CALIB_ORDER.length;
}

/** Overall calibration progress 0..1 (finished dots + countdown of the current one). */
function calibProgress(frac) {
  return (calibIndex + clamp(frac || 0, 0, 1)) / CALIB_ORDER.length;
}

// ---- wg5: edge map (stretch raw gaze so the 4 edge dots land on the 4 screen edges) ----

/** Raw ridge prediction for one stored sample, bypassing (and not disturbing) WebGazer's Kalman. */
function predictRaw(r, eyes) {
  const k = r.kalman;
  r.kalman = { update: (v) => v };
  try {
    return r.predict(eyes);
  } catch (err) {
    return null;
  } finally {
    r.kalman = k;
  }
}

/**
 * Group stored samples by target (dot). wg12: like wg10, the edge map uses only the 4 edge
 * midpoint dots (left-middle, right-middle, top-center, bottom-center); corners still train the
 * model but WebGazer is weakest there and averaging them in compressed/skewed the map.
 */
function edgeGroups(data) {
  const groups = new Map();
  for (const s of data) {
    if (!s || !s.eyes || !s.screenPos) continue;
    const key = Math.round(s.screenPos[0] / 8) + ":" + Math.round(s.screenPos[1] / 8);
    if (!groups.has(key)) groups.set(key, { tx: s.screenPos[0], ty: s.screenPos[1], samples: [] });
    groups.get(key).samples.push(s);
  }
  const list = [...groups.values()];
  if (list.length < 2) return null;
  const vw = window.innerWidth || 1;
  const vh = window.innerHeight || 1;
  const minX = Math.min(...list.map((g) => g.tx));
  const maxX = Math.max(...list.map((g) => g.tx));
  const minY = Math.min(...list.map((g) => g.ty));
  const maxY = Math.max(...list.map((g) => g.ty));
  // Among the dots on one side, take the one closest to that edge's midpoint.
  const pick = (onSide, dist) => {
    const side = list.filter(onSide);
    return side.reduce((best, g) => (dist(g) < dist(best) ? g : best), side[0]);
  };
  return {
    left: pick((g) => g.tx <= minX + vw * 0.08, (g) => Math.abs(g.ty - vh / 2)),
    right: pick((g) => g.tx >= maxX - vw * 0.08, (g) => Math.abs(g.ty - vh / 2)),
    up: pick((g) => g.ty <= minY + vh * 0.08, (g) => Math.abs(g.tx - vw / 2)),
    down: pick((g) => g.ty >= maxY - vh * 0.08, (g) => Math.abs(g.tx - vw / 2)),
  };
}

function fitAxis(lo, hi, pLo, pHi, span) {
  if (!Number.isFinite(pLo) || !Number.isFinite(pHi)) return null;
  if (hi - lo < span * 0.5) return null; // dots not on opposite edges
  if (pHi - pLo < span * EDGE_MAP_MIN_SPREAD) return null; // model can't tell the sides apart
  const a = clamp((hi - lo) / (pHi - pLo), EDGE_MAP_GAIN_MIN, EDGE_MAP_GAIN_MAX);
  const b = (lo + hi) / 2 - (a * (pLo + pHi)) / 2;
  return { a, b };
}

/** Async (chunked) so the ~20 ridge solves don't freeze the page. */
function computeEdgeMap() {
  const job = ++edgeMapJob;
  edgeMap = null;
  const r = regModel();
  const data = modelData();
  const g = r && typeof r.predict === "function" ? edgeGroups(data) : null;
  if (!g) return Promise.resolve(null);
  const sides = ["left", "right", "up", "down"];
  const queue = [];
  for (const side of sides) {
    const ss = g[side].samples;
    const step = Math.max(1, Math.floor(ss.length / EDGE_MAP_PER_DOT));
    for (let i = 0, n = 0; i < ss.length && n < EDGE_MAP_PER_DOT; i += step, n += 1) {
      queue.push({ side, eyes: ss[i].eyes });
    }
  }
  const preds = { left: [], right: [], up: [], down: [] };
  return new Promise((resolve) => {
    const work = () => {
      if (job !== edgeMapJob) return resolve(null);
      const t0 = performance.now();
      while (queue.length && performance.now() - t0 < 12) {
        const q = queue.shift();
        const p = predictRaw(r, q.eyes);
        if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) preds[q.side].push(p);
      }
      if (queue.length) {
        window.setTimeout(work, 0);
        return;
      }
      const vw = window.innerWidth || 1;
      const vh = window.innerHeight || 1;
      const mx = (side) => median(preds[side].map((p) => p.x));
      const my = (side) => median(preds[side].map((p) => p.y));
      // wg12: the dots are inset ~30px, but (as in wg10, whose dots sat on the edges) looking at an
      // edge-midpoint dot should land the cursor on the true screen edge.
      const fx = fitAxis(Math.min(g.left.tx, 0), Math.max(g.right.tx, vw), mx("left"), mx("right"), vw);
      // wg8: aim the down calibration median a bit past the screen bottom so looking at the
      // bottom training dot lands on (or past) the edge after clamp — counters undershoot.
      const downTarget = Math.max(g.down.ty, vh) + vh * 0.06;
      const fy = fitAxis(Math.min(g.up.ty, 0), downTarget, my("up"), my("down"), vh);
      const map = { ax: fx ? fx.a : 1, bx: fx ? fx.b : 0, ay: fy ? fy.a : 1, by: fy ? fy.b : 0 };
      edgeMap = fx || fy ? map : null;
      console.info("[eyemouse] edge map", edgeMap, { left: mx("left"), right: mx("right"), up: my("up"), down: my("down") });
      resolve(edgeMap);
    };
    window.setTimeout(work, 0);
  });
}

// ---- Saved calibration (wg12: our own localforage key; WebGazer's auto save/load is off) ----

function regModel() {
  try {
    const regs = window.webgazer && typeof webgazer.getRegression === "function" ? webgazer.getRegression() : null;
    return regs && regs[0] ? regs[0] : null;
  } catch (err) {
    return null;
  }
}

function modelData() {
  const r = regModel();
  const d = r && typeof r.getData === "function" ? r.getData() : null;
  return Array.isArray(d) ? d : [];
}

/** Persistent one-liner under the status: is the current calibration saved? */
function setCalibInfo(text) {
  calibInfo.hidden = !text;
  calibInfo.textContent = text || "";
}

function savedTimeText(meta) {
  try {
    const d = new Date(meta.savedAt);
    return d.toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch (err) {
    return "";
  }
}

function readSavedMeta() {
  try {
    const m = JSON.parse(localStorage.getItem(META_KEY) || "null");
    return m && m.v === META_VERSION && m.points === CALIB_ORDER.length && m.n > 0 ? m : null;
  } catch (err) {
    return null;
  }
}

/** Saved px targets only make sense for a similar viewport (same orientation, similar size). */
function layoutMatches(meta) {
  const vw = window.innerWidth || 1;
  const vh = window.innerHeight || 1;
  if (vw > vh !== meta.vw > meta.vh) return false;
  return Math.abs(vw - meta.vw) / meta.vw < 0.15 && Math.abs(vh - meta.vh) / meta.vh < 0.25;
}

function plainEye(e) {
  return {
    width: e.width,
    height: e.height,
    imagex: e.imagex,
    imagey: e.imagey,
    blink: e.blink,
    // WebGazer's setData() rebuilds ImageData from patch.data + width/height.
    patch: { data: new Uint8ClampedArray(e.patch.data) },
  };
}

async function saveCalibration() {
  const lf = window.localforage;
  const raw = modelData();
  if (!lf || !raw.length) return false;
  const copy = [];
  for (const s of raw) {
    if (!s || !s.eyes || !s.eyes.left || !s.eyes.right || !s.eyes.left.patch || !s.eyes.right.patch) continue;
    copy.push({
      eyes: { left: plainEye(s.eyes.left), right: plainEye(s.eyes.right) },
      screenPos: [s.screenPos[0], s.screenPos[1]],
      type: s.type || "click",
    });
  }
  if (!copy.length) return false;
  await lf.setItem(SAVE_KEY, copy);
  localStorage.setItem(
    META_KEY,
    JSON.stringify({
      v: META_VERSION,
      points: CALIB_ORDER.length,
      savedAt: Date.now(),
      vw: window.innerWidth,
      vh: window.innerHeight,
      n: copy.length,
    })
  );
  return true;
}

function clearSavedCalibration() {
  try {
    localStorage.removeItem(META_KEY);
    for (const k of OLD_META_KEYS) localStorage.removeItem(k);
  } catch (err) {
    console.warn(err);
  }
  try {
    // wg12: reset only the in-memory regression model. webgazer.clearData() would also
    // localforage.clear() every key (incl. the /wg10/ build's saved model).
    const r = regModel();
    if (r && typeof r.init === "function") r.init();
  } catch (err) {
    console.warn(err);
  }
  try {
    if (window.localforage) window.localforage.removeItem(SAVE_KEY).catch(() => {});
  } catch (err) {
    console.warn(err);
  }
}

/** wg12: load our saved samples into the (fresh) regression model. */
async function loadSavedCalibration() {
  const lf = window.localforage;
  const r = regModel();
  if (!lf || !r || typeof r.setData !== "function") return false;
  try {
    const data = await lf.getItem(SAVE_KEY);
    if (!Array.isArray(data) || data.length < MIN_SAVED_SAMPLES) return false;
    if (typeof r.init === "function") r.init();
    r.setData(data);
    return modelData().length >= MIN_SAVED_SAMPLES;
  } catch (err) {
    console.warn("[eyemouse] saved calibration load failed", err);
    return false;
  }
}

/** Try the saved model: wait for predictions, accept if they look sane, else calibrate. */
function beginSavedCheck(now) {
  phase = "check";
  checkStart = now;
  checkPreds = [];
  document.body.classList.remove("calibrating");
  document.documentElement.classList.remove("calibrating");
  hideFeed();
  hideCalibDot();
  setBaselineUi(false, 0);
  clearCharge();
  showLive("저장된 맞춤 불러오는 중… 화면을 보세요", "idle", "저장된 맞춤 확인 중");
}

function median(arr) {
  const a = arr.slice().sort((p, q) => p - q);
  return a.length ? a[Math.floor(a.length / 2)] : NaN;
}

function savedPredictionsUsable() {
  if (modelData().length < MIN_SAVED_SAMPLES) return false;
  if (checkPreds.length < CHECK_MIN_PREDS) return false;
  const vw = window.innerWidth || 1;
  const vh = window.innerHeight || 1;
  const mx = median(checkPreds.map((p) => p.x)) / vw;
  const my = median(checkPreds.map((p) => p.y)) / vh;
  return mx > -0.25 && mx < 1.25 && my > -0.25 && my < 1.25;
}

function tickCheck(now) {
  updateGazeCursor(filteredGaze(), now);
  const elapsed = now - checkStart;
  if (elapsed >= CHECK_MIN_MS && savedPredictionsUsable()) {
    phase = "ready";
    computeEdgeMap();
    readyAt = now + READY_MS;
    clearCharge();
    lastTick = 0;
    showLive("저장된 맞춤 사용 중 · 어긋나면 ‘다시 맞추기’", "ok", "저장된 맞춤으로 시작");
    const meta = readSavedMeta();
    setCalibInfo("저장된 맞춤 사용 중" + (meta ? " (" + savedTimeText(meta) + ")" : "") + " · 어긋나면 ‘다시 맞추기’");
    return;
  }
  if (elapsed >= CHECK_MAX_MS) {
    beginCalibration("저장된 맞춤이 잘 안 맞아 다시 맞춥니다 · ");
  }
}

/**
 * wg11: show dot `index` and start its countdown. No tap: frames are recorded in onGaze while the
 * countdown runs; tickSampling() advances (or retries) when it ends. `retry` keeps the samples
 * already recorded for this dot and just runs another countdown.
 */
function startPoint(index, opts) {
  opts = opts || {};
  window.clearTimeout(retryTimer);
  window.clearTimeout(backstopTimer);
  calibIndex = index;
  const key = CALIB_ORDER[calibIndex];
  ensureRecordCounter();
  if (!opts.retry) {
    pointBase = recordedTotal;
    pointAttempts = 0;
  }
  pointAttempts += 1;
  placeCalibDot(key);
  calibDot.classList.add("wait");
  const c = dotCenter();
  const now = performance.now();
  const lead = opts.lead || 0;
  const cap = perPointCap(key);
  const token = {
    key,
    start: now + lead,
    end: now + lead + COUNTDOWN_MS,
    base: pointBase,
    cap,
    // Spread the samples a little (distinct eye images), but finish well before the countdown ends.
    gap: clamp(((COUNTDOWN_MS - SETTLE_MS) / cap) * 0.6, 50, 140),
    x: c.x,
    y: c.y,
    lastRec: 0,
  };
  sampling = token;
  calibStepEl.textContent = stepLabel() + " · 점을 보세요";
  setBaselineUi(true, calibProgress(0));
  if (!opts.keepStatus) {
    const lead1 = lead > 0 ? "준비 · " : "";
    showLive(lead1 + calibText(key) + " · " + stepLabel(), "idle", lead > 0 ? "점을 보세요 · 준비" : "점을 보세요");
  } else {
    // Retry: keep the warning in the status line, reset the big countdown text.
    focusEl.textContent = "점을 보세요";
    focusEl.className = "focus-msg idle";
  }
  // Backstop in case rAF is throttled/paused: finish this dot even if tick() never runs.
  backstopTimer = window.setTimeout(() => {
    if (sampling === token && phase === "calib") tickSampling(performance.now(), true);
  }, lead + COUNTDOWN_MS + 400);
}

function beginCalibration(note) {
  phase = "calib";
  document.body.classList.add("calibrating");
  document.documentElement.classList.add("calibrating");
  hideFeed();
  zeroCounts();
  clearCharge();
  countCooldownUntil = 0;
  lastTick = 0;
  latestGaze = null;
  edgeMapJob += 1;
  edgeMap = null;
  resetCursor();
  readyAt = 0;
  sampling = null;
  window.clearTimeout(retryTimer);
  window.clearTimeout(backstopTimer);
  clearSavedCalibration();
  setCalibInfo("");
  startPoint(0, { lead: FIRST_LEAD_MS });
  if (note) setStatus(note + calibText(CALIB_ORDER[0]) + " · " + stepLabel(), "idle");
}

function finishCalibration(now) {
  phase = "ready";
  sampling = null;
  window.clearTimeout(retryTimer);
  window.clearTimeout(backstopTimer);
  readyAt = now + READY_MS;
  document.body.classList.remove("calibrating");
  document.documentElement.classList.remove("calibrating");
  hideCalibDot();
  setBaselineUi(false, 0);
  clearCharge();
  lastTick = 0;
  showLive("맞춤 완료 · 저장하는 중…", "ok", "맞춤 완료 · 방향을 보세요");
  computeEdgeMap();
  saveCalibration()
    .then((ok) => {
      if (phase !== "ready" && phase !== "count") return;
      setStatus(ok ? "맞춤 저장됨 · 다음엔 바로 시작합니다" : "맞춤 완료 · 저장은 못 했어요(이번만 사용)", ok ? "ok" : "warn");
      setCalibInfo(ok ? "맞춤 저장됨 · 다음 방문에 바로 사용 · 어긋나면 ‘다시 맞추기’" : "맞춤 저장 안 됨 · 이번 방문에만 사용");
    })
    .catch((err) => {
      console.warn(err);
      if (phase === "ready" || phase === "count") setStatus("맞춤 완료 · 저장 실패(이번만 사용)", "warn");
      setCalibInfo("맞춤 저장 안 됨 · 이번 방문에만 사용");
    });
}

function dotCenter() {
  const rect = calibDot.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

/** Count samples WebGazer really stores (it silently drops a record when no face/eyes). */
function ensureRecordCounter() {
  const r = regModel();
  if (!r || r.__emCounted || typeof r.addData !== "function") return !!(r && r.__emCounted);
  const orig = r.addData;
  r.addData = function (eyes, pos, type) {
    if (eyes && type === "click") recordedTotal += 1;
    return orig.apply(this, arguments);
  };
  r.__emCounted = true;
  return true;
}

function samplesThisPoint() {
  return sampling ? recordedTotal - sampling.base : 0;
}

/** wg12: stock 50-sample window split by shares: center 2 (10 samples), every other dot 1 (5). */
function perPointCap(key) {
  const r = regModel();
  const win = (r && r.dataClicks && r.dataClicks.windowSize) || WG_CLICK_WINDOW;
  const shares = CALIB_ORDER.length - 1 + CENTER_SHARES;
  const per = Math.max(1, Math.floor(win / shares));
  return key === "mc" ? per * CENTER_SHARES : per;
}

function recordAt(x, y) {
  if (!window.webgazer || typeof webgazer.recordScreenPosition !== "function") return;
  try {
    webgazer.recordScreenPosition(x, y, "click");
  } catch (err) {
    console.warn(err);
  }
}

/**
 * Called from onGaze (once per processed camera frame): record this frame for the active dot if
 * the countdown is in its sampling window, a face is present, and the per-dot cap/spacing allow.
 */
function sampleFrame(data, now) {
  const sm = sampling;
  if (!sm || phase !== "calib") return;
  if (now < sm.start + SETTLE_MS || now > sm.end) return;
  if (samplesThisPoint() >= sm.cap) return;
  if (sm.lastRec && now - sm.lastRec < sm.gap) return;
  // Face present: WebGazer passes null when it has no eye features. With an empty model it
  // can't predict yet (null too), so then we rely on addData dropping face-less frames.
  const faceOk = (data && Number.isFinite(data.x) && Number.isFinite(data.y)) || modelData().length === 0;
  if (!faceOk) return;
  const before = recordedTotal;
  recordAt(sm.x, sm.y);
  if (recordedTotal > before) sm.lastRec = now;
}

function advancePoint(now) {
  sampling = null;
  window.clearTimeout(backstopTimer);
  setBaselineUi(true, calibProgress(1));
  if (calibIndex + 1 < CALIB_ORDER.length) {
    startPoint(calibIndex + 1);
    return;
  }
  if (!modelData().length) {
    // Not a single frame had a face: nothing to save or predict with.
    beginCalibration("얼굴이 한 번도 안 잡혔어요 · 밝은 곳에서 얼굴을 카메라에 맞추고 다시 · ");
    return;
  }
  finishCalibration(now);
}

/** Retry the current dot: keep its samples, warn, short pause, then a fresh countdown. */
function retryPoint(got) {
  const key = CALIB_ORDER[calibIndex];
  const idx = calibIndex;
  sampling = null;
  window.clearTimeout(backstopTimer);
  calibDot.classList.remove("wait", "sampling");
  calibDot.classList.add("retry");
  calibDot.style.setProperty("--p", "0");
  if (calibCountEl) calibCountEl.textContent = "!";
  calibStepEl.textContent = stepLabel() + " · 다시";
  const why =
    got > 0 ? "시선이 덜 잡혔어요" : pointAttempts >= 3 ? "얼굴이 계속 안 잡혀요 · 밝은 곳에서 얼굴을 카메라 정면에" : "얼굴이 안 잡혔어요";
  showLive(why + " · 같은 점을 한 번 더 봐 주세요 · " + stepLabel(), "warn", "다시 · " + calibText(key));
  retryTimer = window.setTimeout(() => {
    if (phase !== "calib" || calibIndex !== idx) return;
    startPoint(idx, { retry: true, keepStatus: true });
  }, RETRY_PAUSE_MS);
}

/** Called every frame while a dot is active: countdown UI, then advance / retry at the end. */
function tickSampling(now, force) {
  const sm = sampling;
  if (!sm) return;
  const got = samplesThisPoint();
  if (!force && now < sm.end) {
    if (now < sm.start) return; // lead-in ("준비") before the first dot's countdown
    const elapsed = now - sm.start;
    const frac = clamp(elapsed / COUNTDOWN_MS, 0, 1);
    const remain = Math.max(0, sm.end - now);
    calibDot.classList.remove("wait", "retry");
    calibDot.classList.add("sampling");
    calibDot.style.setProperty("--p", frac.toFixed(3));
    if (calibCountEl) calibCountEl.textContent = String(Math.max(1, Math.ceil(remain / 1000)));
    setBaselineUi(true, calibProgress(frac));
    const secs = (Math.ceil(remain / 100) / 10).toFixed(1);
    focusEl.textContent = "점을 보세요 · " + secs;
    return;
  }
  const need = Math.min(sm.cap, Math.max(1, Math.ceil(sm.cap * MIN_POINT_FRAC)));
  if (got >= need) {
    advancePoint(now);
    return;
  }
  if (pointAttempts >= SKIP_AFTER_ATTEMPTS && got >= 2) {
    advancePoint(now); // fewer samples is fine (e.g. eyelids lower when looking down)
    return;
  }
  retryPoint(got);
}

/** Dwell threshold for the current direction (wg8: down is a bit shorter; deep-bottom faster). */
function dwellTargetMs(dir) {
  if (dir !== "down") return DWELL_MS;
  const c = cursorPx();
  const vh = window.innerHeight || 1;
  const ny = c ? clamp(c.y / vh, 0, 1) : 0;
  if (ny > DOWN_EARLY_NY) return DWELL_MS_DOWN_DEEP;
  return DWELL_MS_DOWN;
}

function updateDwell(now, dir, gazeOk) {
  if (phase !== "count") return;
  const gap = lastTick ? now - lastTick : 0;
  lastTick = now;
  const dt = gap > 250 ? 0 : gap;

  // wg10/wg11: after a successful count (any of the 4 dirs), block new dwelling until cooldown ends.
  // Keep commit hold feedback; clear dwell + ambient charge so nothing builds.
  if (now < countCooldownUntil) {
    dwellDir = null;
    dwellAcc = 0;
    setGauge(null, 0);
    if (holdDir && now < holdUntil) {
      const meta = DIR_META[holdDir];
      const act = DIR_ACT[holdDir] || "";
      const text = meta.name + " " + counts[holdDir] + (act ? " · " + act : "");
      showLive(text, "ok", text);
    } else if (!gazeOk) {
      if (now - lastGazeAt > FACE_GRACE_MS) {
        showLive("시선 없음 · 얼굴을 카메라에", "warn", "시선 없음");
      }
    } else if (!dir) {
      showLive("정면 · " + EDGE_WORDS + " 가장자리를 보세요", "idle", "정면");
    } else {
      const meta = DIR_META[dir];
      const hint = DIR_HINT[dir] || meta.name;
      showLive(meta.watch, "ok", hint);
    }
    return;
  }

  if (!gazeOk) {
    if (now - lastGazeAt > FACE_GRACE_MS) {
      clearCharge();
      showLive("시선 없음 · 얼굴을 카메라에", "warn", "시선 없음");
    }
    return;
  }

  if (!dir) {
    clearCharge();
    showLive("정면 · " + EDGE_WORDS + " 가장자리를 보세요", "idle", "정면");
    return;
  }

  if (dir !== dwellDir) {
    dwellDir = dir;
    dwellAcc = 0;
    holdUntil = 0;
    holdDir = null;
  }

  const need = dwellTargetMs(dir);
  dwellAcc += dt;
  if (dwellAcc >= need) {
    counts[dir] += 1;
    renderCounts();
    popCount(dir);
    dwellAcc = 0;
    dwellDir = null;
    holdUntil = now + COMMIT_HOLD_MS;
    holdDir = dir;
    countCooldownUntil = now + COUNT_COOLDOWN_MS; // wg10
    onFeedAction(dir); // wg6: drive in-app shorts feed
    flashAmbient(dir); // wg9: brighter commit flash along this edge
    setGauge(null, 0); // wg10: clear dwell/ambient charge for cooldown
    const meta = DIR_META[dir];
    const act = DIR_ACT[dir] || "";
    const text = meta.name + " " + counts[dir] + (act ? " · " + act : "");
    showLive(text, "ok", text);
    return;
  }

  setGauge(dir, dwellAcc / need);
  const meta = DIR_META[dir];
  if (holdDir === dir && now < holdUntil) {
    const act = DIR_ACT[dir] || "";
    const text = meta.name + " " + counts[dir] + (act ? " · " + act : "");
    showLive(text, "ok", text);
  } else {
    const hint = DIR_HINT[dir] || meta.name;
    showLive(meta.watch, "ok", hint);
  }
}

function onGaze(data) {
  if (!running) return;
  const now = performance.now();
  // WebGazer calls this once per processed camera frame, so each call has fresh eye features.
  if (sampling && phase === "calib") sampleFrame(data, now);
  if (data && Number.isFinite(data.x) && Number.isFinite(data.y)) {
    latestGaze = { x: data.x, y: data.y };
    lastGazeAt = now;
    pushGaze(latestGaze);
    if (phase === "check") checkPreds.push(latestGaze);
  }
}

function tick(now) {
  if (!running) return;
  rafId = requestAnimationFrame(tick);
  paintAmbient(now);

  const fresh = now - lastGazeAt < FACE_GRACE_MS * 3;
  if (!fresh) gazeHist = [];

  if (phase === "ready") {
    updateGazeCursor(fresh ? filteredGaze() : null, now);
    if (now >= readyAt) {
      phase = "count";
      clearCharge();
      countCooldownUntil = 0;
      lastTick = 0;
      showFeed();
      showLive(
        "피드 데모 · " + EDGE_WORDS + " 가장자리를 보세요",
        "idle",
        UP_DOWN_ONLY ? "위=다음 · 아래=이전" : "위=다음 · 아래=이전 · 왼쪽=뒤로 · 오른쪽=댓글"
      );
    }
    return;
  }

  if (phase === "calib") {
    updateGazeCursor(fresh ? filteredGaze() : null, now);
    try {
      tickSampling(now);
    } catch (err) {
      console.error(err);
      advancePoint(now);
      return;
    }
    return;
  }

  if (phase === "check") {
    tickCheck(now);
    return;
  }

  if (phase !== "count") return;

  const gazeOk = !!(latestGaze && fresh);
  updateGazeCursor(gazeOk ? filteredGaze() : null, now);
  // wg5: zones follow the visible (edge-mapped, smoothed) cursor, so what you see is what counts.
  updateDwell(now, gazeOk ? directionFromGaze(cursorPx(), dwellDir) : null, gazeOk);
}

function setWebGazerParams() {
  const p = webgazer.params || {};
  p.faceMeshSolutionPath = WG_FACEMESH_PATH;
  p.showVideoPreview = false;
  p.showVideo = false;
  p.showFaceOverlay = false;
  p.showFaceFeedbackBox = false;
  p.showGazeDot = false;
  // wg12: no WebGazer auto save/load ("webgazerGlobalData"); we load our own key after begin().
  p.saveDataAcrossSessions = false;
  // Plain "user" (not exact) so Safari can still pick a camera if the hint is unavailable.
  p.camConstraints = {
    video: {
      facingMode: "user",
      width: { ideal: 640 },
      height: { ideal: 480 },
    },
    audio: false,
  };
}

function hideWebGazerChrome() {
  try {
    webgazer
      .showVideoPreview(false)
      .showPredictionPoints(false)
      .showFaceOverlay(false)
      .showFaceFeedbackBox(false);
  } catch (err) {
    // Expected before begin(): WebGazer's DOM nodes don't exist yet.
  }
  // iOS Safari stops decoding a <video> that is display:none (WebGazer itself uses opacity on
  // Apple for this reason). Keep the feed rendered in the viewport, just transparent, or
  // face mesh only ever sees blank frames / loadeddata never fires.
  const style = document.getElementById("wg-hide-style") || document.createElement("style");
  style.id = "wg-hide-style";
  style.textContent =
    "#webgazerVideoContainer,#webgazerVideoFeed{display:block!important;opacity:0!important;pointer-events:none!important;}" +
    "#webgazerFaceOverlay,#webgazerFaceFeedbackBox,#webgazerGazeDot{display:none!important;pointer-events:none!important;}";
  document.head.appendChild(style);
}

/** iOS: make sure WebGazer's own <video> plays inline (autoplay alone can stall). */
function nudgeWebGazerVideo() {
  const feed = document.getElementById("webgazerVideoFeed");
  if (!feed) return false;
  try {
    feed.setAttribute("playsinline", "");
    feed.setAttribute("webkit-playsinline", "");
    if (feed.paused) feed.play().catch(() => {});
  } catch (err) {
    console.warn(err);
  }
  return true;
}

function stopWebGazerStream() {
  const feed = document.getElementById("webgazerVideoFeed");
  const stream = feed && feed.srcObject;
  if (stream && typeof stream.getTracks === "function") {
    for (const t of stream.getTracks()) {
      try {
        t.stop();
      } catch (err) {
        console.warn(err);
      }
    }
  }
}

function mirrorPreview() {
  const feed = document.getElementById("webgazerVideoFeed");
  if (feed && feed.srcObject) {
    cam.srcObject = feed.srcObject;
    cam.play().catch(() => {});
    return true;
  }
  return false;
}

function cameraErrorText(err) {
  const name = err && err.name;
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "카메라 권한이 없습니다. Safari 설정에서 허용해 주세요.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "앞 카메라를 찾지 못했습니다.";
  }
  if (!window.isSecureContext) {
    return "카메라는 HTTPS 페이지에서만 열립니다.";
  }
  return "앞 카메라를 열 수 없습니다.";
}

function errDetail(err) {
  if (!err) return "알 수 없는 오류";
  const name = err.name && err.name !== "Error" ? err.name + ": " : "";
  let msg = err.message || String(err);
  msg = String(msg).replace(/\s+/g, " ").trim();
  const full = name + msg;
  return full.length > 180 ? full.slice(0, 177) + "…" : full;
}

function webgazerFailText(err) {
  const name = (err && err.name) || "";
  const msg = (err && (err.message || String(err))) || "";
  let lead;
  if (name === "NotAllowedError" || name === "SecurityError" || name === "NotFoundError" || name === "OverconstrainedError" || name === "NotReadableError") {
    lead = cameraErrorText(err);
  } else if (/timeout/i.test(name)) {
    lead = "WebGazer 준비가 너무 오래 걸립니다(모델 다운로드·얼굴 인식).";
  } else if (/wasm|WebAssembly|OOM|Aborted/i.test(msg)) {
    lead = "WebGazer(WASM)를 이 기기에서 시작하지 못했습니다.";
  } else {
    lead = "WebGazer 시선 추적을 시작하지 못했습니다.";
  }
  return lead + " [오류: " + errDetail(err) + "]";
}

function withTimeout(promise, ms, stage) {
  let timer = 0;
  const timeout = new Promise((_, reject) => {
    timer = window.setTimeout(() => {
      const e = new Error("WebGazer begin() " + Math.round(ms / 1000) + "s 초과 · 단계: " + stage());
      e.name = "TimeoutError";
      reject(e);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => window.clearTimeout(timer));
}

async function startWebGazer() {
  if (!window.webgazer) {
    throw new Error("WebGazer script missing");
  }
  setWebGazerParams();
  try {
    webgazer.saveDataAcrossSessions(false);
  } catch (err) {
    console.warn(err);
  }
  hideWebGazerChrome();

  webgazer.setRegression("ridge");
  webgazer.setGazeListener(onGaze);

  // begin() calls getUserMedia synchronously inside this click handler (keeps the user
  // gesture), then waits for the first face-mesh frame, which downloads ~10 MB of WASM.
  let stage = "카메라 권한";
  const watcher = window.setInterval(() => {
    if (nudgeWebGazerVideo() && stage === "카메라 권한") {
      stage = "얼굴 모델 다운로드";
      setStatus("카메라 켜짐 · 얼굴 모델(약 10MB) 불러오는 중…");
    }
  }, 150);
  try {
    await withTimeout(webgazer.begin(), BEGIN_TIMEOUT_MS, () => stage);
  } finally {
    window.clearInterval(watcher);
  }
  nudgeWebGazerVideo();

  try {
    webgazer.applyKalmanFilter(true);
  } catch (err) {
    console.warn(err);
  }

  // Only our countdown samples train the model — avoid stray page clicks/moves training it.
  try {
    if (typeof webgazer.removeMouseEventListeners === "function") {
      webgazer.removeMouseEventListeners();
    }
  } catch (err) {
    console.warn(err);
  }

  hideWebGazerChrome();

  // Mirror WebGazer's camera stream into our small preview (no second getUserMedia).
  let tries = 0;
  while (!mirrorPreview() && tries < 40) {
    await new Promise((r) => setTimeout(r, 100));
    tries += 1;
  }
}

async function startCamera() {
  startBtn.disabled = true;
  setStatus("WebGazer·카메라를 여는 중…");
  try {
    if (!window.isSecureContext) {
      setStatus("카메라는 HTTPS 페이지에서만 열립니다.", "warn");
      startBtn.disabled = false;
      return;
    }
    if (!window.webgazer) {
      setStatus("WebGazer 스크립트를 불러오지 못했습니다. 네트워크를 확인해 주세요.", "warn");
      startBtn.disabled = false;
      return;
    }
    await startWebGazer();
  } catch (err) {
    console.error(err);
    setStatus(webgazerFailText(err), "warn");
    const fb = document.querySelector("#fallback-link");
    if (fb) fb.hidden = false;
    startBtn.disabled = false;
    stopWebGazerStream();
    try {
      if (window.webgazer && typeof webgazer.end === "function") webgazer.end();
    } catch (e) {
      console.warn(e);
    }
    return;
  }

  gate.classList.add("hidden");
  running = true;
  started = true;
  recalibBtn.disabled = false;
  const meta = readSavedMeta();
  if (meta && layoutMatches(meta) && (await loadSavedCalibration())) {
    beginSavedCheck(performance.now());
  } else if (meta && layoutMatches(meta)) {
    beginCalibration("저장된 맞춤을 불러오지 못해 다시 맞춥니다 · ");
  } else if (meta) {
    beginCalibration("화면 크기·방향이 저장 때와 달라 다시 맞춥니다 · ");
  } else {
    beginCalibration();
  }
  cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(tick);
}

function stopAll() {
  running = false;
  cancelAnimationFrame(rafId);
  resetCursor();
  stopWebGazerStream();
  try {
    if (window.webgazer && typeof webgazer.end === "function") webgazer.end();
  } catch (err) {
    console.warn(err);
  }
  if (cam.srcObject) {
    try {
      for (const t of cam.srcObject.getTracks()) t.stop();
    } catch (err) {
      console.warn(err);
    }
    cam.srcObject = null;
  }
}

clearBtn.addEventListener("click", () => {
  zeroCounts();
});

// 다시 맞추기: delete the saved model and calibrate from scratch (it is saved again at the end).
recalibBtn.addEventListener("click", () => {
  if (!running || !started) return;
  beginCalibration("저장된 맞춤을 지웠어요 · ");
});

// wg11: no tap to calibrate — the dot is display-only (pointer-events: none in CSS).
// Keep the dot outside .stage's stacking context so nothing on the page can paint over it.
document.body.appendChild(calibDot);

startBtn.addEventListener("click", () => {
  startCamera();
});

(function bindPipTest() {
  const btn = document.querySelector("#pip-test");
  if (!btn) return;
  const cap = window.Capacitor;
  const wk = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.eyemousePipTest;
  const native = !!(wk || (cap && typeof cap.isNativePlatform === "function" && cap.isNativePlatform()));
  if (!native) {
    btn.hidden = true;
    const note = document.querySelector(".pip-test-note");
    if (note) note.hidden = true;
    return;
  }
  btn.addEventListener("click", async () => {
    try {
      if (wk && typeof wk.postMessage === "function") {
        wk.postMessage({ open: true });
        return;
      }
      const plugins = (cap && cap.Plugins) || {};
      if (plugins.PipTest && typeof plugins.PipTest.open === "function") {
        await plugins.PipTest.open();
        return;
      }
      if (cap && typeof cap.registerPlugin === "function") {
        const PipTest = cap.registerPlugin("PipTest");
        await PipTest.open();
        return;
      }
      btn.textContent = "오른쪽 위 PiP 시험을 누르세요";
    } catch (err) {
      console.error(err);
      btn.textContent = "열기 실패";
    }
  });
})();

// Surface async WebGazer failures that escape begin() (e.g. inside the frame loop).
window.addEventListener("unhandledrejection", (ev) => {
  console.error("unhandledrejection", ev.reason);
  if (!started) return;
  const r = ev.reason;
  if (r && /webgazer|face|mesh|wasm|mediapipe/i.test(String((r.stack || "") + (r.message || "")))) {
    setStatus("WebGazer 오류 · " + errDetail(r), "warn");
  }
});

window.addEventListener("pagehide", () => {
  stopAll();
});

console.info("[eyemouse] build " + BUILD + " · dirs=" + ACTIVE_DIRS.join(","));
layoutZones();
buildFeed();
resizeAmbient(); // wg7: no idle ambient loop — light only flows on a commit
window.addEventListener("resize", () => {
  layoutZones();
  layoutFeedItems();
  applyFeedTransform(false);
  resizeAmbient();
});
if (commentCloseBtn) {
  commentCloseBtn.addEventListener("click", () => {
    if (commentOpen) {
      while (feedHistory.length && feedHistory[feedHistory.length - 1].type === "comments") feedHistory.pop();
      closeComments(true);
    }
  });
}
if (readSavedMeta()) {
  const gs = document.querySelector("#gate-saved");
  if (gs) gs.hidden = false;
}

// Gate readiness: WebGazer script present?
if (window.webgazer) {
  setStatus("앞 카메라를 켜 주세요");
} else {
  setStatus("WebGazer를 불러오는 중…");
  // Script is sync before module, but be defensive.
  window.addEventListener("load", () => {
    if (window.webgazer) setStatus("앞 카메라를 켜 주세요");
    else setStatus("WebGazer 스크립트를 불러오지 못했습니다.", "warn");
  });
}
