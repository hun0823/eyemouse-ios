// Direction-only test for 아이마우스. Not a verified screen gaze point.
// gazeFromFace() is a raw vector: +x toward the user's right, plus raw lookUp /
// lookDown blendshapes (mild iris Y assist). Soft experimental cursor maps that
// vector with a fixed center+offset scale — never stretched by calib samples.
// Direction uses absolute thresholds on the smoothed vector (no span remapping).
// Calibration order: up → right → left → down (1/4…4/4) is a warm-up gate only;
// samples may be kept for debug but do not remap directionOf or the cursor.
// Counting starts after warm-up + "맞춤 완료" (~1s). No stored calibration.

const WASM_BASE = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm";
const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const VISION_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/vision_bundle.mjs";

const DWELL_MS = 2000;
const FACE_GRACE_MS = 300;
const SMOOTH = 0.24;
const CURSOR_SMOOTH = 0.32;
const IRIS_GAIN_X = 8.0;
const IRIS_GAIN_Y = 7.0;
const BLEND_GAIN_X = 2.6;
const BLEND_GAIN_Y = 2.6;
// Absolute direction gates on the smoothed gaze vector (no calib remapping).
const DIR_UP_MIN = 0.18;
const DIR_UP_MARGIN = 0.04;
const DIR_DOWN_MIN = 0.22;
const DIR_DOWN_MARGIN = 0.03;
const DIR_X_MIN = 0.22;
const CALIB_MS = 1000;
const CALIB_SETTLE_MS = 300;
// User order: 위 → 오른쪽 → 왼쪽 → 아래
const CALIB_ORDER = ["up", "right", "left", "down"];
const OFF_GRACE_MS = 150;
const CALIB_RELAX_MS = 5000;
const RELAX_FACTOR = 0.55;
const UP_MARGIN = 0.05;
const DOWN_MARGIN = 0.07;
const X_MARGIN = 0.14;
const READY_MS = 1000;
const NOTE_MS = 1800;
const BASELINE_MIN_SAMPLES = 8;
const COMMIT_HOLD_MS = 700;
const STORAGE_KEY = "eyemouse-gaze-affine";
const ROUGH_X_SCALE = 0.38;
const ROUGH_Y_SCALE = 0.55;

const DIR_META = {
  up: { watch: "위로 보는 중", name: "위" },
  down: { watch: "아래로 보는 중", name: "아래" },
  left: { watch: "왼쪽으로 보는 중", name: "왼쪽" },
  right: { watch: "오른쪽으로 보는 중", name: "오른쪽" },
};
const DIRS = ["up", "down", "left", "right"];

const LEFT_EYE = { outer: 33, inner: 133, top: 159, bottom: 145, iris: 468 };
const RIGHT_EYE = { outer: 263, inner: 362, top: 386, bottom: 374, iris: 473 };

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

const counts = { up: 0, down: 0, left: 0, right: 0 };

let landmarker = null;
let visionMods = null;
let stream = null;
let running = false;
let lastTs = -1;
let smoothX = 0;
let smoothUp = 0;
let smoothDown = 0;
let haveSmooth = false;
let lastFaceAt = 0;
let lastTick = 0;
let dwellDir = null;
let dwellAcc = 0;
let holdUntil = 0;
let holdDir = null;
// phase: "idle" (no camera) → "calib" (4 points, no counting)
// → "ready" (맞춤 완료 ~1s, no counting) → "count" (2s dwell counts).
let phase = "idle";
let baseline = null;
let calibIndex = 0;
let baselineSamples = [];
let pointOnMs = 0;
let pointOffMs = 0;
let pointWaitMs = 0;
let baselineLast = 0;
let calibRefs = {};
let calibNote = "";
let calibNoteUntil = 0;
let readyAt = 0;
let cursorX = 0.5;
let cursorY = 0.5;
let haveCursor = false;
let cursorVisible = false;

try {
  sessionStorage.removeItem(STORAGE_KEY);
} catch (err) {
  console.warn(err);
}

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

