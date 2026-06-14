// ─────────────────────────────────────────────
//  Flight Watcher — script.js (v6)
// ─────────────────────────────────────────────

const WORKER_URL         = "https://flight-watcher.nabeel30march.workers.dev";
const LOCK_THRESHOLD_DEG = 20;
const FETCH_INTERVAL_MS  = 15_000;

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
let manualLock   = null;   // icao24 of hard-locked aircraft (user-selected)
let nearbyList   = [];     // sorted by angular distance, for NEXT cycling
const routeCache   = new Map();   // callsign → {origin, destination, originCity, destinationCity}
const routePending = new Set();    // callsigns currently being fetched

// ── DOM refs ────────────────────────────────────
const cameraBtn  = document.getElementById("camera-btn");
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

// ── Manual lock controls ───────────────────────
lockBtn?.addEventListener("click", () => {
  if (!active || paused) return;

  if (manualLock) {
    // Release — back to auto-scan
    manualLock = null;
    lockBtn.textContent = "LOCK TARGET";
    lockBtn.classList.remove("hard-locked");
    if (lockEl) { lockEl.textContent = "SCANNING"; lockEl.style.color = "#7df9ff"; }
    setStatus("Manual lock released - auto-scanning");
  } else {
    // Lock onto the current closest aircraft in nearbyList
    const target = nearbyList[0];
    if (!target) { setStatus("No aircraft to lock"); return; }
    manualLock = target.icao24;
    lockBtn.textContent = "LOCKED - TAP TO RELEASE";
    lockBtn.classList.add("hard-locked");
    showTarget(target, true);
    fetchRoute(target.callsign);
  }
});

