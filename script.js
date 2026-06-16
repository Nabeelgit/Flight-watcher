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
  navigator.geolocation.getCurrentPosition(
    pos => {
      userLat = pos.coords.latitude;
      userLon = pos.coords.longitude;
      setStatus("Location acquired. Fetching aircraft…");
      startRadar();
    },
    err => setStatus("Location error: " + err.message),
    { enableHighAccuracy: true, timeout: 10_000 }
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
let cocoModel        = null;   // loaded once at startup
let detectionRunning = false;  // prevents overlapping inference calls
let detectionFrame   = null;   // requestAnimationFrame handle

const DETECTION_INTERVAL_MS  = 250;   // run inference every 250ms
const CONFIDENCE_THRESHOLD   = 0.4;   // min score to draw a box

const debugPanel = document.getElementById("debug");

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

window.addEventListener("load", async () => {
  try {
    // Phase 1: fetch the model.json manifest (tiny, instant)
    setProgress(2);

    // Phase 2: load model — cocoSsd.load() accepts a base path
    // We can't intercept individual weight shard fetches without a custom IOHandler,
    // so we animate the bar smoothly as an estimated progress while loading.
    // This gives honest UX — the bar moves, user sees real activity.
    let estimatedPct = 2;
    const progressInterval = setInterval(() => {
      // Ease toward 90% while waiting — never hits 100 until truly done
      estimatedPct += (90 - estimatedPct) * 0.04;
      setProgress(estimatedPct);
    }, 200);

    cocoModel = await cocoSsd.load();

    clearInterval(progressInterval);
    setProgress(100);
    console.log("COCO-SSD model loaded");
  } catch (err) {
    console.error("Model load failed:", err);
    if (modelProgressPct) modelProgressPct.textContent = "LOAD FAILED";
  }
});

// ── Open camera ────────────────────────────
openCameraBtn?.addEventListener("click", async () => {
  // Show overlay immediately with loading screen
  cameraOverlay.classList.add("active");
  debugPanel?.classList.add("hidden");

  // If model isn't ready yet, show loading screen until it is
  if (!cocoModel) {
    modelLoading?.classList.remove("hidden");
    // Poll until model loads
    await new Promise(resolve => {
      const check = setInterval(() => {
        if (cocoModel) { clearInterval(check); resolve(); }
      }, 200);
    });
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
  // Reset loading screen for next open
  modelLoading?.classList.remove("hidden");
});

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
        // Cyan glowing box matching the app's colour scheme
        ctx.strokeStyle = "#7df9ff";
        ctx.lineWidth   = 2;
        ctx.shadowColor = "#7df9ff";
        ctx.shadowBlur  = 8;
        ctx.strokeRect(x, y, w, h);
        ctx.shadowBlur  = 0;
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