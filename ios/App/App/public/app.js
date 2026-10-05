// 아이마우스 — WebGazer.js gaze engine (not a verified Eye Tracking API).
// Gaze (x,y) from WebGazer drives the soft cursor and edge dwell counts.
// Calibration: look at each dot and tap ONCE; while you keep looking, ~0.8 s of frames are
// recorded for that dot (capped so every dot fits WebGazer's 50-sample click window). The finished model is saved (WebGazer's own localforage key) so the
// next visit skips calibration; 다시 맞추기 wipes it and calibrates again.
// wg5: edge dots flush on the 4 screen edges, per-axis edge map after calibration, slower cursor.
// wg6: DWELL 1.5s, ambient edge glow, in-app shorts feed demo (not native overlay).
// wg7: up/down only (left/right dwell disabled: no back, no comments), slower cursor.
// wg8: wider bottom count zone, down-biased edge map (WebGazer undershoots down), slightly
//      shorter dwell for down (and earlier commit when deeply near the bottom).
// wg9: hide dwell gauge rails; ambient edge light builds while charging toward up/down,
//      brighter flash on count (unchanged); gaze cursor halved.
// wg10: slower gaze cursor (lower SMOOTH + MAX_SPEED); 1500 ms count cooldown after
//       successful up/down (clears dwell / ambient charge during cooldown).

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
const COUNT_COOLDOWN_MS = 1500; // wg10: block new counting after a successful up/down
const CURSOR_HIDE_MS = 1500; // keep the cursor (frozen) through short face/gaze drop-outs
// wg5: edge mapping. Ridge regression shrinks toward the mean of the training targets, so the raw
// gaze never quite reaches the calibration dots and drifts back to the middle. After calibration
// we predict the stored samples of the 4 edge dots and fit a per-axis linear stretch so looking
// at the left/right/top/bottom dot lands the cursor on that screen edge.
const EDGE_MAP_MIN_SPREAD = 0.08; // need at least this much raw left↔right / top↔bottom separation
const EDGE_MAP_GAIN_MIN = 0.7;
const EDGE_MAP_GAIN_MAX = 3.5;
const EDGE_MAP_PER_DOT = 5; // stored samples predicted per edge dot (keeps the fit cheap)
const READY_MS = 1000;
const COMMIT_HOLD_MS = 700;
// Edge bands (normalized viewport height). Top stays 22%; bottom is wider so looking down
// registers more easily (WebGazer often undershoots the lower edge).
const EDGE_FRAC = 0.22; // top (and unused left/right) — keep for layout helpers
const EDGE_FRAC_UP = 0.22; // wg8: unchanged top band
const EDGE_FRAC_DOWN = 0.30; // wg8: bottom 30% (within 28–32%)
// Extra Y push toward the bottom after the linear edge map (fraction of viewport height at ny=1).
const EDGE_DOWN_BIAS = 0.10;
// One tap per calibration dot. After the tap we keep sampling distinct camera frames for a
// short window while the user keeps looking at the dot (better than duplicating one frame).
const TAPS_PER_POINT = 1;
const SAMPLE_WINDOW_MS = 600;
// wg4: WebGazer's ridge regression keeps click samples in a DataWindow ring buffer of 50.
// wg3 took up to 14 per dot and judged success by getData().length growth, so by the 5th dot
// (아래) the buffer was full, length stayed 50, "added" was 0 and the dot never advanced
// (and the center dot's samples were being overwritten). Now: cap per dot so all 5 fit, and
// count recorded samples ourselves (wrapped addData) instead of reading the saturating length.
const WG_CLICK_WINDOW = 50;
const SAMPLE_GOOD = 1; // advance right after the 0.6 s window once at least one frame had a face
const SAMPLE_EXTEND_MS = 1000; // no face yet? keep trying up to this long, then advance anyway
const MAX_POINT_FAILS = 0; // always advance after the window: one tap per dot, never stuck
// Saved calibration: same key WebGazer's saveDataAcrossSessions(true) loads on begin().
const SAVE_KEY = "webgazerGlobalData";
// wg5: v2 = edge-flush dots. Old (inset-dot) saves are ignored so everyone recalibrates once.
const META_KEY = "eyemouse.wg.calib.v2";
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

