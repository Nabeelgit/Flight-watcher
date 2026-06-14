const WORKER_URL = "https://falling-star-4aca.nabeel30march.workers.dev";

// How wide an angular cone to search (degrees).
// Tighter = more precise but easier to miss. Start at 15°, lower later.
const MATCH_THRESHOLD_DEG = 15;

// How often to re-fetch aircraft data (ms). OpenSky updates every ~10 s.
const FETCH_INTERVAL_MS = 10_000;

// Bounding box — roughly Tampa Bay area. Update for your region:
//   lamin/lamax = lat south/north, lomin/lomax = lon west/east
const BBOX = { lamin: 27.5, lomin: -83.5, lamax: 28.8, lomax: -82.0 };
// └─────────────────────────────────────────────┘


// ── State ──────────────────────────────────────
let userLat = null;
let userLon = null;
let phoneHeading = null;   // α  (compass, 0–360 true north)
let phonePitch = null;     // β  (tilt, 0 = flat, 90 = straight up)
let aircraftList = [];
let matchLoop = null;
let fetchTimer = null;
let active = false;


// ── DOM refs ────────────────────────────────────
const cameraBtn    = document.getElementById("camera-btn");
const statusEl     = document.getElementById("status");
const flightEl     = document.getElementById("val-flight");
const aircraftEl   = document.getElementById("val-aircraft");
const altEl        = document.getElementById("val-altitude");
const speedEl      = document.getElementById("val-speed");
const distEl       = document.getElementById("val-distance");
const routeEl      = document.getElementById("val-route");
const headingDbg   = document.getElementById("dbg-heading");
const pitchDbg     = document.getElementById("dbg-pitch");
const countDbg     = document.getElementById("dbg-count");
const lockEl       = document.getElementById("lock-label");


// ── Entry point ────────────────────────────────
cameraBtn.addEventListener("click", async () => {
  if (active) return;

  setStatus("Requesting permissions…");

  // iOS requires explicit permission for DeviceOrientationEvent
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

  // GPS
  if (!navigator.geolocation) {
    setStatus("Geolocation not supported by this browser.");
    return;
  }

  setStatus("Getting location…");
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      userLat = pos.coords.latitude;
      userLon = pos.coords.longitude;
      setStatus("Location acquired. Starting radar…");
      startRadar();
    },
    (err) => setStatus("Location error: " + err.message),
    { enableHighAccuracy: true, timeout: 10_000 }
  );
});


// ── Radar loop ─────────────────────────────────
function startRadar() {
  active = true;
  cameraBtn.textContent = "RADAR ACTIVE";
  cameraBtn.disabled = true;

  // Listen to orientation
  window.addEventListener("deviceorientation", handleOrientation, true);

  // Initial fetch then repeat
  fetchAircraft();
  fetchTimer = setInterval(fetchAircraft, FETCH_INTERVAL_MS);

  // Match 4× per second
  matchLoop = setInterval(matchAndDisplay, 250);
}


// ── Sensor handler ─────────────────────────────
function handleOrientation(e) {
  // e.alpha = compass heading (0–360, true north)
  // e.beta  = front-back tilt (−180 to 180; 90 = upright)
  // We treat beta-90 ≈ 0 when pointing straight ahead while holding upright,
  // and beta-0 ≈ 90° pitch when holding flat.
  // For a phone held upright and tilted toward sky:
  //   pitch_elevation ≈ beta − 90  (clamp to 0–90)
  if (e.alpha !== null) phoneHeading = e.alpha;
  if (e.beta  !== null) phonePitch   = Math.max(0, e.beta - 90);

  if (headingDbg) headingDbg.textContent = phoneHeading?.toFixed(1) ?? "—";
  if (pitchDbg)   pitchDbg.textContent   = phonePitch?.toFixed(1)  ?? "—";
}


// ── Fetch aircraft via proxy ────────────────────
async function fetchAircraft() {
  const params = new URLSearchParams(BBOX).toString();
  const url = `${WORKER_URL}?${params}`;

  try {
    const res  = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    if (!data.states) {
      console.warn("OpenSky: no states returned", data);
      aircraftList = [];
    } else {
      aircraftList = data.states.map(parseState).filter(Boolean);
    }

    if (countDbg) countDbg.textContent = aircraftList.length;
    console.log(`[${new Date().toLocaleTimeString()}] Aircraft: ${aircraftList.length}`);
  } catch (err) {
    console.error("Fetch error:", err);
    setStatus("Fetch error — check worker URL or network.");
  }
}

