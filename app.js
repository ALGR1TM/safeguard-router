import * as pdfjsLib from 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.min.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.worker.min.mjs';

let pendingStops = null;  // stops parsed but waiting on a home address
const $ = (id) => document.getElementById(id);
const status = (msg, err = false) => { const s = $('status'); s.textContent = msg; s.className = 'status' + (err ? ' err' : ''); };

// ---------- settings (device-local) ----------
const store = {
  get home(){ return localStorage.getItem('home') || ''; },
  set home(v){ localStorage.setItem('home', v); },
  get gas(){ return parseFloat(localStorage.getItem('gas') || '3.20'); },
  set gas(v){ localStorage.setItem('gas', v); },
  get mpg(){ return parseFloat(localStorage.getItem('mpg') || '24'); },
  set mpg(v){ localStorage.setItem('mpg', v); },
};
function loadSettings(){ $('homeAddr').value = store.home; $('gasPrice').value = store.gas; $('mpg').value = store.mpg; }
$('settingsBtn').onclick = () => $('settings').classList.toggle('hidden');
$('saveSettings').onclick = () => {
  store.home = $('homeAddr').value.trim(); store.gas = $('gasPrice').value; store.mpg = $('mpg').value;
  $('settings').classList.add('hidden');
  if (store.home && pendingStops){ const s = pendingStops; pendingStops = null; run(s); }  // resume without re-upload
  else status('Settings saved.');
};

// ---------- parsing ----------
// Turn raw lines into stops: [{stop, id, address, vacant, zip}]
function parseStops(lines){
  const out = [];
  for (const raw of lines){
    const line = raw.replace(/\s+/g, ' ').trim();
    if (!line) continue;
    if (/^stop\b/i.test(line)) continue;            // header
    if (/\.xlsx?$/i.test(line)) continue;           // trailing filename
    // stop#  orderID  [*] address...
    const m = line.match(/^(\d{1,3})\s+(\d{6,})\s+(\*\s*)?(.+)$/);
    if (!m) continue;
    const address = m[4].trim();
    const zipM = address.match(/(\d{5})(?:-\d{4})?\s*$/);
    out.push({ stop: +m[1], id: m[2], vacant: !!m[3], address, zip: zipM ? zipM[1] : '' });
  }
  return out;
}

async function parsePdf(file){
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const lines = [];
  for (let p = 1; p <= pdf.numPages; p++){
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    // group text items into visual lines by y position
    const rows = {};
    for (const it of tc.items){
      const y = Math.round(it.transform[5]);
      (rows[y] ||= []).push({ x: it.transform[4], s: it.str });
    }
    Object.keys(rows).map(Number).sort((a,b)=>b-a).forEach(y=>{
      const s = rows[y].sort((a,b)=>a.x-b.x).map(o=>o.s).join(' ');
      lines.push(s);
    });
  }
  return parseStops(lines);
}

// ---------- geocoding (cached) ----------
const geoCache = JSON.parse(localStorage.getItem('geo') || '{}');
const saveGeo = () => localStorage.setItem('geo', JSON.stringify(geoCache));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Clean up the messy addresses these sheets contain so the geocoder can read them.
function normalizeAddr(a){
  let s = a.replace(/,?\s*USA\s*$/i, '');
  s = s.replace(/\bF[Tt]\.?\s+WORTH\b/ig, 'Fort Worth');   // FT WORTH -> Fort Worth
  s = s.replace(/^(\d+)([A-Za-z])\b/, '$1 $2');            // 453S / 8204S -> 453 S / 8204 S
  if (!/\bTX\b/i.test(s)) s = s.replace(/,\s*(\d{5})(-\d{4})?\s*$/, ', TX $1'); // add state
  return s.replace(/\s+/g, ' ').trim();
}
// The city token (segment before the ZIP), for a ZIP/city-level fallback.
function cityOf(a){
  const parts = a.replace(/,?\s*USA\s*$/i,'').split(',').map(x=>x.trim()).filter(Boolean)
    .filter(x => !/^\d{5}(-\d{4})?$/.test(x) && !/^TX(\s+\d{5})?$/i.test(x));
  return parts.length > 1 ? parts[parts.length-1] : '';
}