clearBtn.addEventListener("click", () => {
  zeroCounts();
});

recalibBtn.addEventListener("click", () => {
  if (!running) return;
  beginBaseline();
});

function blendMap(result) {
  const map = {};
  const groups = result.faceBlendshapes;
  if (!groups || !groups.length) return map;
  for (const cat of groups[0].categories || []) {
    const name = cat.categoryName || cat.displayName;
    if (name) map[name] = cat.score || 0;
  }
  return map;
}

function score(map, name) {
  return map[name] || 0;
}

function irisAxis(landmarks, eye) {
  const outer = landmarks[eye.outer];
  const inner = landmarks[eye.inner];
  const top = landmarks[eye.top];
  const bottom = landmarks[eye.bottom];
  const iris = landmarks[eye.iris];
  if (!outer || !inner || !top || !bottom || !iris) return null;
  const hx = outer.x - inner.x;
  const hy = outer.y - inner.y;
  const h2 = hx * hx + hy * hy;
  if (h2 < 1e-8) return null;
  const along = ((iris.x - inner.x) * hx + (iris.y - inner.y) * hy) / h2;
  const vx = bottom.x - top.x;
  const vy = bottom.y - top.y;
  const v2 = vx * vx + vy * vy;
  if (v2 < 1e-8) return null;
  const down = ((iris.x - top.x) * vx + (iris.y - top.y) * vy) / v2;
  return { towardOuter: along - 0.5, down: down - 0.5 };
}

function gazeFromFace(result) {
  const landmarks = result.faceLandmarks && result.faceLandmarks[0];
  const blends = blendMap(result);
  const lookRight =
    (score(blends, "eyeLookInLeft") + score(blends, "eyeLookOutRight")) / 2 -
    (score(blends, "eyeLookOutLeft") + score(blends, "eyeLookInRight")) / 2;
  const lookUp = (score(blends, "eyeLookUpLeft") + score(blends, "eyeLookUpRight")) / 2;
  const lookDown = (score(blends, "eyeLookDownLeft") + score(blends, "eyeLookDownRight")) / 2;

  let irisX = null;
  let irisY = null;
  if (landmarks && landmarks.length > 473) {
    // Looking up often narrows the lid and can look like a mild blink — keep iris.
    const lookingUp = lookUp > 0.12;
    const blinkThresh = lookingUp ? 0.95 : 0.72;
    const blinkL = score(blends, "eyeBlinkLeft") > blinkThresh && score(blends, "eyeLookDownLeft") < 0.2;
    const blinkR = score(blends, "eyeBlinkRight") > blinkThresh && score(blends, "eyeLookDownRight") < 0.2;
    const left = blinkL ? null : irisAxis(landmarks, LEFT_EYE);
    const right = blinkR ? null : irisAxis(landmarks, RIGHT_EYE);
    if (left && right) {
      irisX = (right.towardOuter - left.towardOuter) / 2;
      irisY = -((left.down + right.down) / 2);
    } else if (right) {
      irisX = right.towardOuter;
      irisY = -right.down;
    } else if (left) {
      irisX = -left.towardOuter;
      irisY = -left.down;
    }
  }

  const blendX = lookRight * BLEND_GAIN_X * 1.35;
  const x = irisX == null ? blendX : irisX * IRIS_GAIN_X * 0.72 + blendX * 0.28;
  // Fold a bit of iris Y into up/down only as a soft assist (still blend-led).
  let up = lookUp;
  let down = lookDown;
  if (irisY != null) {
    const irisAssist = clamp(irisY * IRIS_GAIN_Y * 0.12, -0.15, 0.15);
    if (irisAssist > 0) up = Math.min(1, up + irisAssist);
    else down = Math.min(1, down - irisAssist);
  }
  return { x: clamp(x, -1.4, 1.4), up, down };
}

