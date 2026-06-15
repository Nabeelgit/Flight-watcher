// ─────────────────────────────────────────────
//  Flight Watcher — script.js (v6)
// ─────────────────────────────────────────────

const WORKER_URL         = "https://flight-watcher.nabeel30march.workers.dev";
const LOCK_THRESHOLD_DEG = 20;
const FETCH_INTERVAL_MS  = 15_000;

// ICAO aircraft type designator → { manufacturer, model }
// Covers ~300 most common types seen on ADS-B feeds
const AIRCRAFT_TYPES = {
  // ── Boeing ─────────────────────────────────────────────────────────────
  B701:"Boeing","model":"707",
  B703:{m:"Boeing",o:"707-300"},
  B712:{m:"Boeing",o:"717-200"},
  B721:{m:"Boeing",o:"727-100"},
  B722:{m:"Boeing",o:"727-200"},
  B731:{m:"Boeing",o:"737-100"},
  B732:{m:"Boeing",o:"737-200"},
  B733:{m:"Boeing",o:"737-300"},
  B734:{m:"Boeing",o:"737-400"},
  B735:{m:"Boeing",o:"737-500"},
  B736:{m:"Boeing",o:"737-600"},
  B737:{m:"Boeing",o:"737-700"},
  B738:{m:"Boeing",o:"737-800"},
  B739:{m:"Boeing",o:"737-900"},
  B38M:{m:"Boeing",o:"737 MAX 8"},
  B39M:{m:"Boeing",o:"737 MAX 9"},
  B3XM:{m:"Boeing",o:"737 MAX 10"},
  B741:{m:"Boeing",o:"747-100"},
  B742:{m:"Boeing",o:"747-200"},
  B743:{m:"Boeing",o:"747-300"},
  B744:{m:"Boeing",o:"747-400"},
  B748:{m:"Boeing",o:"747-8"},
  B74S:{m:"Boeing",o:"747SP"},
  B752:{m:"Boeing",o:"757-200"},
  B753:{m:"Boeing",o:"757-300"},
  B762:{m:"Boeing",o:"767-200"},
  B763:{m:"Boeing",o:"767-300"},
  B764:{m:"Boeing",o:"767-400"},
  B772:{m:"Boeing",o:"777-200"},
  B773:{m:"Boeing",o:"777-300"},
  B77L:{m:"Boeing",o:"777-200LR"},
  B77W:{m:"Boeing",o:"777-300ER"},
  B778:{m:"Boeing",o:"777X-8"},
  B779:{m:"Boeing",o:"777X-9"},
  B781:{m:"Boeing",o:"787-8 Dreamliner"},
  B782:{m:"Boeing",o:"787-9 Dreamliner"},
  B783:{m:"Boeing",o:"787-10 Dreamliner"},

  // ── Airbus ─────────────────────────────────────────────────────────────
  A124:{m:"Antonov",o:"An-124 Ruslan"},
  A148:{m:"Antonov",o:"An-148"},
  A158:{m:"Antonov",o:"An-158"},
  A19N:{m:"Airbus",o:"A319neo"},
  A20N:{m:"Airbus",o:"A320neo"},
  A21N:{m:"Airbus",o:"A321neo"},
  A225:{m:"Antonov",o:"An-225 Mriya"},
  A306:{m:"Airbus",o:"A300-600"},
  A30B:{m:"Airbus",o:"A300B"},
  A310:{m:"Airbus",o:"A310"},
  A318:{m:"Airbus",o:"A318"},
  A319:{m:"Airbus",o:"A319"},
  A320:{m:"Airbus",o:"A320"},
  A321:{m:"Airbus",o:"A321"},
  A332:{m:"Airbus",o:"A330-200"},
  A333:{m:"Airbus",o:"A330-300"},
  A338:{m:"Airbus",o:"A330-800neo"},
  A339:{m:"Airbus",o:"A330-900neo"},
  A342:{m:"Airbus",o:"A340-200"},
  A343:{m:"Airbus",o:"A340-300"},
  A345:{m:"Airbus",o:"A340-500"},
  A346:{m:"Airbus",o:"A340-600"},
  A359:{m:"Airbus",o:"A350-900"},
  A35K:{m:"Airbus",o:"A350-1000"},
  A380:{m:"Airbus",o:"A380"},
  A388:{m:"Airbus",o:"A380-800"},

  // ── Embraer ────────────────────────────────────────────────────────────
  E135:{m:"Embraer",o:"ERJ-135"},
  E145:{m:"Embraer",o:"ERJ-145"},
  E170:{m:"Embraer",o:"E170"},
  E175:{m:"Embraer",o:"E175"},
  E190:{m:"Embraer",o:"E190"},
  E195:{m:"Embraer",o:"E195"},
  E290:{m:"Embraer",o:"E190-E2"},
  E295:{m:"Embraer",o:"E195-E2"},
  E50P:{m:"Embraer",o:"Phenom 100"},
  E55P:{m:"Embraer",o:"Phenom 300"},
  E75L:{m:"Embraer",o:"E175 (Long)"},
  E75S:{m:"Embraer",o:"E175 (Short)"},
  E7W:{m:"Embraer", o:"E175-E2"},

  // ── Bombardier ─────────────────────────────────────────────────────────
  B461:{m:"BAe",o:"146-100"},
  B462:{m:"BAe",o:"146-200"},
  B463:{m:"BAe",o:"146-300"},
  BCS1:{m:"Airbus",o:"A220-100"},
  BCS3:{m:"Airbus",o:"A220-300"},
  CL30:{m:"Bombardier",o:"Challenger 300"},
  CL35:{m:"Bombardier",o:"Challenger 350"},
  CL60:{m:"Bombardier",o:"Challenger 600"},
  CL65:{m:"Bombardier",o:"Challenger 650"},
  CRJ1:{m:"Bombardier",o:"CRJ-100"},
  CRJ2:{m:"Bombardier",o:"CRJ-200"},
  CRJ7:{m:"Bombardier",o:"CRJ-700"},
  CRJ9:{m:"Bombardier",o:"CRJ-900"},
  CRJX:{m:"Bombardier",o:"CRJ-1000"},
  GL5T:{m:"Bombardier",o:"Global 5000"},
  GL7T:{m:"Bombardier",o:"Global 7500"},
  GLEX:{m:"Bombardier",o:"Global Express"},

  // ── Gulfstream ─────────────────────────────────────────────────────────
  G150:{m:"Gulfstream",o:"G150"},
  G200:{m:"Gulfstream",o:"G200"},
  G280:{m:"Gulfstream",o:"G280"},
  G2CA:{m:"Gulfstream",o:"G200"},
  G300:{m:"Gulfstream",o:"G300"},
  G350:{m:"Gulfstream",o:"G350"},
  G400:{m:"Gulfstream",o:"G400"},
  G450:{m:"Gulfstream",o:"G450"},
  G500:{m:"Gulfstream",o:"G500"},
  G550:{m:"Gulfstream",o:"G550"},
  G600:{m:"Gulfstream",o:"G600"},
  G650:{m:"Gulfstream",o:"G650"},
  G700:{m:"Gulfstream",o:"G700"},
  GALX:{m:"Gulfstream",o:"Galaxy / G200"},

  // ── Dassault ───────────────────────────────────────────────────────────
  F2TH:{m:"Dassault",o:"Falcon 2000"},
  F900:{m:"Dassault",o:"Falcon 900"},
  F9EX:{m:"Dassault",o:"Falcon 900EX"},
  FA10:{m:"Dassault",o:"Falcon 10"},
  FA20:{m:"Dassault",o:"Falcon 20"},
  FA50:{m:"Dassault",o:"Falcon 50"},
  FA7X:{m:"Dassault",o:"Falcon 7X"},
  FA8X:{m:"Dassault",o:"Falcon 8X"},

  // ── Cessna / Textron ───────────────────────────────────────────────────
  C150:{m:"Cessna",o:"150"},
  C152:{m:"Cessna",o:"152"},
  C162:{m:"Cessna",o:"162 Skycatcher"},
  C172:{m:"Cessna",o:"172 Skyhawk"},
  C177:{m:"Cessna",o:"177 Cardinal"},
  C180:{m:"Cessna",o:"180"},
  C182:{m:"Cessna",o:"182 Skylane"},
  C185:{m:"Cessna",o:"185 Skywagon"},
  C190:{m:"Cessna",o:"190"},
  C195:{m:"Cessna",o:"195"},
  C205:{m:"Cessna",o:"205"},
  C206:{m:"Cessna",o:"206 Stationair"},
  C207:{m:"Cessna",o:"207"},
  C208:{m:"Cessna",o:"208 Caravan"},
  C210:{m:"Cessna",o:"210 Centurion"},
  C25A:{m:"Cessna",o:"Citation CJ2"},
  C25B:{m:"Cessna",o:"Citation CJ3"},
  C25C:{m:"Cessna",o:"Citation CJ4"},
  C303:{m:"Cessna",o:"303 Crusader"},
  C310:{m:"Cessna",o:"310"},
  C337:{m:"Cessna",o:"337 Skymaster"},
  C340:{m:"Cessna",o:"340"},
  C402:{m:"Cessna",o:"402"},
  C404:{m:"Cessna",o:"404 Titan"},
  C414:{m:"Cessna",o:"414"},
  C421:{m:"Cessna",o:"421 Golden Eagle"},
  C425:{m:"Cessna",o:"425 Conquest"},
  C441:{m:"Cessna",o:"441 Conquest"},
  C500:{m:"Cessna",o:"Citation I"},
  C501:{m:"Cessna",o:"Citation I/SP"},
  C510:{m:"Cessna",o:"Citation Mustang"},
  C525:{m:"Cessna",o:"CitationJet"},
  C526:{m:"Cessna",o:"Citation Excel"},
  C550:{m:"Cessna",o:"Citation II"},
  C551:{m:"Cessna",o:"Citation II/SP"},
  C560:{m:"Cessna",o:"Citation V"},
  C56X:{m:"Cessna",o:"Citation Excel/XLS"},
  C650:{m:"Cessna",o:"Citation III/VI/VII"},
  C680:{m:"Cessna",o:"Citation Sovereign"},
  C68A:{m:"Cessna",o:"Citation Sovereign+"},
  C700:{m:"Cessna",o:"Citation Longitude"},
  C750:{m:"Cessna",o:"Citation X"},

  // ── Piper ──────────────────────────────────────────────────────────────
  P28A:{m:"Piper",o:"PA-28 Cherokee"},
  P28B:{m:"Piper",o:"PA-28 Warrior"},
  P28R:{m:"Piper",o:"PA-28R Arrow"},
  P28T:{m:"Piper",o:"PA-28RT Turbo Arrow"},
  P32R:{m:"Piper",o:"PA-32R Lance"},
  P32T:{m:"Piper",o:"PA-32T Turbo Lance"},
  P46T:{m:"Piper",o:"PA-46 Malibu Meridian"},
  PA18:{m:"Piper",o:"PA-18 Super Cub"},
  PA24:{m:"Piper",o:"PA-24 Comanche"},
  PA27:{m:"Piper",o:"PA-27"},
  PA31:{m:"Piper",o:"PA-31 Navajo"},
  PA32:{m:"Piper",o:"PA-32 Cherokee Six"},
  PA34:{m:"Piper",o:"PA-34 Seneca"},
  PA44:{m:"Piper",o:"PA-44 Seminole"},
  PA46:{m:"Piper",o:"PA-46 Malibu"},

  // ── Beechcraft / Hawker ────────────────────────────────────────────────
  B06:{m:"Beechcraft", o:"Model 60 Duke"},
  B18T:{m:"Beechcraft",o:"Model 18"},
  B36T:{m:"Beechcraft",o:"Bonanza 36"},
  B350:{m:"Beechcraft",o:"King Air 350"},
  B58:{m:"Beechcraft", o:"Baron 58"},
  B60:{m:"Beechcraft", o:"Duke"},
  BE10:{m:"Beechcraft",o:"King Air 100"},
  BE20:{m:"Beechcraft",o:"King Air 200"},
  BE30:{m:"Beechcraft",o:"King Air 300"},
  BE35:{m:"Beechcraft",o:"Bonanza 35"},
  BE36:{m:"Beechcraft",o:"Bonanza 36"},
  BE40:{m:"Beechcraft",o:"Premier I"},
  BE55:{m:"Beechcraft",o:"Baron 55"},
  BE58:{m:"Beechcraft",o:"Baron 58"},
  BE76:{m:"Beechcraft",o:"Duchess"},
  BE99:{m:"Beechcraft",o:"King Air 99"},
  H25B:{m:"Hawker",    o:"800"},
  H25C:{m:"Hawker",    o:"850XP"},
  HA4T:{m:"Hawker",    o:"4000"},
  HDJT:{m:"Honda",     o:"HondaJet"},

  // ── Helicopters ────────────────────────────────────────────────────────
  A109:{m:"Airbus",    o:"H109"},
  A119:{m:"Airbus",    o:"Koala"},
  A139:{m:"Airbus",    o:"AW139"},
  AS32:{m:"Airbus",    o:"AS332 Super Puma"},
  AS50:{m:"Airbus",    o:"AS350 Ecureuil"},
  AS55:{m:"Airbus",    o:"AS355 Ecureuil 2"},
  AS65:{m:"Airbus",    o:"AS365 Dauphin"},
  B06:{m:"Bell",       o:"206 JetRanger"},
  B06T:{m:"Bell",      o:"206L LongRanger"},
  B212:{m:"Bell",      o:"212"},
  B222:{m:"Bell",      o:"222"},
  B230:{m:"Bell",      o:"230"},
  B407:{m:"Bell",      o:"407"},
  B412:{m:"Bell",      o:"412"},
  B427:{m:"Bell",      o:"427"},
  B429:{m:"Bell",      o:"429"},
  B430:{m:"Bell",      o:"430"},
  B505:{m:"Bell",      o:"505 Jet Ranger X"},
  B525:{m:"Bell",      o:"525 Relentless"},
  EC20:{m:"Airbus",    o:"H120"},
  EC25:{m:"Airbus",    o:"H125 Ecureuil"},
  EC30:{m:"Airbus",    o:"H130"},
  EC35:{m:"Airbus",    o:"H135"},
  EC45:{m:"Airbus",    o:"H145"},
  EC55:{m:"Airbus",    o:"H155"},
  EC75:{m:"Airbus",    o:"H175"},
  H47:{m:"Boeing",     o:"CH-47 Chinook"},
  K35R:{m:"Boeing",    o:"KC-135 Stratotanker"},
  MD11:{m:"Boeing",    o:"MD-11"},
  MD52:{m:"MD",        o:"MD-520N"},
  MD83:{m:"Boeing",    o:"MD-83"},
  MD90:{m:"Boeing",    o:"MD-90"},
  R22:{m:"Robinson",   o:"R22"},
  R44:{m:"Robinson",   o:"R44"},
  R66:{m:"Robinson",   o:"R66"},
  S61:{m:"Sikorsky",   o:"S-61"},
  S76:{m:"Sikorsky",   o:"S-76"},
  S92:{m:"Sikorsky",   o:"S-92"},
  UH60:{m:"Sikorsky",  o:"UH-60 Black Hawk"},

  // ── Regional / Turboprop ───────────────────────────────────────────────
  AT43:{m:"ATR",       o:"ATR 42-300"},
  AT45:{m:"ATR",       o:"ATR 42-500"},
  AT46:{m:"ATR",       o:"ATR 42-600"},
  AT72:{m:"ATR",       o:"ATR 72-200"},
  AT75:{m:"ATR",       o:"ATR 72-500"},
  AT76:{m:"ATR",       o:"ATR 72-600"},
  D228:{m:"Dornier",   o:"228"},
  D328:{m:"Dornier",   o:"328"},
  DH8A:{m:"Bombardier",o:"Dash 8 Q100"},
  DH8B:{m:"Bombardier",o:"Dash 8 Q200"},
  DH8C:{m:"Bombardier",o:"Dash 8 Q300"},
  DH8D:{m:"Bombardier",o:"Dash 8 Q400"},
  DHC2:{m:"De Havilland",o:"Beaver"},
  DHC3:{m:"De Havilland",o:"Otter"},
  DHC6:{m:"De Havilland",o:"Twin Otter"},
  F50:{m:"Fokker",     o:"50"},
  F70:{m:"Fokker",     o:"70"},
  F100:{m:"Fokker",    o:"100"},
  JS31:{m:"BAe",       o:"Jetstream 31"},
  JS41:{m:"BAe",       o:"Jetstream 41"},
  L410:{m:"LET",       o:"L-410 Turbolet"},
  MA60:{m:"XIAN",      o:"MA60"},
  PC12:{m:"Pilatus",   o:"PC-12"},
  PC24:{m:"Pilatus",   o:"PC-24"},
  SF34:{m:"SAAB",      o:"340"},
  SB20:{m:"SAAB",      o:"2000"},
  SW4:{m:"Swearingen", o:"Merlin IV"},
  TBM7:{m:"Socata",    o:"TBM 700"},
  TBM8:{m:"Daher",     o:"TBM 850"},
  TBM9:{m:"Daher",     o:"TBM 900/910/930/940"},
  TRIS:{m:"Pilatus",   o:"Britten-Norman Trislander"},

  // ── Learjet ────────────────────────────────────────────────────────────
  LJ23:{m:"Learjet",   o:"23"},
  LJ24:{m:"Learjet",   o:"24"},
  LJ25:{m:"Learjet",   o:"25"},
  LJ28:{m:"Learjet",   o:"28"},
  LJ31:{m:"Learjet",   o:"31"},
  LJ35:{m:"Learjet",   o:"35"},
  LJ40:{m:"Learjet",   o:"40"},
  LJ45:{m:"Learjet",   o:"45"},
  LJ55:{m:"Learjet",   o:"55"},
  LJ60:{m:"Learjet",   o:"60"},
  LJ75:{m:"Learjet",   o:"75"},

  // ── Misc / Military ───────────────────────────────────────────────────
  C130:{m:"Lockheed",  o:"C-130 Hercules"},
  C17:{m:"Boeing",     o:"C-17 Globemaster"},
  C5:{m:"Lockheed",    o:"C-5 Galaxy"},
  DC10:{m:"Boeing",    o:"DC-10"},
  E3CF:{m:"Boeing",    o:"E-3 Sentry (AWACS)"},
  P8:{m:"Boeing",      o:"P-8 Poseidon"},
  SR22:{m:"Cirrus",    o:"SR22"},
  SR20:{m:"Cirrus",    o:"SR20"},
  EVOT:{m:"Eve",       o:"eVTOL"},
  A10:{m:"Fairchild",  o:"A-10 Thunderbolt"},
  F16:{m:"Lockheed",   o:"F-16 Fighting Falcon"},
  F18:{m:"Boeing",     o:"F/A-18 Hornet"},
  F35:{m:"Lockheed",   o:"F-35 Lightning II"},
};


// Resolve ICAO type code → human readable string e.g. "Boeing 737-800"
function resolveAircraftType(code) {
  if (!code) return null;
  const entry = AIRCRAFT_TYPES[code.toUpperCase()];
  if (!entry) return code;   // unknown — return raw code as fallback
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
    aircraftType: a.aircraftType ?? null,
    aircraftLabel: resolveAircraftType(a.aircraftType),  // "Boeing 737-800"
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

  // Aircraft type — show full manufacturer + model if known
  if (aircraftEl) {
    aircraftEl.textContent = ac.aircraftLabel ?? ac.aircraftType ?? ac.icao24.toUpperCase();
  }
  const hexEl = document.getElementById("val-hex");
  if (hexEl) hexEl.textContent = ac.icao24.toUpperCase();

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