// Center first (anchors WebGazer's model), then the 4 edge midpoints. wg5: the edge dots sit
// centered ON the screen edge (half the dot past the edge, or on the safe-area line), so their
// recorded targets are the true edges and the edge map stretches gaze to the full screen.
const CALIB_ORDER = ["center", "up", "right", "left", "down"];

const DIR_META = {
  up: { watch: "위로 보는 중", name: "위" },
  down: { watch: "아래로 보는 중", name: "아래" },
  left: { watch: "왼쪽으로 보는 중", name: "왼쪽" },
  right: { watch: "오른쪽으로 보는 중", name: "오른쪽" },
};
const DIRS = ["up", "down", "left", "right"];
// wg7: only these directions count / drive the feed. Left/right are disabled (hidden in CSS).
const ACTIVE_DIRS = ["up", "down"];
const AMBIENT_FLASH_MS = 950; // one light sweep along the committed edge

const CALIB_TEXT = {
  center: "가운데 점을 보고 탭하세요",
  up: "위 점을 보고 탭하세요",
  down: "아래 점을 보고 탭하세요",
  right: "오른쪽 점을 보고 탭하세요",
  left: "왼쪽 점을 보고 탭하세요",
};

const cam = document.querySelector("#cam");
const statusEl = document.querySelector("#status");
const gateStatus = document.querySelector("#gate-status");
const gate = document.querySelector("#gate");
const startBtn = document.querySelector("#start");
const clearBtn = document.querySelector("#clear");
const focusEl = document.querySelector("#focus");
const calibDot = document.querySelector("#calib-dot");
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
let tapsOnPoint = 0;
let sampling = null; // {start, base, cap, x, y} while recording frames for the current dot
let recordedTotal = 0; // eye-feature samples actually added to WebGazer (counted in addData)
let pointFails = 0;
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
let tapLock = false;

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