async function geoQuery(q){
  const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&q=' + encodeURIComponent(q);
  const res = await fetch(url, { headers: { 'Accept':'application/json' } });
  const j = await res.json();
  return j.length ? { lat:+j[0].lat, lon:+j[0].lon } : null;
}

// Best-effort locate: precise address first, then ZIP/city center. Returns {lat,lon,approx}.
async function geocode(addr, zip){
  const key = addr.toLowerCase();
  if (geoCache[key]) return geoCache[key];
  let pt = null;
  try { pt = await geoQuery(normalizeAddr(addr)); } catch(e){}
  let approx = false;
  if (!pt){
    await sleep(1100);
    const fq = [cityOf(addr), 'TX', zip].filter(Boolean).join(' ');
    try { pt = await geoQuery(fq); approx = !!pt; } catch(e){}
  }
  const val = pt ? { ...pt, approx } : null;
  if (val){ geoCache[key] = val; saveGeo(); }
  return val;
}

// ---------- optimization ----------
function haversine(a, b){
  const R = 3958.8, toR = Math.PI/180;
  const dLat = (b.lat-a.lat)*toR, dLon = (b.lon-a.lon)*toR;
  const s = Math.sin(dLat/2)**2 + Math.cos(a.lat*toR)*Math.cos(b.lat*toR)*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(s));
}
// nearest-neighbor from home over stops, then 2-opt; endpoints stay near home (round trip)
function optimize(home, stops){
  const pts = stops.map(s => s.pt);
  const n = pts.length;
  const unused = new Set(pts.map((_,i)=>i));
  const order = []; let cur = home;
  while (unused.size){
    let best = -1, bd = Infinity;
    for (const i of unused){ const d = haversine(cur, pts[i]); if (d < bd){ bd = d; best = i; } }
    order.push(best); unused.delete(best); cur = pts[best];
  }
  // 2-opt (treat as path home -> ... -> home)
  const dist = (i, j) => haversine(pts[i], pts[j]);
  const dHome = (i) => haversine(home, pts[i]);
  let improved = true;
  while (improved){
    improved = false;
    for (let i = 0; i < n-1; i++){
      for (let k = i+1; k < n; k++){
        const a = order[i-1] ?? -1, b = order[i], c = order[k], d = order[k+1] ?? -1;
        const before = (a<0?dHome(b):dist(a,b)) + (d<0?dHome(c):dist(c,d));
        const after  = (a<0?dHome(c):dist(a,c)) + (d<0?dHome(b):dist(b,d));
        if (after + 1e-9 < before){
          let lo = i, hi = k; while (lo < hi){ [order[lo],order[hi]]=[order[hi],order[lo]]; lo++; hi--; }
          improved = true;
        }
      }
    }
  }
  return order.map(i => stops[i]);
}

// ---------- google maps links (chunked into legs; Google caps ~10 points/link) ----------
function mapsLinks(homeAddr, ordered){
  const enc = s => encodeURIComponent(s);
  const stops = ordered.map(s => s.address);
  const mk = arr => 'https://www.google.com/maps/dir/' + arr.map(enc).join('/');
  if (stops.length <= 9) return [{ label:'Open full route in Google Maps', url: mk([homeAddr, ...stops, homeAddr]) }];
  const PER = 8;                     // new stops per leg (+1 handoff/home start ≤ 9 points)
  const links = []; let start = homeAddr;
  for (let i = 0; i < stops.length; i += PER){
    const chunk = stops.slice(i, i + PER);
    const last = i + PER >= stops.length;
    const pts = [start, ...chunk]; if (last) pts.push(homeAddr);
    const n = links.length + 1;
    links.push({
      label: `Leg ${n} · stops ${i+1}–${i+chunk.length}${last ? ' → Home' : ''}`,
      url: mk(pts), second: n % 2 === 0,
    });
    start = chunk[chunk.length-1];   // next leg resumes from this leg's final stop
  }
  return links;
}

