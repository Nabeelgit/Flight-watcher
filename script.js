// ─────────────────────────────────────────────
//  Flight Watcher — script.js
// ─────────────────────────────────────────────

const WORKER_URL         = "https://flight-watcher.nabeel30march.workers.dev";
const LOCK_THRESHOLD_DEG = 20;
const FETCH_INTERVAL_MS  = 15_000;

// Resolve ICAO type code → human readable string e.g. "Boeing 737-800"
function resolveAircraftType(code) {
  if (!code) return null;
  const entry = AIRCRAFT_TYPES[code.toUpperCase()];
  if (!entry) return code;
  return `${entry.m} ${entry.o}`;
}

// ── State ──────────────────────────────────────
let userLat      = null;
let userLon      = null;
let phoneHeading = null;
let phonePitch   = null;
let aircraftList = [];
let matchLoop    = null;
let fetchTimer   = null;
let active       = false;
let paused       = false;
let isFetching   = false;
let lockedIcao   = null;
let lastFetchAt  = null;
let manualLock   = null;
let nearbyList   = [];
const routeCache   = new Map();
const routePending = new Set();

// ── DOM refs — radar ────────────────────────────
const radarBtn   = document.getElementById("radar-btn");
const statusEl   = document.getElementById("status");
const flightEl   = document.getElementById("val-flight");
const aircraftEl = document.getElementById("val-aircraft");
const altEl      = document.getElementById("val-altitude");
const speedEl    = document.getElementById("val-speed");
const distEl     = document.getElementById("val-distance");
const routeEl    = document.getElementById("val-route");
const headingDbg = document.getElementById("dbg-heading");
const pitchDbg   = document.getElementById("dbg-pitch");
const countDbg   = document.getElementById("dbg-count");
const lockEl     = document.getElementById("lock-label");
const fetchDbg   = document.getElementById("dbg-fetch");
const rawDbg     = document.getElementById("dbg-raw");
const lockBtn    = document.getElementById("lock-btn");

// ── DOM refs — camera ───────────────────────────
const openCameraBtn  = document.getElementById("open-camera-btn");
const modelLoading    = document.getElementById("model-loading");
const modelProgressFill = document.getElementById("model-progress-fill");
const modelProgressPct  = document.getElementById("model-progress-pct");
const closeCameraBtn = document.getElementById("close-camera-btn");
const cameraOverlay  = document.getElementById("camera-overlay");
const cameraFeed     = document.getElementById("camera-feed");
const cameraBarHint  = document.getElementById("camera-bar-hint");
const photoStrip     = document.getElementById("photo-strip");
const shutterBtn      = document.getElementById("shutter-btn");
const previewOverlay  = document.getElementById("photo-preview-overlay");
const previewImg      = document.getElementById("photo-preview-img");
const previewClose    = document.getElementById("photo-preview-close");
const saveBtn         = document.getElementById("photo-save-btn");
const shareBtn        = document.getElementById("photo-share-btn");
const identifyBtn    = document.getElementById("identify-btn");
const cameraInfoEl   = document.getElementById("camera-info");
const zoomInBtn      = document.getElementById("zoom-in-btn");
const zoomOutBtn     = document.getElementById("zoom-out-btn");

// ── Manual lock controls ───────────────────────
lockBtn?.addEventListener("click", () => {
  if (!active || paused) return;

  if (manualLock) {
    manualLock = null;
    lockBtn.textContent = "LOCK TARGET";
    lockBtn.classList.remove("hard-locked");
    if (lockEl) { lockEl.textContent = "SCANNING"; lockEl.style.color = "#7df9ff"; }
    setStatus("Manual lock released - auto-scanning");
  } else {
    const target = nearbyList[0];
    if (!target) { setStatus("No aircraft to lock"); return; }
    manualLock = target.icao24;
    lockBtn.textContent = "LOCKED - TAP TO RELEASE";
    lockBtn.classList.add("hard-locked");
    showTarget(target, true);
    fetchRoute(target.callsign);
  }
});