/** Draw soft dwell-charge glow along one edge (amount 0..1). */
function paintAmbientCharge(ctx, w, h, dir, amount, now) {
  const top = dir === "up";
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

/** Draw the brighter commit flash (existing wg7 sweep). */
function paintAmbientFlash(ctx, w, h, f, now) {
  const p = (now - f.start) / AMBIENT_FLASH_MS;
  if (p >= 1 || p < 0) return false;
  const top = f.dir === "up";
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

function feedNext() {
  if (!feedItems.length) return;
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
  // wg7: only up/down act. Left (back) and right (comments) are disabled for now.
  if (dir === "up") feedNext();
  else if (dir === "down") feedPrev();
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
 * Map WebGazer viewport gaze to an edge zone (or null = empty center).
 * Zones (normalized viewport; wg8 asymmetric up/down):
 *   up    = y < EDGE_FRAC_UP (0.22)
 *   down  = y > 1 - EDGE_FRAC_DOWN (0.30 → starts at ny > 0.70)
 *   left/right unused (ACTIVE_DIRS = up/down only)
 * The middle counts nothing. The zone already being dwelt in is kept so edge jitter does not
 * reset the dwell timer.
 */
function directionFromGaze(gaze, current) {
  if (!gaze) return null;
  const vw = window.innerWidth || 1;
  const vh = window.innerHeight || 1;
  const nx = clamp(gaze.x / vw, 0, 1);
  const ny = clamp(gaze.y / vh, 0, 1);
  const depth = {
    up: EDGE_FRAC_UP - ny,
    down: ny - (1 - EDGE_FRAC_DOWN),
    left: EDGE_FRAC - nx,
    right: nx - (1 - EDGE_FRAC),
  };
  // wg7: only up/down bands exist (full width); left/right never count.
  const cands = ACTIVE_DIRS.filter((d) => depth[d] > 0);
  if (!cands.length) return null;
  if (current && cands.includes(current)) return current;
  let best = cands[0];
  for (const d of cands) if (depth[d] > depth[best]) best = d;
  return best;
}

/** Draw the zones exactly as directionFromGaze splits them. */
function layoutZones() {
  const aUp = EDGE_FRAC_UP * 100 + "%";
  const bDown = (1 - EDGE_FRAC_DOWN) * 100 + "%";
  const a = EDGE_FRAC * 100 + "%";
  const b = (1 - EDGE_FRAC) * 100 + "%";
  const shapes = {
    up: `polygon(0 0, 100% 0, ${b} ${a}, ${a} ${a})`,
    down: `polygon(0 100%, 100% 100%, ${b} ${b}, ${a} ${b})`,
    left: `polygon(0 0, ${a} ${a}, ${a} ${b}, 0 100%)`,
    right: `polygon(100% 0, ${b} ${a}, ${b} ${b}, 100% 100%)`,
  };
  // wg7/wg8: up/down are full-width bands (matches directionFromGaze); down is taller.
  shapes.up = `polygon(0 0, 100% 0, 100% ${aUp}, 0 ${aUp})`;
  shapes.down = `polygon(0 100%, 100% 100%, 100% ${bDown}, 0 ${bDown})`;
  for (const [dir, el] of zones) {
    el.style.clipPath = shapes[dir];
    el.style.webkitClipPath = shapes[dir];
  }
}

function placeCalibDot(dir) {
  calibDot.hidden = false;
  calibDot.disabled = false;
  calibDot.className = "calib-dot " + dir;
  calibDot.setAttribute("aria-label", CALIB_TEXT[dir] || "맞춤 점");
}

function hideCalibDot() {
  calibDot.hidden = true;
  calibDot.disabled = true;
  calibDot.className = "calib-dot";
}

function stepLabel() {
  return calibIndex + 1 + "/" + CALIB_ORDER.length;
}

function tapProgress() {
  return (calibIndex * TAPS_PER_POINT + tapsOnPoint) / (CALIB_ORDER.length * TAPS_PER_POINT);
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

/** Group stored samples by target (dot) and pick the extreme dot on each side. */
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
  const by = (f, sign) => list.reduce((best, g) => (sign * f(g) > sign * f(best) ? g : best), list[0]);
  return {
    left: by((g) => g.tx, -1),
    right: by((g) => g.tx, 1),
    up: by((g) => g.ty, -1),
    down: by((g) => g.ty, 1),
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
      const fx = fitAxis(g.left.tx, g.right.tx, mx("left"), mx("right"), vw);
      // wg8: aim the down calibration median a bit past the screen bottom so looking at the
      // bottom training dot lands on (or past) the edge after clamp — counters undershoot.
      const downTarget = Math.max(g.down.ty, vh) + vh * 0.06;
      const fy = fitAxis(g.up.ty, downTarget, my("up"), my("down"), vh);
      const map = { ax: fx ? fx.a : 1, bx: fx ? fx.b : 0, ay: fy ? fy.a : 1, by: fy ? fy.b : 0 };
      edgeMap = fx || fy ? map : null;
      console.info("[eyemouse] edge map", edgeMap, { left: mx("left"), right: mx("right"), up: my("up"), down: my("down") });
      resolve(edgeMap);
    };
    window.setTimeout(work, 0);
  });
}

// ---- Saved calibration (localforage, same store WebGazer uses) ----

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
    return m && m.v === 2 && m.n > 0 ? m : null;
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
    JSON.stringify({ v: 2, savedAt: Date.now(), vw: window.innerWidth, vh: window.innerHeight, n: copy.length })
  );
  return true;
}