function smoothToward(x, up, down) {
  if (!haveSmooth) {
    smoothX = x;
    smoothUp = up;
    smoothDown = down;
    haveSmooth = true;
  } else {
    smoothX += (x - smoothX) * SMOOTH;
    smoothUp += (up - smoothUp) * SMOOTH;
    smoothDown += (down - smoothDown) * SMOOTH;
  }
  return { x: smoothX, up: smoothUp, down: smoothDown };
}

function directionOf(sample) {
  // Absolute gates on the smoothed vector. Prefer the strongest clear axis.
  const cands = [];
  if (sample.up >= DIR_UP_MIN && sample.up > sample.down + DIR_UP_MARGIN) {
    cands.push({ dir: "up", margin: sample.up - DIR_UP_MIN });
  }
  if (sample.down >= DIR_DOWN_MIN && sample.down > sample.up + DIR_DOWN_MARGIN) {
    cands.push({ dir: "down", margin: sample.down - DIR_DOWN_MIN });
  }
  if (sample.x >= DIR_X_MIN) {
    cands.push({ dir: "right", margin: sample.x - DIR_X_MIN });
  }
  if (sample.x <= -DIR_X_MIN) {
    cands.push({ dir: "left", margin: -sample.x - DIR_X_MIN });
  }
  if (!cands.length) return null;
  let best = cands[0];
  for (let i = 1; i < cands.length; i++) {
    if (cands[i].margin > best.margin) best = cands[i];
  }
  return best.dir;
}

// Map smoothed gaze → normalized stage coords [0,1] with a fixed rough scale.
// Never stretch with calib edge samples (that warped the experimental cursor).
function gazeToNorm(sample) {
  const nx = 0.5 + sample.x * ROUGH_X_SCALE;
  const ny = 0.5 - (sample.up - sample.down) * ROUGH_Y_SCALE;
  return { x: clamp(nx, 0.03, 0.97), y: clamp(ny, 0.03, 0.97) };
}

function showGazeCursor(on) {
  cursorVisible = on;
  gazeCursor.hidden = !on;
  gazeCursorLabel.hidden = !on;
  gazeCursor.classList.toggle("on", on);
}

function updateGazeCursor(sample) {
  if (!running || !sample) {
    showGazeCursor(false);
    haveCursor = false;
    return;
  }
  const target = gazeToNorm(sample);
  if (!haveCursor) {
    cursorX = target.x;
    cursorY = target.y;
    haveCursor = true;
  } else {
    cursorX += (target.x - cursorX) * CURSOR_SMOOTH;
    cursorY += (target.y - cursorY) * CURSOR_SMOOTH;
  }
  const rect = stageEl.getBoundingClientRect();
  if (rect.width < 8 || rect.height < 8) {
    showGazeCursor(false);
    return;
  }
  const left = rect.left + cursorX * rect.width;
  const top = rect.top + cursorY * rect.height;
  gazeCursor.style.left = left + "px";
  gazeCursor.style.top = top + "px";
  showGazeCursor(true);
}

function setGauge(dir, amount) {
  const clamped = clamp(amount || 0, 0, 1);
  for (const name of DIRS) {
    const el = rails.get(name);
    const fill = el.querySelector(".rail-fill");
    const on = name === dir && clamped > 0;
    el.classList.toggle("hot", on);
    el.setAttribute("aria-valuenow", on ? String(Math.round(clamped * 100)) : "0");
    const scale = on ? clamped : 0;
    if (name === "left" || name === "right") fill.style.transform = "scaleY(" + scale + ")";
    else fill.style.transform = "scaleX(" + scale + ")";
    const card = countCards.get(name);
    if (card) card.classList.toggle("hot", name === dir);
    const tag = edgeTags.get(name);
    if (tag) tag.classList.toggle("hot", name === dir);
  }
}

function clearCharge() {
  dwellDir = null;
  dwellAcc = 0;
  holdUntil = 0;
  holdDir = null;
  setGauge(null, 0);
}

function setBaselineUi(active, amount) {
  baselineTrack.hidden = !active;
  calibStepEl.hidden = !active;
  baselineFill.style.transform = "scaleX(" + clamp(amount, 0, 1) + ")";
}