// ── Radar entry point ──────────────────────────
radarBtn.addEventListener("click", async () => {
  if (active) {
    paused = !paused;
    if (paused) {
      clearInterval(matchLoop);
      clearInterval(fetchTimer);
      matchLoop = null;
      fetchTimer = null;
      radarBtn.textContent = "RESUME";
      radarBtn.style.borderColor = "#ff9f00";
      radarBtn.style.color = "#ff9f00";
      if (lockEl) { lockEl.textContent = "PAUSED"; lockEl.style.color = "#ff9f00"; }
      setStatus("Radar paused - tap Resume to continue.");
    } else {
      fetchAircraft();
      fetchTimer = setInterval(fetchAircraft, FETCH_INTERVAL_MS);
      matchLoop  = setInterval(matchAndDisplay, 250);
      radarBtn.textContent = "PAUSE";
      radarBtn.style.borderColor = "";
      radarBtn.style.color = "";
      setStatus("Radar resumed.");
    }
    return;
  }

  setStatus("Requesting permissions…");

  if (
    typeof DeviceOrientationEvent !== "undefined" &&
    typeof DeviceOrientationEvent.requestPermission === "function"
  ) {
    try {
      const perm = await DeviceOrientationEvent.requestPermission();
      if (perm !== "granted") {
        setStatus("Orientation permission denied. Enable in Settings > Safari.");
        return;
      }
    } catch (err) {
      setStatus("Permission error: " + err.message);
      return;
    }
  }

  if (!navigator.geolocation) { setStatus("Geolocation not supported."); return; }

  setStatus("Getting location…");

  // Try high accuracy first, fall back to low accuracy if it fails
  // Some iOS versions deny enableHighAccuracy even when location is allowed
  navigator.geolocation.getCurrentPosition(
    pos => {
      userLat = pos.coords.latitude;
      userLon = pos.coords.longitude;
      setStatus("Location acquired. Fetching aircraft…");
      startRadar();
    },
    err => {
      if (err.code === err.PERMISSION_DENIED) {
        setStatus("Location denied. Check Settings > Privacy > Location Services > Safari.");
        return;
      }
      // High accuracy failed — retry with low accuracy
      setStatus("Retrying location…");
      navigator.geolocation.getCurrentPosition(
        pos => {
          userLat = pos.coords.latitude;
          userLon = pos.coords.longitude;
          setStatus("Location acquired. Fetching aircraft…");
          startRadar();
        },
        err2 => setStatus("Location error: " + err2.message),
        { enableHighAccuracy: false, timeout: 10_000 }
      );
    },
    { enableHighAccuracy: true, timeout: 8_000 }
  );
});

// ── Radar loop ─────────────────────────────────
function startRadar() {
  active = true;
  radarBtn.textContent = "PAUSE";
  window.addEventListener("deviceorientation", handleOrientation, true);
  fetchAircraft();
  fetchTimer = setInterval(fetchAircraft, FETCH_INTERVAL_MS);
  matchLoop  = setInterval(matchAndDisplay, 250);
}

// ── Sensor handler ─────────────────────────────
function handleOrientation(e) {
  if (e.alpha !== null) phoneHeading = e.alpha;
  if (e.beta  !== null) phonePitch   = Math.min(90, Math.max(0, e.beta));
  if (headingDbg) headingDbg.textContent = phoneHeading?.toFixed(1) ?? "-";
  if (pitchDbg)   pitchDbg.textContent   = `${phonePitch?.toFixed(1) ?? "-"} deg (b${e.beta?.toFixed(0) ?? "-"})`;
}

