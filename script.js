// ─────────────────────────────────────────────
//  Flight Watcher — script.js
// ─────────────────────────────────────────────

const WORKER_URL = "https://falling-star-4aca.nabeel30march.workers.dev";
const MATCH_THRESHOLD_DEG = 15;
const FETCH_INTERVAL_MS   = 10_000;
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
let lockedAc     = null;   // hysteresis: keep current lock unless clearly better

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
      setStatus("Location acquired. Starting radar…");
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
  if (e.beta  !== null) phonePitch   = Math.max(0, e.beta - 90);

  if (headingDbg) headingDbg.textContent = phoneHeading?.toFixed(1) ?? "—";
  if (pitchDbg)   pitchDbg.textContent   = phonePitch?.toFixed(1)   ?? "—";
}

// ── Fetch aircraft via proxy ────────────────────
async function fetchAircraft() {
  const url = `${WORKER_URL}?${new URLSearchParams(BBOX)}`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    if (!data.aircraft) {
      console.warn("Worker returned no aircraft field", data);
      aircraftList = [];
    } else {
      aircraftList = data.aircraft.map(parseAircraft).filter(Boolean);
    }

    if (countDbg) countDbg.textContent = aircraftList.length;
  } catch (err) {
    console.error("Fetch error:", err);
    setStatus("Fetch error — check worker URL or network.");
  }
}

function parseAircraft(a) {
  if (a.lat == null || a.lon == null || a.alt == null) return null;
  return {
    icao24:   a.icao24,
    callsign: a.callsign?.trim() || "N/A",
    lat:      a.lat,
    lon:      a.lon,
    altM:     a.alt,
    altFt:    Math.round(a.alt * 3.28084),
    speedKts: a.speed ? Math.round(a.speed * 1.94384) : null,
    heading:  a.heading,
    route:    a.route ?? null,   // { origin, destination, originCity, destinationCity } | null
  };
}

// ── Matching engine ─────────────────────────────
function matchAndDisplay() {
  if (phoneHeading === null || phonePitch === null) {
    setStatus("Waiting for compass… point your phone at the sky");
    return;
  }
  if (!userLat || !userLon) return;
  if (aircraftList.length === 0) { setStatus("No aircraft in range."); return; }

  let best      = null;
  let bestScore = Infinity;

  for (const ac of aircraftList) {
    const bearing   = bearingTo(userLat, userLon, ac.lat, ac.lon);
    const elevation = elevationTo(userLat, userLon, ac.altM, ac.lat, ac.lon);
    const distKm    = haversineKm(userLat, userLon, ac.lat, ac.lon);

    const dH    = angleDiff(phoneHeading, bearing);
    const dP    = angleDiff(phonePitch,   elevation);
    const score = dH * dH + 2.0 * dP * dP + 0.05 * distKm;

    if (isFinite(score) && score < bestScore) {
      bestScore = score;
      best = { ...ac, bearing, elevation, score };
    }
  }

  // Hysteresis — only break lock if new candidate is clearly better (20% margin)
  if (lockedAc && best && best.icao24 !== lockedAc.icao24) {
    const lockedCurrent = aircraftList.find(a => a.icao24 === lockedAc.icao24);
    if (lockedCurrent) {
      const lBearing   = bearingTo(userLat, userLon, lockedCurrent.lat, lockedCurrent.lon);
      const lElevation = elevationTo(userLat, userLon, lockedCurrent.altM, lockedCurrent.lat, lockedCurrent.lon);
      const lDistKm    = haversineKm(userLat, userLon, lockedCurrent.lat, lockedCurrent.lon);
      const lDH        = angleDiff(phoneHeading, lBearing);
      const lDP        = angleDiff(phonePitch,   lElevation);
      const lockedScore = lDH * lDH + 2.0 * lDP * lDP + 0.05 * lDistKm;

      if (best.score >= lockedScore * 0.8) {
        // New candidate not enough better — keep lock
        best = { ...lockedCurrent, bearing: lBearing, elevation: lElevation, score: lockedScore };
      }
    }
  }
  lockedAc = best;

  if (best && best.score <= MATCH_THRESHOLD_DEG) {
    showTarget(best, true);
  } else {
    if (best) showTarget(best, false);
    setStatus(best
      ? `Scanning… nearest: ${best.callsign} (${best.score.toFixed(1)}° off)`
      : "No aircraft detected."
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
      // Prefer city names if available, fall back to IATA codes
      const from = r.originCity      || r.origin;
      const to   = r.destinationCity || r.destination;
      // Always show IATA codes in brackets so it's unambiguous
      const fromLabel = r.originCity      ? `${r.originCity} (${r.origin})`      : r.origin;
      const toLabel   = r.destinationCity ? `${r.destinationCity} (${r.destination})` : r.destination;
      routeEl.textContent = `${fromLabel} → ${toLabel}`;
    } else {
      routeEl.textContent = "Route data unavailable";
    }
  }

  if (lockEl) {
    lockEl.textContent = locked ? "TARGET LOCKED" : "SCANNING";
    lockEl.style.color = locked ? "#00ff88" : "#7df9ff";
  }

  if (locked) setStatus("");
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