const CALIB_TEXT = {
  up: "위 점을 봐 주세요",
  down: "아래 점을 봐 주세요",
  right: "오른쪽 점을 봐 주세요",
  left: "왼쪽 점을 봐 주세요",
};

const CALIB_HINT = {
  up: "고개는 그대로, 눈만 위로",
  down: "고개는 그대로, 눈만 아래로",
  right: "고개는 그대로, 눈만 오른쪽으로",
  left: "고개는 그대로, 눈만 왼쪽으로",
};

function placeCalibDot(dir) {
  calibDot.hidden = false;
  calibDot.className = "calib-dot " + dir;
}

function hideCalibDot() {
  calibDot.hidden = true;
  calibDot.className = "calib-dot";
}

function zeroCounts() {
  for (const dir of DIRS) counts[dir] = 0;
  renderCounts();
}

function resetPoint() {
  baselineSamples = [];
  pointOnMs = 0;
  pointOffMs = 0;
}

function stepLabel() {
  return calibIndex + 1 + "/" + CALIB_ORDER.length;
}

function startPoint(index) {
  calibIndex = index;
  resetPoint();
  pointWaitMs = 0;
  const dir = CALIB_ORDER[calibIndex];
  placeCalibDot(dir);
  calibStepEl.textContent = stepLabel();
  setBaselineUi(true, 0);
  const noteOn = calibNote && performance.now() < calibNoteUntil;
  showLive((noteOn ? calibNote : CALIB_TEXT[dir]) + " · " + stepLabel(), noteOn ? "warn" : "idle", CALIB_TEXT[dir]);
}

function beginBaseline(note) {
  phase = "calib";
  document.body.classList.add("calibrating");
  baseline = null;
  calibRefs = {};
  baselineLast = performance.now();
  lastFaceAt = performance.now();
  haveSmooth = false;
  haveCursor = false;
  calibNote = note || "";
  calibNoteUntil = note ? performance.now() + NOTE_MS : 0;
  readyAt = 0;
  zeroCounts();
  clearCharge();
  lastTick = 0;
  startPoint(0);
}

function meanSample(samples) {
  let x = 0;
  let up = 0;
  let down = 0;
  for (const sample of samples) {
    x += sample.x;
    up += sample.up;
    down += sample.down;
  }
  const n = samples.length;
  return { x: x / n, up: up / n, down: down / n };
}

function spansOk(refs) {
  return (
    refs.up.up - refs.down.up > 0.02 &&
    refs.down.down - refs.up.down > 0.012 &&
    refs.right.x - refs.left.x > 0.04
  );
}

// Is the smoothed vector clearly toward the current calib point?
// Four-edge order (no center sample): absolute thresholds, with looser
// margins after CALIB_RELAX_MS so nobody gets stuck.
function onTarget(dir, g) {
  const relax = pointWaitMs > CALIB_RELAX_MS ? RELAX_FACTOR : 1;
  if (dir === "up") return g.up >= UP_MARGIN * relax && g.up > g.down + 0.015;
  if (dir === "down") return g.down >= DOWN_MARGIN * relax && g.down > g.up;
  if (dir === "right") return g.x >= X_MARGIN * relax;
  if (dir === "left") return -g.x >= X_MARGIN * relax;
  return false;
}

function finishCalibration(now) {
  // Warm-up done: unlock counting. Samples are kept for debug only —
  // directionOf and the cursor use absolute / fixed scales, not these spans.
  const weak = !spansOk(calibRefs);
  const center = {
    x: (calibRefs.left.x + calibRefs.right.x) / 2,
    up: (calibRefs.up.up + calibRefs.down.up) / 2,
    down: (calibRefs.up.down + calibRefs.down.down) / 2,
  };
  baseline = {
    up: calibRefs.up,
    down: calibRefs.down,
    left: calibRefs.left,
    right: calibRefs.right,
    center,
  };
  phase = "ready";
  readyAt = now + READY_MS;
  document.body.classList.remove("calibrating");
  hideCalibDot();
  setBaselineUi(false, 0);
  clearCharge();
  lastTick = 0;
  if (weak) {
    showLive(
      "맞춤 완료 · 방향 차이가 작아요 · 절대 기준으로 셉니다",
      "warn",
      "맞춤 완료 · 절대 기준"
    );
  } else {
    showLive("맞춤 완료 · 방향을 보세요", "ok", "맞춤 완료 · 방향을 보세요");
  }
}