// ── Fetch aircraft ──────────────────────────────
async function fetchAircraft() {
  if (isFetching) return;
  isFetching = true;
  if (fetchDbg) fetchDbg.textContent = "fetching…";
  try {
    const res = await fetch(`${WORKER_URL}?lat=${userLat.toFixed(5)}&lon=${userLon.toFixed(5)}`);
    if (!res.ok) { if (fetchDbg) fetchDbg.textContent = `HTTP ${res.status}`; return; }
    const data = await res.json();
    if (rawDbg) rawDbg.textContent = JSON.stringify(data).slice(0, 120);
    if (data.error) { if (fetchDbg) fetchDbg.textContent = `ERR: ${data.error}`; return; }
    if (!data.aircraft?.length) { if (fetchDbg) fetchDbg.textContent = `empty (total=${data.total ?? "?"})`; return; }
    aircraftList = data.aircraft.map(parseAircraft).filter(Boolean);
    lastFetchAt  = Date.now();
    if (countDbg) countDbg.textContent = `${aircraftList.length} / ${data.total ?? "?"}`;
    if (fetchDbg) fetchDbg.textContent = `OK ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    if (fetchDbg) fetchDbg.textContent = `ERR: ${err.message}`;
  } finally {
    isFetching = false;
  }
}

function parseAircraft(a) {
  if (a.lat == null || a.lon == null || a.alt == null || a.alt < 100) return null;
  return {
    icao24:        a.icao24,
    callsign:      a.callsign?.trim() || "N/A",
    lat:           a.lat,
    lon:           a.lon,
    altM:          a.alt,
    altFt:         Math.round(a.alt * 3.28084),
    speedKts:      a.speed ? Math.round(a.speed) : null,
    heading:       a.heading,
    aircraftType:  a.aircraftType ?? null,
    aircraftLabel: resolveAircraftType(a.aircraftType),
    airline:       a.airline ?? null,
  };
}

// ── On-demand route fetch ──────────────────────
async function fetchRoute(callsign) {
  if (!callsign || callsign === "N/A") return;
  if (routeCache.has(callsign)) return;
  if (routePending.has(callsign)) return;
  routePending.add(callsign);
  try {
    const res  = await fetch(`${WORKER_URL}/route?callsign=${encodeURIComponent(callsign)}`);
    if (!res.ok) return;
    const data = await res.json();
    routeCache.set(callsign, data);
    // If this callsign is currently showing in camera info, refresh it
    if (cameraMatchedAc?.callsign === callsign && cameraInfoEl && !cameraInfoEl.classList.contains("hidden")) {
      showCameraInfo(cameraMatchedAc);
    }
    if (lockedIcao) {
      const ac = aircraftList.find(a => a.icao24 === lockedIcao);
      if (ac?.callsign === callsign) showTarget(
        { ...ac,
          bearing:    bearingTo(userLat, userLon, ac.lat, ac.lon),
          elevation:  elevationTo(userLat, userLon, ac.altM, ac.lat, ac.lon),
          angularDeg: 0 },
        true
      );
    }
  } catch { /* silent */ } finally {
    routePending.delete(callsign);
  }
}

// ── Matching engine ─────────────────────────────
function matchAndDisplay() {
  if (phoneHeading === null || phonePitch === null) {
    setStatus("Waiting for compass… point your phone at the sky");
    return;
  }
  if (!userLat || !userLon) return;
  if (!aircraftList.length) {
    const age = lastFetchAt ? `Last data: ${Math.round((Date.now() - lastFetchAt) / 1000)}s ago` : "No data yet";
    setStatus(`No aircraft. ${age}`);
    return;
  }

  let best    = null;
  let bestDeg = Infinity;

  for (const ac of aircraftList) {
    const bearing   = bearingTo(userLat, userLon, ac.lat, ac.lon);
    const elevation = elevationTo(userLat, userLon, ac.altM, ac.lat, ac.lon);
    const dH  = angleDiff(phoneHeading, bearing);
    const dP  = angleDiff(phonePitch,   elevation);
    const deg = Math.sqrt(dH * dH + dP * dP);
    if (deg < bestDeg) { bestDeg = deg; best = { ...ac, bearing, elevation, angularDeg: deg }; }
  }

  // Hysteresis
  if (lockedIcao && best?.icao24 !== lockedIcao) {
    const cur = aircraftList.find(a => a.icao24 === lockedIcao);
    if (cur) {
      const cb   = bearingTo(userLat, userLon, cur.lat, cur.lon);
      const ce   = elevationTo(userLat, userLon, cur.altM, cur.lat, cur.lon);
      const cdeg = Math.sqrt(angleDiff(phoneHeading, cb) ** 2 + angleDiff(phonePitch, ce) ** 2);
      if (best.angularDeg > cdeg - 5) { best = { ...cur, bearing: cb, elevation: ce, angularDeg: cdeg }; bestDeg = cdeg; }
    }
  }

  nearbyList = aircraftList
    .map(ac => {
      const b  = bearingTo(userLat, userLon, ac.lat, ac.lon);
      const e  = elevationTo(userLat, userLon, ac.altM, ac.lat, ac.lon);
      const dH = angleDiff(phoneHeading, b);
      const dP = angleDiff(phonePitch, e);
      return { ...ac, bearing: b, elevation: e, angularDeg: Math.sqrt(dH*dH + dP*dP) };
    })
    .sort((a, b) => a.angularDeg - b.angularDeg);

  if (manualLock) {
    const ac = aircraftList.find(a => a.icao24 === manualLock);
    if (ac) {
      const b  = bearingTo(userLat, userLon, ac.lat, ac.lon);
      const e  = elevationTo(userLat, userLon, ac.altM, ac.lat, ac.lon);
      const dH = angleDiff(phoneHeading, b);
      const dP = angleDiff(phonePitch, e);
      showTarget({ ...ac, bearing: b, elevation: e, angularDeg: Math.sqrt(dH*dH + dP*dP) }, true);
      if (!routeCache.has(ac.callsign)) fetchRoute(ac.callsign);
    }
    return;
  }

  lockedIcao = best?.icao24 ?? null;

  if (best && bestDeg <= LOCK_THRESHOLD_DEG) {
    showTarget(best, true);
    fetchRoute(best.callsign);
  } else {
    if (best) showTarget(best, false);
    setStatus(best ? `Scanning… ${best.callsign} ${bestDeg.toFixed(1)} deg off-axis` : "No match found");
    if (lockEl) { lockEl.textContent = "SCANNING"; lockEl.style.color = "#7df9ff"; }
  }
}

// ── Display ─────────────────────────────────────
function showTarget(ac, locked) {
  const distKm = haversineKm(userLat, userLon, ac.lat, ac.lon);
  if (flightEl)   flightEl.textContent   = ac.callsign;
  if (aircraftEl) aircraftEl.textContent = ac.aircraftLabel ?? ac.aircraftType ?? ac.icao24.toUpperCase();
  const hexEl = document.getElementById("val-hex");
  if (hexEl) hexEl.textContent = ac.icao24.toUpperCase();
  if (altEl)   altEl.textContent   = ac.altFt.toLocaleString() + " ft";
  if (speedEl) speedEl.textContent = ac.speedKts != null ? ac.speedKts + " kts" : "-";
  if (distEl)  distEl.textContent  = distKm.toFixed(1) + " km";

  if (routeEl) {
    const r = ac.airline;
    routeEl.textContent = r?.airline
      ? `${r.airline} - ${r.prefix}${r.flightNumber ?? ""}`
      : (ac.callsign !== "N/A" ? ac.callsign : "-");
  }

  const originDestEl = document.getElementById("val-origin-dest");
  if (originDestEl) {
    const route = routeCache.get(ac.callsign);
    if (route?.origin && route?.destination) {
      const from = route.originCity      ? `${route.originCity} (${route.origin})`      : route.origin;
      const to   = route.destinationCity ? `${route.destinationCity} (${route.destination})` : route.destination;
      originDestEl.textContent = `${from} to ${to}`;
    } else if (routePending.has(ac.callsign)) {
      originDestEl.textContent = "Looking up route…";
    } else {
      originDestEl.textContent = "-";
    }
  }

  if (lockEl) {
    lockEl.textContent = locked ? "TARGET LOCKED" : "SCANNING";
    lockEl.style.color = locked ? "#00ff88" : "#7df9ff";
  }
  if (locked) setStatus(`${ac.angularDeg.toFixed(1)} deg - locked`);
}

function setStatus(msg) {
  if (statusEl) statusEl.textContent = msg;
}

// ── Geometry ────────────────────────────────────
function bearingTo(lat1, lon1, lat2, lon2) {
  const φ1 = toRad(lat1), φ2 = toRad(lat2), Δλ = toRad(lon2 - lon1);
  const y  = Math.sin(Δλ) * Math.cos(φ2);
  const x  = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function elevationTo(uLat, uLon, altM, acLat, acLon) {
  const groundM = haversineKm(uLat, uLon, acLat, acLon) * 1000;
  if (groundM < 1) return 90;
  return toDeg(Math.atan2(altM, groundM));
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function angleDiff(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

const toRad = d => d * Math.PI / 180;
const toDeg = r => r * 180 / Math.PI;

// ── Camera mode ─────────────────────────────────
let cameraStream     = null;
let infoSource       = null;   // null | "manual" | "detection"
let cameraMatchedAc  = null;   // aircraft currently shown in camera info

// ── Zoom state ──────────────────────────────────
let zoomCapabilities = null;   // { min, max, step } from track — null if hardware zoom unsupported
let currentZoom      = 1;
let cssZoomFallback  = false;  // true when using CSS transform instead of hardware zoom
const CSS_ZOOM_MIN   = 1;
const CSS_ZOOM_MAX   = 4;
const CSS_ZOOM_STEP  = 0.3;
let cocoModel        = null;   // loaded once at startup
let detectionRunning = false;  // prevents overlapping inference calls
let detectionFrame   = null;   // requestAnimationFrame handle

const DETECTION_INTERVAL_MS  = 400;   // run inference every 400ms — smoother on mobile
const CONFIDENCE_THRESHOLD   = 0.4;   // min score to draw a box

const debugPanel = document.getElementById("debug");

// ── Camera match helpers ───────────────────

// Find closest aircraft to current phone bearing/pitch
function matchBestAircraft() {
  if (!aircraftList.length || phoneHeading === null || phonePitch === null) return null;
  if (!userLat || !userLon) return null;

  let best    = null;
  let bestDeg = Infinity;

  for (const ac of aircraftList) {
    const bearing   = bearingTo(userLat, userLon, ac.lat, ac.lon);
    const elevation = elevationTo(userLat, userLon, ac.altM, ac.lat, ac.lon);
    const dH  = angleDiff(phoneHeading, bearing);
    const dP  = angleDiff(phonePitch,   elevation);
    const deg = Math.sqrt(dH * dH + dP * dP);
    if (deg < bestDeg) { bestDeg = deg; best = { ...ac, bearing, elevation, angularDeg: deg }; }
  }
  return best;
}

function showCameraInfo(ac) {
  cameraMatchedAc = ac;

  document.getElementById("cam-aircraft").textContent =
    ac.aircraftLabel ?? ac.aircraftType ?? ac.icao24.toUpperCase();

  const r = ac.airline;
  document.getElementById("cam-airline").textContent = r?.airline
    ? `${r.airline} - ${r.prefix}${r.flightNumber ?? ""}`
    : (ac.callsign !== "N/A" ? ac.callsign : "-");

  const route = routeCache.get(ac.callsign);
  if (route?.origin && route?.destination) {
    const from = route.originCity      ? `${route.originCity} (${route.origin})`      : route.origin;
    const to   = route.destinationCity ? `${route.destinationCity} (${route.destination})` : route.destination;
    document.getElementById("cam-route").textContent = `${from} to ${to}`;
  } else if (routePending.has(ac.callsign)) {
    document.getElementById("cam-route").textContent = "Looking up route...";
  } else {
    document.getElementById("cam-route").textContent = "-";
  }

  document.getElementById("cam-speed").textContent =
    ac.speedKts != null ? `${ac.speedKts} kts` : "-";

  cameraInfoEl?.classList.remove("hidden");
}

function hideCameraInfo() {
  cameraMatchedAc = null;
  cameraInfoEl?.classList.add("hidden");
}

// ── Ensure radar data is available in camera mode ──
// Camera mode needs GPS, orientation, and the aircraft fetch loop.
// If radar was never started, set these up independently.
let cameraDataActive = false;

async function ensureCameraData() {
  if (cameraDataActive) return;
  cameraDataActive = true;

  // 1. Orientation — request permission (iOS) and attach listener
  if (
    typeof DeviceOrientationEvent !== "undefined" &&
    typeof DeviceOrientationEvent.requestPermission === "function"
  ) {
    try {
      const perm = await DeviceOrientationEvent.requestPermission();
      if (perm === "granted") {
        window.addEventListener("deviceorientation", handleOrientation, true);
      }
    } catch { /* ignore */ }
  } else {
    window.addEventListener("deviceorientation", handleOrientation, true);
  }

  // 2. GPS — get location if we don't have it yet
  if ((!userLat || !userLon) && navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      pos => {
        userLat = pos.coords.latitude;
        userLon = pos.coords.longitude;
        // Kick off aircraft fetch once we have a position
        startCameraFetch();
      },
      () => { /* location failed — identify won't work but camera still shows */ },
      { enableHighAccuracy: false, timeout: 10_000 }
    );
  } else if (userLat && userLon) {
    startCameraFetch();
  }
}

// Aircraft fetch loop for camera mode (only if radar isn't already running it)
function startCameraFetch() {
  fetchAircraft();
  if (!fetchTimer) {
    fetchTimer = setInterval(fetchAircraft, FETCH_INTERVAL_MS);
  }
}

// ── Identify button ─────────────────────────
identifyBtn?.addEventListener("click", () => {
  // If detection is driving the info, don't interfere
  if (infoSource === "detection") return;

  // Toggle off if already showing manual info
  if (infoSource === "manual") {
    infoSource = null;
    identifyBtn.classList.remove("active");
    hideCameraInfo();
    return;
  }

  // Match and show
  const ac = matchBestAircraft();
  if (!ac) {
    // Tell the user why nothing happened
    document.getElementById("cam-aircraft").textContent =
      !userLat ? "Waiting for GPS..."
      : phoneHeading === null ? "Waiting for compass..."
      : !aircraftList.length ? "No aircraft in range"
      : "No match";
    document.getElementById("cam-airline").textContent = "";
    document.getElementById("cam-route").textContent = "";
    document.getElementById("cam-speed").textContent = "";
    cameraInfoEl?.classList.remove("hidden");
    infoSource = "manual";
    identifyBtn.classList.add("active");
    return;
  }

  infoSource = "manual";
  identifyBtn.classList.add("active");
  showCameraInfo(ac);
  fetchRoute(ac.callsign);
});

// ── Load COCO-SSD model on page load ──────
// cocoSsd.load() accepts a modelUrl and onProgress callback.
// We intercept weight fetches by passing a custom fetch-with-progress wrapper.

function setProgress(pct) {
  if (modelProgressFill) modelProgressFill.style.width = `${pct}%`;
  if (modelProgressPct)  modelProgressPct.textContent  = `${Math.round(pct)}%`;
}

// Fetch a URL and report download progress via onProgress(0..1)
async function fetchWithProgress(url, onProgress) {
  const res = await fetch(url);
  const total = parseInt(res.headers.get("content-length") ?? "0", 10);
  if (!total) {
    // No content-length — can't track, just return the response as-is
    return res;
  }
  const reader = res.body.getReader();
  let received = 0;
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress(received / total);
  }
  const blob = new Blob(chunks);
  return new Response(blob, { headers: res.headers });
}

// TF.js is loaded on demand when camera opens (not on page load)
// This prevents the 3MB JS parse from freezing the UI on first visit
let tfLoaded = false;

async function loadTF() {
  if (tfLoaded) return true;
  try {
    // Dynamically inject tf.min.js then coco-ssd.min.js in order
    await loadScript("./assets/tf.min.js");
    await loadScript("./assets/coco-ssd.min.js");
    tfLoaded = true;
    return true;
  } catch (err) {
    console.error("TF.js load failed:", err);
    return false;
  }
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload  = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

async function loadModel() {
  setProgress(2);
  let estimatedPct = 2;
  const interval = setInterval(() => {
    estimatedPct += (90 - estimatedPct) * 0.04;
    setProgress(estimatedPct);
  }, 200);

  try {
    await tf.setBackend("webgl");
    await tf.ready();
    cocoModel = await cocoSsd.load();
    clearInterval(interval);
    setProgress(100);
    console.log("COCO-SSD model loaded");
  } catch (err) {
    clearInterval(interval);
    console.error("Model load failed:", err);
    if (modelProgressPct) modelProgressPct.textContent = "LOAD FAILED";
  }
}

// ── Open camera ────────────────────────────
openCameraBtn?.addEventListener("click", async () => {
  // Show overlay with loading screen immediately — page stays responsive
  cameraOverlay.classList.add("active");
  debugPanel?.classList.add("hidden");

  // Load TF.js scripts on demand (first tap only — subsequent taps are instant)
  if (!tfLoaded) {
    modelLoading?.classList.remove("hidden");
    const ok = await loadTF();
    if (!ok) {
      if (modelProgressPct) modelProgressPct.textContent = "LOAD FAILED";
      return;
    }
  }

  // Load model if not already loaded
  if (!cocoModel) {
    modelLoading?.classList.remove("hidden");
    await loadModel();
  }
  modelLoading?.classList.add("hidden");

  // Start camera stream
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
      audio: false,
    });
    cameraFeed.srcObject = cameraStream;
  } catch (err) {
    alert("Camera access denied: " + err.message);
    cameraOverlay.classList.remove("active");
    debugPanel?.classList.remove("hidden");
    return;
  }

  // Wait for video to be playing before starting detection
  cameraFeed.addEventListener("playing", startDetection, { once: true });

  // Set up GPS, orientation and aircraft data for identify/detection
  ensureCameraData();

  // Set up zoom (hardware if supported, CSS transform fallback otherwise)
  initZoom();
});

// ── Close camera ───────────────────────────
closeCameraBtn?.addEventListener("click", () => {
  stopDetection();
  if (cameraStream) {
    cameraStream.getTracks().forEach(t => t.stop());
    cameraStream = null;
    cameraFeed.srcObject = null;
  }
  cameraOverlay.classList.remove("active");
  debugPanel?.classList.remove("hidden");

  // Stop camera-only fetch loop if radar isn't using it
  if (!active && fetchTimer) {
    clearInterval(fetchTimer);
    fetchTimer = null;
  }
  cameraDataActive = false;

  // Reset state
  infoSource = null;
  identifyBtn?.classList.remove("active");
  hideCameraInfo();
  modelLoading?.classList.remove("hidden");

  // Reset zoom for next open
  resetZoom();
});

// ── Zoom system ─────────────────────────────
// Tries hardware zoom (MediaStreamTrack.applyConstraints) first — this is
// true optical/sensor zoom on devices that support it (most modern phones).
// Falls back to CSS transform scaling on devices/browsers that don't expose
// the "zoom" constraint (notably most desktop browsers, some Android WebViews).
function initZoom() {
  currentZoom     = 1;
  cssZoomFallback = false;
  cameraFeed.style.transform = "scale(1)";

  const track = cameraStream?.getVideoTracks?.()[0];
  if (!track) return;

  const capabilities = track.getCapabilities?.();
  if (capabilities?.zoom) {
    zoomCapabilities = capabilities.zoom;   // { min, max, step }
    currentZoom      = capabilities.zoom.min ?? 1;
  } else {
    // Hardware zoom not supported — use CSS transform instead
    zoomCapabilities = null;
    cssZoomFallback  = true;
  }
  updateZoomButtonStates();
}

function applyZoom(newZoom) {
  if (cssZoomFallback) {
    newZoom = Math.min(CSS_ZOOM_MAX, Math.max(CSS_ZOOM_MIN, newZoom));
    currentZoom = newZoom;
    cameraFeed.style.transform = `scale(${newZoom})`;
    // Canvas must scale identically so bounding boxes stay aligned with the zoomed video
    const canvas = document.getElementById("detection-canvas");
    if (canvas) canvas.style.transform = `scale(${newZoom})`;
  } else if (zoomCapabilities) {
    newZoom = Math.min(zoomCapabilities.max, Math.max(zoomCapabilities.min, newZoom));
    currentZoom = newZoom;
    const track = cameraStream?.getVideoTracks?.()[0];
    track?.applyConstraints({ advanced: [{ zoom: newZoom }] }).catch(() => {
      // Constraint failed — device claimed support but rejected it; fall back to CSS
      cssZoomFallback  = true;
      zoomCapabilities = null;
      cameraFeed.style.transform = `scale(${newZoom})`;
    });
  }
  updateZoomButtonStates();
}

function zoomStep() {
  return cssZoomFallback ? CSS_ZOOM_STEP : (zoomCapabilities?.step || 0.5);
}

function zoomMin() {
  return cssZoomFallback ? CSS_ZOOM_MIN : (zoomCapabilities?.min ?? 1);
}

function zoomMax() {
  return cssZoomFallback ? CSS_ZOOM_MAX : (zoomCapabilities?.max ?? 1);
}

function updateZoomButtonStates() {
  if (zoomInBtn)  zoomInBtn.disabled  = currentZoom >= zoomMax();
  if (zoomOutBtn) zoomOutBtn.disabled = currentZoom <= zoomMin();
}

function resetZoom() {
  currentZoom      = 1;
  zoomCapabilities = null;
  cssZoomFallback  = false;
  cameraFeed.style.transform = "scale(1)";
  const canvas = document.getElementById("detection-canvas");
  if (canvas) canvas.style.transform = "scale(1)";
}

zoomInBtn?.addEventListener("click", () => applyZoom(currentZoom + zoomStep()));
zoomOutBtn?.addEventListener("click", () => applyZoom(currentZoom - zoomStep()));

// ── Pinch to zoom ───────────────────────────
// Tracks two-finger touch distance; scales zoom proportionally to pinch delta.
// Listeners are non-passive so we can preventDefault() and stop the browser's
// native pinch-to-zoom/double-tap-zoom from firing on top of our custom zoom.
let pinchStartDist = null;
let pinchStartZoom = 1;

cameraOverlay.addEventListener("touchstart", (e) => {
  if (e.touches.length === 2) {
    e.preventDefault();
    pinchStartDist = getTouchDistance(e.touches);
    pinchStartZoom = currentZoom;
  }
}, { passive: false });

cameraOverlay.addEventListener("touchmove", (e) => {
  if (e.touches.length === 2) {
    e.preventDefault();   // block native pinch zoom on the page
    if (pinchStartDist) {
      const newDist = getTouchDistance(e.touches);
      const scale   = newDist / pinchStartDist;
      const newZoom = pinchStartZoom * scale;
      applyZoom(newZoom);
    }
  }
}, { passive: false });

cameraOverlay.addEventListener("touchend", (e) => {
  if (e.touches.length < 2) pinchStartDist = null;
}, { passive: false });

// Block double-tap-to-zoom inside camera mode specifically
let lastTapTime = 0;
cameraOverlay.addEventListener("touchend", (e) => {
  const now = Date.now();
  if (now - lastTapTime < 300) {
    e.preventDefault();
  }
  lastTapTime = now;
}, { passive: false });

function getTouchDistance(touches) {
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.sqrt(dx * dx + dy * dy);
}

// ── Detection loop ─────────────────────────
function startDetection() {
  const canvas  = document.getElementById("detection-canvas");
  const ctx     = canvas.getContext("2d");
  let lastRun   = 0;

  async function loop(timestamp) {
    detectionFrame = requestAnimationFrame(loop);

    // Size canvas to match video every frame (handles orientation changes)
    if (canvas.width  !== cameraFeed.videoWidth ||
        canvas.height !== cameraFeed.videoHeight) {
      canvas.width  = cameraFeed.videoWidth;
      canvas.height = cameraFeed.videoHeight;
    }

    // Throttle inference
    if (timestamp - lastRun < DETECTION_INTERVAL_MS) return;
    if (detectionRunning) return;
    lastRun = timestamp;

    detectionRunning = true;
    try {
      const predictions = await cocoModel.detect(cameraFeed);
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const planes = predictions.filter(
        p => p.class === "airplane" && p.score >= CONFIDENCE_THRESHOLD
      );

      for (const p of planes) {
        const [x, y, w, h] = p.bbox;
        ctx.strokeStyle = "#7df9ff";
        ctx.lineWidth   = 2;
        ctx.shadowColor = "#7df9ff";
        ctx.shadowBlur  = 8;
        ctx.strokeRect(x, y, w, h);
        ctx.shadowBlur  = 0;
      }

      // When detection fires, match and show info (takes priority over manual)
      if (planes.length > 0) {
        const ac = matchBestAircraft();
        if (ac) {
          infoSource = "detection";
          identifyBtn?.classList.remove("active");   // detection took over
          showCameraInfo(ac);
          fetchRoute(ac.callsign);
        }
      } else {
        // No planes — if detection was driving, hide info
        if (infoSource === "detection") {
          infoSource = null;
          hideCameraInfo();
        }
      }
    } catch { /* frame error — skip */ } finally {
      detectionRunning = false;
    }
  }

  detectionFrame = requestAnimationFrame(loop);
}

function stopDetection() {
  if (detectionFrame) {
    cancelAnimationFrame(detectionFrame);
    detectionFrame = null;
  }
  const canvas = document.getElementById("detection-canvas");
  const ctx    = canvas?.getContext("2d");
  ctx?.clearRect(0, 0, canvas.width, canvas.height);
}

// ── Photo capture ───────────────────────────
// Stored in memory only — cleared on page reload, never persisted.
const photos = [];   // { blobUrl, id }

shutterBtn?.addEventListener("click", () => {
  capturePhoto();
});

function capturePhoto() {
  const vw = cameraFeed.videoWidth;
  const vh = cameraFeed.videoHeight;
  if (!vw || !vh) return;   // video not ready

  const canvas = document.createElement("canvas");
  canvas.width  = vw;
  canvas.height = vh;
  const ctx = canvas.getContext("2d");

  // 1. Draw the current video frame at full resolution
  ctx.drawImage(cameraFeed, 0, 0, vw, vh);

  // 2. If flight info is currently visible, draw it onto the photo too
  //    (positioned to match where it appears on screen, scaled to video resolution)
  if (cameraInfoEl && !cameraInfoEl.classList.contains("hidden")) {
    drawInfoOverlayOnCanvas(ctx, vw, vh);
  }

  // 3. Convert to blob and store
  canvas.toBlob((blob) => {
    if (!blob) return;
    const blobUrl = URL.createObjectURL(blob);
    const photo   = { blobUrl, id: Date.now() };
    photos.unshift(photo);
    addThumbnail(photo);
  }, "image/jpeg", 0.92);

  // Quick visual flash feedback
  flashShutter();
}

function flashShutter() {
  const flash = document.createElement("div");
  flash.style.position = "absolute";
  flash.style.inset = "0";
  flash.style.background = "#fff";
  flash.style.opacity = "0.6";
  flash.style.zIndex = "215";
  flash.style.pointerEvents = "none";
  flash.style.transition = "opacity 0.25s ease";
  cameraOverlay.appendChild(flash);
  requestAnimationFrame(() => { flash.style.opacity = "0"; });
  setTimeout(() => flash.remove(), 300);
}

// Replicate the on-screen flight info panel onto the captured canvas.
// Scales font/positions proportionally from CSS pixels to video resolution.
function drawInfoOverlayOnCanvas(ctx, vw, vh) {
  const rect      = cameraOverlay.getBoundingClientRect();
  const scaleX    = vw / rect.width;
  const scaleY    = vh / rect.height;
  const infoRect  = cameraInfoEl.getBoundingClientRect();

  const x = (infoRect.left - rect.left) * scaleX;
  const y = (infoRect.top  - rect.top)  * scaleY;
  const w = infoRect.width  * scaleX;
  const h = infoRect.height * scaleY;

  // Background panel
  ctx.fillStyle = "rgba(0,0,0,0.72)";
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = "rgba(125,249,255,0.5)";
  ctx.lineWidth = 2 * scaleX;
  ctx.strokeRect(x, y, w, h);

  // Text lines
  const lines = [
    document.getElementById("cam-aircraft")?.textContent,
    document.getElementById("cam-airline")?.textContent,
    document.getElementById("cam-route")?.textContent,
    document.getElementById("cam-speed")?.textContent,
  ].filter(Boolean);

  const fontSize = 13 * scaleY;
  ctx.font = `${fontSize}px Orbitron, sans-serif`;
  ctx.fillStyle = "#d7ffff";
  ctx.textBaseline = "top";

  const padding   = 14 * scaleX;
  const lineGap   = 22 * scaleY;
  lines.forEach((line, i) => {
    ctx.fillStyle = i === 0 ? "#7df9ff" : "#d7ffff";
    ctx.fillText(line, x + padding, y + padding + i * lineGap);
  });
}

function addThumbnail(photo) {
  const img = document.createElement("img");
  img.src = photo.blobUrl;
  img.className = "photo-thumb";
  img.dataset.photoId = photo.id;
  img.addEventListener("click", () => openPreview(photo));
  photoStrip.prepend(img);
}

// ── Photo preview / save / share ────────────
let currentPreviewPhoto = null;

function openPreview(photo) {
  currentPreviewPhoto = photo;
  previewImg.src = photo.blobUrl;
  previewOverlay.classList.add("active");
}

previewClose?.addEventListener("click", () => {
  previewOverlay.classList.remove("active");
  currentPreviewPhoto = null;
});

saveBtn?.addEventListener("click", () => {
  if (!currentPreviewPhoto) return;
  const a = document.createElement("a");
  a.href = currentPreviewPhoto.blobUrl;
  a.download = `flight-watcher-${currentPreviewPhoto.id}.jpg`;
  document.body.appendChild(a);
  a.click();
  a.remove();
});

shareBtn?.addEventListener("click", async () => {
  if (!currentPreviewPhoto) return;

  try {
    const res  = await fetch(currentPreviewPhoto.blobUrl);
    const blob = await res.blob();
    const file = new File([blob], `flight-watcher-${currentPreviewPhoto.id}.jpg`, { type: "image/jpeg" });

    if (navigator.share && navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: "Flight Watcher" });
    } else {
      alert("Sharing not supported on this browser. Use Save instead.");
    }
  } catch (err) {
    if (err.name !== "AbortError") {
      console.error("Share failed:", err);
    }
  }
});