// ---------- render ----------
function render(homeAddr, ordered, roadMiles){
  $('resultCard').classList.remove('hidden');
  const gals = roadMiles / store.mpg, cost = gals * store.gas;
  const vac = ordered.filter(s=>s.vacant).length;
  $('summary').innerHTML =
    `<span class="pill"><b>${ordered.length}</b> stops</span>` +
    `<span class="pill"><b>${roadMiles.toFixed(1)}</b> mi</span>` +
    `<span class="pill">~<b>${gals.toFixed(1)}</b> gal · $${cost.toFixed(2)}</span>` +
    (vac ? `<span class="pill">${vac} vacant</span>` : '');

  const links = mapsLinks(homeAddr, ordered);
  $('mapsLinks').innerHTML = links.map(l =>
    `<a class="${l.second?'second':''}" href="${l.url}" target="_blank" rel="noopener">${l.label}</a>`).join('');

  const rows = ordered.map((s,i)=>`<tr>
    <td>${i+1}</td><td>${s.stop}</td>
    <td class="addr ${s.vacant?'vacant':''}">${s.address}${s.vacant?' <span class="badge">vacant</span>':''}${s.approx?' <span class="badge approx">approx pin</span>':''}</td>
    <td>${s.zip}</td></tr>`).join('');
  $('stopsTable').innerHTML =
    `<tr><th>#</th><th>Sheet</th><th>Address</th><th>ZIP</th></tr>` + rows;
}

// ---------- pipeline ----------
async function run(stops){
  if (!stops.length){ status('No stops found in that file. Try pasting the list instead.', true); return; }
  const homeAddr = store.home.trim();
  if (!homeAddr){ pendingStops = stops; status(`Got ${stops.length} stops — now type your home address above and tap Save.`, true); $('settings').classList.remove('hidden'); $('homeAddr').focus(); $('settings').scrollIntoView({behavior:'smooth'}); return; }

  status(`Found ${stops.length} stops. Geocoding… (0/${stops.length})`);
  const home = await geocode(homeAddr);
  if (!home){ status('Could not locate your home address — check it in Settings.', true); return; }

  const located = [], noPin = [];
  let approxCount = 0;
  for (let i = 0; i < stops.length; i++){
    const cached = geoCache[stops[i].address.toLowerCase()];
    const pt = await geocode(stops[i].address, stops[i].zip);
    if (pt){ stops[i].pt = pt; stops[i].approx = !!pt.approx; if (pt.approx) approxCount++; located.push(stops[i]); }
    else noPin.push(stops[i]);           // couldn't place at all — keep it, append later
    status(`Locating stops… (${i+1}/${stops.length})`);
    if (!cached) await sleep(1100);      // respect rate limit only on fresh lookups
  }

  // Order the ones we could place; append any unplaceable at the end so they're never lost.
  const ordered = located.length ? optimize(home, located) : [];
  for (const s of noPin){ s.pt = null; s.approx = true; ordered.push(s); }

  // road-distance estimate = straight-line * 1.3 (skip legs to unplaced stops)
  let miles = 0, prev = home;
  for (const s of ordered){ if (s.pt){ miles += haversine(prev, s.pt); prev = s.pt; } }
  miles += haversine(prev, home);
  miles *= 1.3;

  const notes = [];
  if (approxCount) notes.push(`${approxCount} placed at ZIP level (nav link still uses the exact address)`);
  if (noPin.length) notes.push(`${noPin.length} couldn't be located at all — check those manually`);
  status(`Routed all ${stops.length} stops.` + (notes.length ? ' ' + notes.join('; ') + '.' : ' ✅'));
  render(homeAddr, ordered, miles);
  $('resultCard').scrollIntoView({ behavior:'smooth' });
}

// ---------- wire up UI ----------
$('pickBtn').onclick = () => $('file').click();
$('file').onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  status('Reading PDF…');
  try { run(await parsePdf(f)); }
  catch(err){ status('Could not read that PDF. Try pasting the list. (' + err.message + ')', true); }
};
$('parsePaste').onclick = () => {
  const txt = $('pasteBox').value;
  if (!txt.trim()){ status('Paste the stop list first.', true); return; }
  run(parseStops(txt.split(/\r?\n/)));
};

// handle files shared into the installed PWA (Android)
async function handleShared(){
  if (!('caches' in window)) return;
  try {
    const c = await caches.open('shared');
    const r = await c.match('shared-file');
    if (r){ const blob = await r.blob(); await c.delete('shared-file');
      status('Reading shared PDF…'); run(await parsePdf(new File([blob],'shared.pdf'))); }
  } catch(e){}
}

loadSettings();
if (new URLSearchParams(location.search).has('shared')) handleShared();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