function finishPoint(now) {
  const dir = CALIB_ORDER[calibIndex];
  calibRefs[dir] = meanSample(baselineSamples);
  if (calibIndex + 1 < CALIB_ORDER.length) {
    startPoint(calibIndex + 1);
    return;
  }
  finishCalibration(now);
}

function baselineStep(now, gaze) {
  const gap = baselineLast ? now - baselineLast : 0;
  baselineLast = now;
  const dt = gap > 250 ? 0 : gap;
  const dir = CALIB_ORDER[calibIndex];
  const noteOn = calibNote && now < calibNoteUntil;

  if (!gaze) {
    if (now - lastFaceAt > FACE_GRACE_MS) {
      resetPoint();
      setBaselineUi(true, 0);
      calibDot.classList.remove("locked");
      haveSmooth = false;
      showLive("얼굴 없음 · " + stepLabel(), "warn", "얼굴 없음");
    }
    return;
  }

  lastFaceAt = now;
  pointWaitMs += dt;
  const relaxed = pointWaitMs > CALIB_RELAX_MS;

  if (!onTarget(dir, gaze)) {
    pointOffMs += dt;
    if (pointOffMs > OFF_GRACE_MS) {
      resetPoint();
      setBaselineUi(true, 0);
      calibDot.classList.remove("locked");
      const status = noteOn ? calibNote : relaxed ? CALIB_HINT[dir] : CALIB_TEXT[dir];
      showLive(status + " · " + stepLabel(), noteOn ? "warn" : "idle", CALIB_TEXT[dir]);
    }
    return;
  }

  pointOffMs = 0;
  calibDot.classList.add("locked");
  if (pointOnMs < CALIB_SETTLE_MS) {
    pointOnMs += dt;
    setBaselineUi(true, 0);
    showLive("점을 보는 중 · " + stepLabel(), "idle", CALIB_TEXT[dir]);
    return;
  }
  const held = pointOnMs - CALIB_SETTLE_MS;
  pointOnMs += dt;
  baselineSamples.push(gaze);
  setBaselineUi(true, held / CALIB_MS);
  showLive("맞추는 중 · " + stepLabel(), "idle", CALIB_TEXT[dir]);
  if (held >= CALIB_MS && baselineSamples.length >= BASELINE_MIN_SAMPLES) finishPoint(now);
}

function updateDwell(now, dir, faceOk) {
  if (phase !== "count") return;
  const gap = lastTick ? now - lastTick : 0;
  lastTick = now;
  const dt = gap > 250 ? 0 : gap;

  if (!faceOk) {
    if (now - lastFaceAt > FACE_GRACE_MS) {
      clearCharge();
      haveSmooth = false;
      showLive("얼굴 없음", "warn", "얼굴 없음");
    }
    return;
  }

  if (!dir) {
    clearCharge();
    showLive("정면", "idle", "정면");
    return;
  }

  if (dir !== dwellDir) {
    dwellDir = dir;
    dwellAcc = 0;
    holdUntil = 0;
    holdDir = null;
  }

  dwellAcc += dt;
  if (dwellAcc >= DWELL_MS) {
    counts[dir] += 1;
    renderCounts();
    popCount(dir);
    dwellAcc = 0;
    holdUntil = now + COMMIT_HOLD_MS;
    holdDir = dir;
  }

  setGauge(dir, dwellAcc / DWELL_MS);
  const meta = DIR_META[dir];
  if (holdDir === dir && now < holdUntil) {
    const text = meta.name + " " + counts[dir];
    showLive(text, "ok", text);
  } else {
    showLive(meta.watch, "ok", meta.name);
  }
}

