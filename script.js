// ─────────────────────────────────────────────
//  Flight Watcher — script.js
// ─────────────────────────────────────────────

const WORKER_URL = "https://falling-star-4aca.nabeel30march.workers.dev";

// Angular cone for "locked" — plane must be within this many degrees
// of where you're pointing. 20° is forgiving; tighten later.
const LOCK_THRESHOLD_DEG = 20;

// Fetch interval. Keep at 15s on mobile — OpenSky rate-limits aggressively.
const FETCH_INTERVAL_MS = 15_000;

// Bounding box — Florida + nearby states.
// Kept large so planes are found even far away; matching handles proximity.
const BBOX = { lamin: 25, lamax: 31, lomin: -87, lomax: -79 };

// ── State ──────────────────────────────────────
let userLat      = null;
let userLon      = null;
let phoneHeading = null;
let phonePitch   = null;
let aircraftList = [];
let matchLoop    = null;
let fetchTimer   = null;
let active       = false;
let isFetching   = false;   // prevents overlapping fetches
let lockedIcao   = null;    // icao24 of currently locked aircraft
let lastFetchAt  = null;    // timestamp of last successful fetch

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
const rawDbg     = document.getElementById("dbg-raw");     // raw worker response snippet

// ── Entry point ────────────────────────────────
cameraBtn.addEventListener("click", async () => {
  if (active) return;
  setStatus("Requesting permissions…");

  if (
    typeof DeviceOrientationEvent !== "undefined" &&
    typeof DeviceOrientationEvent.requestPermission === "function"
  ) {
    try {
      const perm = await DeviceOrientationEvent.requestPermission();
      if (perm !== "granted") {
        setStatus("Orientation permission denied. Enable in Settings → Safari.");
        return;
      }
    } catch (err) {
      setStatus("Permission error: " + err.message);
      return;
    }
  }

  if (!navigator.geolocation) {
    setStatus("Geolocation not supported.");
    return;
  }

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
  cameraBtn.textContent = "RADAR ACTIVE";
  cameraBtn.disabled    = true;

  window.addEventListener("deviceorientation", handleOrientation, true);

  fetchAircraft();
  fetchTimer = setInterval(fetchAircraft, FETCH_INTERVAL_MS);
  matchLoop  = setInterval(matchAndDisplay, 250);
}

// ── Sensor handler ─────────────────────────────
function handleOrientation(e) {
  if (e.alpha !== null) phoneHeading = e.alpha;

  // beta=0  → flat face-up, beta=90 → upright portrait
  // elevation = 90 - beta when holding phone upright pointing at sky
  if (e.beta !== null) {
    phonePitch = Math.min(90, Math.max(0, 90 - e.beta));
  }

  if (headingDbg) headingDbg.textContent = phoneHeading?.toFixed(1) ?? "—";
  if (pitchDbg)   pitchDbg.textContent   = `${phonePitch?.toFixed(1) ?? "—"}° (β${e.beta?.toFixed(0) ?? "—"})`;
}

// ── Fetch aircraft via proxy ────────────────────
async function fetchAircraft() {
  // Don't overlap fetches — if previous one is still in flight, skip this tick
  if (isFetching) {
    console.log("Fetch skipped — previous still in flight");
    return;
  }

  isFetching = true;
  if (fetchDbg) fetchDbg.textContent = "fetching…";

  const url = `${WORKER_URL}?${new URLSearchParams(BBOX)}`;

  try {
    const res = await fetch(url);

    if (!res.ok) {
      // Don't wipe aircraftList on a bad response — keep stale data
      console.warn(`Worker HTTP ${res.status}`);
      if (fetchDbg) fetchDbg.textContent = `HTTP ${res.status}`;
      return;
    }

    const data = await res.json();

    if (!data.aircraft) {
      console.warn("Worker returned no aircraft array:", JSON.stringify(data).slice(0, 200));
      if (fetchDbg) fetchDbg.textContent = `no aircraft field — raw: ${JSON.stringify(data).slice(0, 80)}`;
      // Do NOT wipe aircraftList — keep previous data
      return;
    }

    const parsed = data.aircraft.map(parseAircraft).filter(Boolean);

    // Only update the list when we actually got results
    // If OpenSky returned 0 states, keep the old list — transient empty responses
    // happen on mobile networks and shouldn't blank the display
    if (parsed.length > 0) {
      aircraftList = parsed;
      lastFetchAt  = Date.now();
    } else {
      console.warn("Parsed 0 aircraft — keeping stale list of", aircraftList.length);
    }

    if (countDbg) countDbg.textContent = `${aircraftList.length} (${parsed.length} this fetch)`;
    if (fetchDbg) fetchDbg.textContent = `OK ${new Date().toLocaleTimeString()}`;
    if (rawDbg)   rawDbg.textContent   = JSON.stringify(data).slice(0, 80);

  } catch (err) {
    // Network error — keep stale list, show error in debug only
    console.error("Fetch error:", err.message);
    if (fetchDbg) fetchDbg.textContent = `ERR: ${err.message}`;
    // Do NOT call setStatus here — it would overwrite the scanning message
  } finally {
    isFetching = false;
  }
}

function parseAircraft(a) {
  if (a.lat == null || a.lon == null || a.alt == null) return null;
  if (a.alt < 100) return null;   // skip ground / very low traffic
  return {
    icao24:   a.icao24,
    callsign: a.callsign?.trim() || "N/A",
    lat:      a.lat,
    lon:      a.lon,
    altM:     a.alt,
    altFt:    Math.round(a.alt * 3.28084),
    speedKts: a.speed ? Math.round(a.speed * 1.94384) : null,
    heading:  a.heading,
    route:    a.route ?? null,
  };
}

// ── Matching engine ─────────────────────────────
function matchAndDisplay() {
  if (phoneHeading === null || phonePitch === null) {
    setStatus("Waiting for compass… point your phone at the sky");
    return;
  }
  if (!userLat || !userLon) return;
  if (aircraftList.length === 0) {
    const age = lastFetchAt ? `Last fetch: ${Math.round((Date.now() - lastFetchAt) / 1000)}s ago` : "No fetch yet";
    setStatus(`No aircraft data. ${age}`);
    return;
  }

  let best      = null;
  let bestDeg   = Infinity;   // true angular separation in degrees

  for (const ac of aircraftList) {
    const bearing   = bearingTo(userLat, userLon, ac.lat, ac.lon);
    const elevation = elevationTo(userLat, userLon, ac.altM, ac.lat, ac.lon);

    // Angular separation — simple Euclidean in angle-space
    // This is accurate enough within ±30° which is all we care about
    const dH  = angleDiff(phoneHeading, bearing);
    const dP  = angleDiff(phonePitch,   elevation);
    const deg = Math.sqrt(dH * dH + dP * dP);   // degrees, not a weird composite

    if (deg < bestDeg) {
      bestDeg = deg;
      best = { ...ac, bearing, elevation, angularDeg: deg };
    }
  }

  // Hysteresis — once locked, require new candidate to beat current by 5°
  if (lockedIcao && best?.icao24 !== lockedIcao) {
    const current = aircraftList.find(a => a.icao24 === lockedIcao);
    if (current) {
      const cBearing   = bearingTo(userLat, userLon, current.lat, current.lon);
      const cElevation = elevationTo(userLat, userLon, current.altM, current.lat, current.lon);
      const cdH = angleDiff(phoneHeading, cBearing);
      const cdP = angleDiff(phonePitch,   cElevation);
      const currentDeg = Math.sqrt(cdH * cdH + cdP * cdP);

      if (best.angularDeg > currentDeg - 5) {
        // Not clearly better — keep the existing lock
        best = { ...current, bearing: cBearing, elevation: cElevation, angularDeg: currentDeg };
        bestDeg = currentDeg;
      }
    }
  }

  lockedIcao = best?.icao24 ?? null;

  if (best && bestDeg <= LOCK_THRESHOLD_DEG) {
    showTarget(best, true);
  } else {
    if (best) showTarget(best, false);
    setStatus(best
      ? `Scanning… nearest: ${best.callsign} ${bestDeg.toFixed(1)}° off-axis`
      : "No match found"
    );
    if (lockEl) { lockEl.textContent = "SCANNING"; lockEl.style.color = "#7df9ff"; }
  }
}

// ── Display ─────────────────────────────────────
function showTarget(ac, locked) {
  const distKm = haversineKm(userLat, userLon, ac.lat, ac.lon);

  if (flightEl)   flightEl.textContent   = ac.callsign;
  if (aircraftEl) aircraftEl.textContent = ac.icao24.toUpperCase();
  if (altEl)      altEl.textContent      = ac.altFt.toLocaleString() + " ft";
  if (speedEl)    speedEl.textContent    = ac.speedKts != null ? ac.speedKts + " kts" : "—";
  if (distEl)     distEl.textContent     = distKm.toFixed(1) + " km";

  if (routeEl) {
    const r = ac.route;
    if (r?.origin && r?.destination) {
      const from = r.originCity ? `${r.originCity} (${r.origin})` : r.origin;
      const to   = r.destinationCity ? `${r.destinationCity} (${r.destination})` : r.destination;
      routeEl.textContent = `${from} → ${to}`;
    } else {
      routeEl.textContent = "Route data unavailable";
    }
  }

  if (lockEl) {
    lockEl.textContent = locked ? "TARGET LOCKED" : "SCANNING";
    lockEl.style.color = locked ? "#00ff88" : "#7df9ff";
  }

  if (locked) setStatus(`${ac.angularDeg.toFixed(1)}° — locked`);
}

function setStatus(msg) {
  if (statusEl) statusEl.textContent = msg;
}

// ── Geometry helpers ────────────────────────────
function bearingTo(lat1, lon1, lat2, lon2) {
  const φ1 = toRad(lat1), φ2 = toRad(lat2);
  const Δλ = toRad(lon2 - lon1);
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
  const R    = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a    = Math.sin(dLat / 2) ** 2
             + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function angleDiff(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

const toRad = d => d * Math.PI / 180;
const toDeg = r => r * 180 / Math.PI;