function clearSavedCalibration() {
  try {
    localStorage.removeItem(META_KEY);
  } catch (err) {
    console.warn(err);
  }
  try {
    // Wipes WebGazer's localforage store and resets the in-memory regression model.
    if (window.webgazer && typeof webgazer.clearData === "function") webgazer.clearData();
  } catch (err) {
    console.warn(err);
  }
  try {
    if (window.localforage) window.localforage.removeItem(SAVE_KEY).catch(() => {});
  } catch (err) {
    console.warn(err);
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

function startPoint(index) {
  calibIndex = index;
  tapsOnPoint = 0;
  pointFails = 0;
  const dir = CALIB_ORDER[calibIndex];
  placeCalibDot(dir);
  calibDot.classList.remove("locked");
  calibStepEl.textContent = stepLabel() + " · 한 번 탭";
  setBaselineUi(true, tapProgress());
  showLive(CALIB_TEXT[dir] + " · " + stepLabel(), "idle", CALIB_TEXT[dir]);
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
  tapLock = false;
  pointFails = 0;
  clearSavedCalibration();
  setCalibInfo("");
  startPoint(0);
  if (note) setStatus(note + CALIB_TEXT[CALIB_ORDER[0]] + " · " + stepLabel(), "idle");
}

function finishCalibration(now) {
  phase = "ready";
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

function perPointCap() {
  const r = regModel();
  const win = (r && r.dataClicks && r.dataClicks.windowSize) || WG_CLICK_WINDOW;
  return Math.max(1, Math.floor(win / CALIB_ORDER.length));
}

function recordAt(x, y) {
  if (!window.webgazer || typeof webgazer.recordScreenPosition !== "function") return;
  try {
    webgazer.recordScreenPosition(x, y, "click");
  } catch (err) {
    console.warn(err);
  }
}

function onCalibTap(ev) {
  if (phase !== "calib" || tapLock) return;
  if (ev && ev.cancelable) ev.preventDefault();
  if (ev) ev.stopPropagation();
  tapLock = true;
  ensureRecordCounter();
  const dir = CALIB_ORDER[calibIndex];
  const c = dotCenter();
  const token = { start: performance.now(), base: recordedTotal, cap: perPointCap(), x: c.x, y: c.y };
  sampling = token;
  recordAt(c.x, c.y);
  // Backstop in case rAF is throttled/paused: finish this dot even if tick() never runs.
  window.setTimeout(() => {
    if (sampling === token && phase === "calib") tickSampling(performance.now(), true);
  }, SAMPLE_EXTEND_MS + 150);
  // Keep recording one sample per new camera frame (see onGaze); tick() decides when to advance.
  calibDot.classList.add("locked");
  calibStepEl.textContent = stepLabel() + " · 그대로 보세요";
  showLive("좋아요 · 점을 잠깐 그대로 보세요 · " + stepLabel(), "ok", CALIB_TEXT[dir]);
}

function advancePoint(now) {
  sampling = null;
  tapLock = false;
  calibDot.classList.remove("locked");
  tapsOnPoint = TAPS_PER_POINT;
  setBaselineUi(true, tapProgress());
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

/** Called every frame while a dot is sampling. */
function tickSampling(now, force) {
  if (!sampling) return;
  const elapsed = force ? Infinity : now - sampling.start;
  const got = samplesThisPoint();
  if (got >= sampling.cap || (elapsed >= SAMPLE_WINDOW_MS && got >= SAMPLE_GOOD)) {
    advancePoint(now);
    return;
  }
  if (elapsed < SAMPLE_EXTEND_MS) return;
  // Window (incl. extension) over.
  if (got > 0) {
    advancePoint(now); // fewer samples is fine (e.g. eyelids lower when looking down)
    return;
  }
  const dir = CALIB_ORDER[calibIndex];
  pointFails += 1;
  if (pointFails > MAX_POINT_FAILS) {
    // Never leave the user stuck: skip this dot (the others still train the model).
    showLive("얼굴이 안 잡혀 이 점은 건너뜁니다", "warn", CALIB_TEXT[dir]);
    advancePoint(now);
    return;
  }
  sampling = null;
  tapLock = false;
  calibDot.classList.remove("locked");
  calibStepEl.textContent = stepLabel() + " · 한 번 탭";
  showLive("얼굴이 안 잡혔어요 · 점을 보고 다시 탭 · " + stepLabel(), "warn", CALIB_TEXT[dir]);
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

  // wg10: after a successful up/down count, block new dwelling until cooldown ends.
  // Keep commit hold feedback; clear dwell + ambient charge so nothing builds.
  if (now < countCooldownUntil) {
    dwellDir = null;
    dwellAcc = 0;
    setGauge(null, 0);
    if (holdDir && now < holdUntil) {
      const meta = DIR_META[holdDir];
      const act = { up: "다음", down: "이전" }[holdDir] || "";
      const text = meta.name + " " + counts[holdDir] + (act ? " · " + act : "");
      showLive(text, "ok", text);
    } else if (!gazeOk) {
      if (now - lastGazeAt > FACE_GRACE_MS) {
        showLive("시선 없음 · 얼굴을 카메라에", "warn", "시선 없음");
      }
    } else if (!dir) {
      showLive("정면 · 위·아래 가장자리를 보세요", "idle", "정면");
    } else {
      const meta = DIR_META[dir];
      const hint = { up: "위 · 다음", down: "아래 · 이전" }[dir] || meta.name;
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
    showLive("정면 · 위·아래 가장자리를 보세요", "idle", "정면");
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
    const act = { up: "다음", down: "이전" }[dir] || "";
    const text = meta.name + " " + counts[dir] + (act ? " · " + act : "");
    showLive(text, "ok", text);
    return;
  }

  setGauge(dir, dwellAcc / need);
  const meta = DIR_META[dir];
  if (holdDir === dir && now < holdUntil) {
    const act = { up: "다음", down: "이전" }[dir] || "";
    const text = meta.name + " " + counts[dir] + (act ? " · " + act : "");
    showLive(text, "ok", text);
  } else {
    const hint = { up: "위 · 다음", down: "아래 · 이전" }[dir] || meta.name;
    showLive(meta.watch, "ok", hint);
  }
}

function onGaze(data) {
  if (!running) return;
  const now = performance.now();
  // WebGazer calls this once per processed camera frame, so each call has fresh eye features.
  if (sampling && phase === "calib" && now - sampling.start <= SAMPLE_EXTEND_MS && samplesThisPoint() < sampling.cap) {
    recordAt(sampling.x, sampling.y);
  }
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
      showLive("피드 데모 · 위·아래 가장자리를 보세요", "idle", "위=다음 · 아래=이전");
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
  // Load the saved calibration on begin() (WebGazer reads localforage "webgazerGlobalData").
  p.saveDataAcrossSessions = true;
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
    webgazer.saveDataAcrossSessions(true);
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

  // Prefer explicit calib taps only — avoid stray page clicks training the model.
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
  if (meta && layoutMatches(meta)) {
    beginSavedCheck(performance.now());
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

// wg4: register the tap on press (pointerdown / touchstart), not on release. A release can be
// lost on iOS Safari (pointercancel when the finger drifts into a scroll, or the bottom toolbar
// grabbing a touch near the screen edge). touchstart is preventDefault'ed (non-passive) so the
// synthetic click never follows; click stays as fallback for keyboard / non-touch browsers.
let lastPressAt = 0;
let sawPress = false;
function onDotPress(ev) {
  if (ev.type === "pointerdown" && ev.button > 0) return;
  if (ev.type !== "click") sawPress = true;
  const now = performance.now();
  if (now - lastPressAt < 450) {
    if (ev.cancelable) ev.preventDefault();
    return;
  }
  if (phase !== "calib" || tapLock) {
    if (ev.cancelable) ev.preventDefault();
    return;
  }
  lastPressAt = now;
  onCalibTap(ev);
}
calibDot.addEventListener("pointerdown", onDotPress);
calibDot.addEventListener("touchstart", onDotPress, { passive: false });
calibDot.addEventListener("click", (ev) => {
  // After a press event we already handled it; only keyboard clicks (detail 0) or browsers
  // without pointer/touch events reach onDotPress through here.
  if (sawPress && ev.detail !== 0) {
    ev.preventDefault();
    return;
  }
  onDotPress(ev);
});
// Keep the dot outside .stage's stacking context so nothing on the page can paint over it.
document.body.appendChild(calibDot);

startBtn.addEventListener("click", () => {
  startCamera();
});

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