function onFrame(now, result) {
  if (phase === "ready") {
    // Still update the experimental cursor during the ready pause.
    const facesReady = result && result.faceLandmarks && result.faceLandmarks.length;
    if (facesReady) {
      const rawReady = gazeFromFace(result);
      const smReady = smoothToward(rawReady.x, rawReady.up, rawReady.down);
      updateGazeCursor(smReady);
    } else {
      updateGazeCursor(null);
    }
    if (now < readyAt) return;
    phase = "count";
    clearCharge();
    lastTick = 0;
  }
  if (phase !== "calib" && phase !== "count") return;
  const faces = result && result.faceLandmarks;
  const faceOk = !!(faces && faces.length);
  if (!faceOk) {
    updateGazeCursor(null);
    if (phase === "calib") baselineStep(now, null);
    else updateDwell(now, null, false);
    return;
  }
  const raw = gazeFromFace(result);
  const sm = smoothToward(raw.x, raw.up, raw.down);
  updateGazeCursor(sm);
  if (phase === "calib") {
    baselineStep(now, sm);
    return;
  }
  lastFaceAt = now;
  updateDwell(now, directionOf(sm), true);
}

function nextTs() {
  let t = performance.now();
  if (t <= lastTs) t = lastTs + 1;
  lastTs = t;
  return t;
}

function loop(now) {
  if (!running) return;
  if (landmarker && cam.readyState >= 2 && !cam.paused) {
    try {
      const result = landmarker.detectForVideo(cam, nextTs());
      onFrame(now, result);
    } catch (err) {
      console.error(err);
      setStatus("추적 중 오류가 났습니다. 페이지를 다시 열어 주세요.", "warn");
    }
  }
  requestAnimationFrame(loop);
}

async function createLandmarker() {
  const { FaceLandmarker, FilesetResolver } = visionMods;
  const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
  const options = (delegate) => ({
    baseOptions: { modelAssetPath: MODEL_URL, delegate },
    runningMode: "VIDEO",
    numFaces: 1,
    outputFaceBlendshapes: true,
    minFaceDetectionConfidence: 0.5,
    minFacePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  try {
    return await FaceLandmarker.createFromOptions(fileset, options("GPU"));
  } catch (err) {
    console.warn(err);
    return await FaceLandmarker.createFromOptions(fileset, options("CPU"));
  }
}

const visionReady = (async () => {
  setStatus("모델을 불러오는 중…");
  visionMods = await import(VISION_URL);
  landmarker = await createLandmarker();
  setStatus("앞 카메라를 켜 주세요");
})().catch((err) => {
  console.error(err);
  setStatus("시선 모델을 불러오지 못했습니다. 네트워크를 확인해 주세요.", "warn");
  throw err;
});

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

function stopStream() {
  if (!stream) return;
  for (const track of stream.getTracks()) track.stop();
  stream = null;
}

async function startCamera() {
  startBtn.disabled = true;
  setStatus("카메라를 여는 중…");
  try {
    await visionReady;
  } catch (err) {
    startBtn.disabled = false;
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: "user",
        width: { ideal: 640 },
        height: { ideal: 480 },
      },
    });
  } catch (err) {
    console.error(err);
    setStatus(cameraErrorText(err), "warn");
    startBtn.disabled = false;
    return;
  }
  cam.srcObject = stream;
  try {
    await cam.play();
  } catch (err) {
    console.error(err);
    stopStream();
    setStatus("카메라 영상을 재생하지 못했습니다.", "warn");
    startBtn.disabled = false;
    return;
  }
  gate.classList.add("hidden");
  running = true;
  recalibBtn.disabled = false;
  beginBaseline();
  requestAnimationFrame(loop);
}

startBtn.addEventListener("click", () => {
  startCamera();
});

window.addEventListener("pagehide", () => {
  running = false;
  stopStream();
  showGazeCursor(false);
});