// ── Entry point ────────────────────────────────
cameraBtn.addEventListener("click", async () => {
  // If already running — toggle pause
  if (active) {
    paused = !paused;
    if (paused) {
      clearInterval(matchLoop);
      clearInterval(fetchTimer);
      matchLoop = null;
      fetchTimer = null;
      cameraBtn.textContent = "RESUME";
      cameraBtn.style.borderColor = "#ff9f00";
      cameraBtn.style.color = "#ff9f00";
      if (lockEl) { lockEl.textContent = "PAUSED"; lockEl.style.color = "#ff9f00"; }
      setStatus("Radar paused - tap Resume to continue.");
    } else {
      fetchAircraft();
      fetchTimer = setInterval(fetchAircraft, FETCH_INTERVAL_MS);
      matchLoop  = setInterval(matchAndDisplay, 250);
      cameraBtn.textContent = "PAUSE";
      cameraBtn.style.borderColor = "";
      cameraBtn.style.color = "";
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
  cameraBtn.textContent = "PAUSE";
  cameraBtn.disabled    = false;

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
  if (pitchDbg)   pitchDbg.textContent = `${phonePitch?.toFixed(1) ?? "-"} deg (b${e.beta?.toFixed(0) ?? "-"})`;
}

// ── Fetch aircraft ──────────────────────────────
async function fetchAircraft() {
  if (isFetching) return;
  isFetching = true;
  if (fetchDbg) fetchDbg.textContent = "fetching…";

  try {
    const res  = await fetch(`${WORKER_URL}?lat=${userLat.toFixed(5)}&lon=${userLon.toFixed(5)}`);
    if (!res.ok) { if (fetchDbg) fetchDbg.textContent = `HTTP ${res.status}`; return; }

    const data = await res.json();
    if (rawDbg) rawDbg.textContent = JSON.stringify(data).slice(0, 120);

    if (data.error) {
      if (fetchDbg) fetchDbg.textContent = `ERR: ${data.error}`;
      return;
    }

    if (!data.aircraft?.length) {
      if (fetchDbg) fetchDbg.textContent = `empty (total raw=${data.total ?? "?"})`;
      return;   // keep stale list
    }

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
    icao24:       a.icao24,
    callsign:     a.callsign?.trim() || "N/A",
    lat:          a.lat,
    lon:          a.lon,
    altM:         a.alt,
    altFt:        Math.round(a.alt * 3.28084),
    speedKts:     a.speed ? Math.round(a.speed) : null,
    heading:      a.heading,
    aircraftType: a.aircraftType ?? null,   // "B738", "A320", etc.
    airline:      a.airline ?? null,        // { airline, flightNumber, prefix }
  };
}

// ── On-demand route fetch ──────────────────────────
async function fetchRoute(callsign) {
  if (!callsign || callsign === "N/A") return;
  if (routeCache.has(callsign)) return;   // already have it (even if null)
  if (routePending.has(callsign)) return; // already in flight

  routePending.add(callsign);
  try {
    const res  = await fetch(`${WORKER_URL}/route?callsign=${encodeURIComponent(callsign)}`);
    if (!res.ok) return;
    const data = await res.json();
    routeCache.set(callsign, data);

    // If this is still the locked aircraft, refresh display immediately
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
    const age = lastFetchAt
      ? `Last data: ${Math.round((Date.now() - lastFetchAt) / 1000)}s ago`
      : "No data yet";
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

    if (deg < bestDeg) {
      bestDeg = deg;
      best = { ...ac, bearing, elevation, angularDeg: deg };
    }
  }

  // Hysteresis — require 5° improvement to break existing lock
  if (lockedIcao && best?.icao24 !== lockedIcao) {
    const cur = aircraftList.find(a => a.icao24 === lockedIcao);
    if (cur) {
      const cb   = bearingTo(userLat, userLon, cur.lat, cur.lon);
      const ce   = elevationTo(userLat, userLon, cur.altM, cur.lat, cur.lon);
      const cdeg = Math.sqrt(angleDiff(phoneHeading, cb) ** 2 + angleDiff(phonePitch, ce) ** 2);
      if (best.angularDeg > cdeg - 5) {
        best    = { ...cur, bearing: cb, elevation: ce, angularDeg: cdeg };
        bestDeg = cdeg;
      }
    }
  }

  // Keep nearbyList sorted by angular distance for NEXT cycling
  nearbyList = aircraftList
    .map(ac => {
      const b = bearingTo(userLat, userLon, ac.lat, ac.lon);
      const e = elevationTo(userLat, userLon, ac.altM, ac.lat, ac.lon);
      const dH = angleDiff(phoneHeading, b);
      const dP = angleDiff(phonePitch, e);
      return { ...ac, bearing: b, elevation: e, angularDeg: Math.sqrt(dH*dH + dP*dP) };
    })
    .sort((a, b) => a.angularDeg - b.angularDeg);

  // If user has manually locked, always show that aircraft
  if (manualLock) {
    const ac = aircraftList.find(a => a.icao24 === manualLock);
    if (ac) {
      const b = bearingTo(userLat, userLon, ac.lat, ac.lon);
      const e = elevationTo(userLat, userLon, ac.altM, ac.lat, ac.lon);
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
    setStatus(best
      ? `Scanning… ${best.callsign} ${bestDeg.toFixed(1)}° off-axis`
      : "No match found"
    );
    if (lockEl) { lockEl.textContent = "SCANNING"; lockEl.style.color = "#7df9ff"; }
  }
}

// ── Display ─────────────────────────────────────
function showTarget(ac, locked) {
  const distKm = haversineKm(userLat, userLon, ac.lat, ac.lon);

  // Flight ID line
  if (flightEl) flightEl.textContent = ac.callsign;

  // Aircraft type line — show type code if available, else ICAO hex
  if (aircraftEl) {
    aircraftEl.textContent = ac.aircraftType
      ? `${ac.aircraftType} - ${ac.icao24.toUpperCase()}`
      : ac.icao24.toUpperCase();
  }

  if (altEl)  altEl.textContent  = ac.altFt.toLocaleString() + " ft";
  if (speedEl) speedEl.textContent = ac.speedKts != null ? ac.speedKts + " kts" : "-";
  if (distEl) distEl.textContent  = distKm.toFixed(1) + " km";

  // Airline line
  if (routeEl) {
    const r = ac.airline;
    const airlineName = r?.airline
      ? `${r.airline} - ${r.prefix}${r.flightNumber ?? ""}`
      : (ac.callsign !== "N/A" ? ac.callsign : "-");
    routeEl.textContent = airlineName;
  }

  // Origin → destination line
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

  if (locked) setStatus(`${ac.angularDeg.toFixed(1)}° - locked`);
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