/**
 * Map a raw OpenSky state vector to a structured object.
 * Returns null if the aircraft has no usable position.
 *
 * OpenSky state array indices:
 * [0] icao24  [1] callsign  [2] origin_country
 * [3] time_position  [4] last_contact
 * [5] longitude  [6] latitude  [7] baro_altitude
 * [8] on_ground  [9] velocity  [10] true_track
 * [11] vertical_rate  [12] sensors  [13] geo_altitude
 */
function parseState(s) {
  const lat = s[6];
  const lon = s[5];
  const alt = s[7] ?? s[13];   // baro first, geo fallback
  if (lat == null || lon == null || alt == null) return null;
  if (s[8]) return null;        // skip ground traffic

  return {
    icao24:   s[0],
    callsign: s[1]?.trim() || "N/A",
    lat,
    lon,
    altM:     alt,                          // metres
    altFt:    Math.round(alt * 3.28084),
    speedKts: s[9] != null ? Math.round(s[9] * 1.94384) : null,
    heading:  s[10],
  };
}


// ── Matching engine ─────────────────────────────
function matchAndDisplay() {
  if (phoneHeading === null || phonePitch === null) {
    setStatus("Waiting for compass data… (point your phone at the sky)");
    return;
  }
  if (!userLat || !userLon) return;
  if (aircraftList.length === 0) {
    setStatus("No aircraft in range.");
    return;
  }

  let best = null;
  let bestAngle = Infinity;

  for (const ac of aircraftList) {
    const bearing   = bearingTo(userLat, userLon, ac.lat, ac.lon);   // 0–360
    const elevation = elevationTo(userLat, userLon, ac.altM, ac.lat, ac.lon); // deg above horizon

    // Angular separation between phone direction and aircraft direction
    const dH = angleDiff(phoneHeading, bearing);
    const dP = angleDiff(phonePitch,   elevation);
    const angular = Math.sqrt(dH * dH + dP * dP);   // combined cone distance

    if (angular < bestAngle) {
      bestAngle = angular;
      best = { ...ac, bearing, elevation, angular };
    }
  }

  if (best && bestAngle <= MATCH_THRESHOLD_DEG) {
    showTarget(best);
  } else {
    // Show closest even if outside threshold — give partial info
    if (best) showTarget(best, false);
    const msg = best
      ? `Scanning… nearest ${best.callsign} is ${best.angular.toFixed(1)}° off-axis`
      : "No aircraft detected.";
    setStatus(msg);
    if (lockEl) lockEl.textContent = "SCANNING";
    if (lockEl) lockEl.style.color = "#7df9ff";
  }
}


// ── Display ─────────────────────────────────────
function showTarget(ac, locked = true) {
  const distKm = haversineKm(userLat, userLon, ac.lat, ac.lon);

  if (flightEl)   flightEl.textContent   = ac.callsign;
  if (aircraftEl) aircraftEl.textContent = ac.icao24.toUpperCase();
  if (altEl)      altEl.textContent      = ac.altFt.toLocaleString() + " ft";
  if (speedEl)    speedEl.textContent    = ac.speedKts != null ? ac.speedKts + " kts" : "—";
  if (distEl)     distEl.textContent     = distKm.toFixed(1) + " km";
  if (routeEl)    routeEl.textContent    = `Bearing ${Math.round(ac.bearing)}° · Elev ${ac.elevation.toFixed(1)}°`;

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

/** Bearing from (lat1,lon1) to (lat2,lon2) in degrees (0=N, 90=E). */
function bearingTo(lat1, lon1, lat2, lon2) {
  const φ1 = toRad(lat1), φ2 = toRad(lat2);
  const Δλ = toRad(lon2 - lon1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Elevation angle in degrees above horizon from observer to aircraft. */
function elevationTo(userLat, userLon, altM, acLat, acLon) {
  const groundKm = haversineKm(userLat, userLon, acLat, acLon);
  const groundM  = groundKm * 1000;
  if (groundM < 1) return 90;
  return toDeg(Math.atan2(altM, groundM));
}

/** Great-circle distance in km (Haversine). */
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Smallest absolute difference between two angles (handles 359° vs 1° etc.). */
function angleDiff(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;