/* ==========================================================================
   SLICKTRACE AI — Interactive Satellite GIS & Vessel Attribution Script
   ========================================================================== */

let spill, candidates, tracks, selected;
let sortKey = 'final_score', asc = false, timer = null;
let replayIntervalMs = 700;

// Leaflet Map Objects
let map = null;
let currentBasemap = null;
let basemaps = {};
let layerGroups = {
  radius: null,
  spill: null,
  tracks: null,
  replay: null
};
let trackLayers = {}; // keyed by vessel_id
let vesselMarkers = {}; // keyed by vessel_id

const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const API_BASE_URL = window.SLICKTRACE_API_BASE || 'http://127.0.0.1:8000';
const apiUrl = path => `${API_BASE_URL}${path}`;

// --------------------------------------------------------------------------
// 1. Data Ingestion & State Synchronization from Backend
// --------------------------------------------------------------------------
let currentStage = 'VESSELS_RANKED';

function setNotice(message, isError = false) {
  const noticeEl = $('#wf-notice');
  if (!noticeEl) return;
  if (!message) {
    noticeEl.style.display = 'none';
    noticeEl.textContent = '';
    return;
  }
  noticeEl.style.display = 'flex';
  noticeEl.style.borderColor = isError ? '#fca5a5' : '#fde68a';
  noticeEl.style.backgroundColor = isError ? '#fef2f2' : '#fffbeb';
  noticeEl.style.color = isError ? '#991b1b' : '#92400e';
  noticeEl.innerHTML = (isError ? '⚠️ ' : 'ℹ️ ') + esc(message);
}

function updateWorkflowPills(stage) {
  currentStage = stage;
  const pills = [
    { id: '#wf-step-1', name: '1. SAR Ingest', passedStages: ['SAR_INGESTED', 'SLICK_DETECTED', 'AIS_CORRELATED', 'VESSELS_RANKED'], currentStage: 'SAR_INGESTED' },
    { id: '#wf-step-2', name: '2. Slick Mask', passedStages: ['SLICK_DETECTED', 'AIS_CORRELATED', 'VESSELS_RANKED'], currentStage: 'SLICK_DETECTED' },
    { id: '#wf-step-3', name: '3. AIS Intercept', passedStages: ['AIS_CORRELATED', 'VESSELS_RANKED'], currentStage: 'AIS_CORRELATED' },
    { id: '#wf-step-4', name: '4. Attribution Rank', passedStages: ['VESSELS_RANKED'], currentStage: 'VESSELS_RANKED' }
  ];

  pills.forEach((p) => {
    const el = $(p.id);
    if (!el) return;
    el.classList.remove('passed', 'current', 'running');

    if (stage === 'NOT_STARTED') {
      el.innerHTML = p.name;
    } else if (p.passedStages.includes(stage)) {
      if (stage === p.currentStage) {
        el.classList.add('current');
        el.innerHTML = `<span>★</span> ${p.name}`;
      } else {
        el.classList.add('passed');
        el.innerHTML = `<span>✓</span> ${p.name}`;
      }
    } else {
      el.innerHTML = p.name;
    }
  });

  const statusEl = $('#meta-investigation-status');
  if (statusEl) {
    if (stage === 'VESSELS_RANKED') {
      statusEl.textContent = 'ATTRIBUTION ACTIVE';
      statusEl.style.color = 'var(--cyan-bright)';
    } else if (stage === 'NOT_STARTED') {
      statusEl.textContent = 'INVESTIGATION PENDING';
      statusEl.style.color = 'var(--text-light-muted)';
    } else {
      statusEl.textContent = stage.replace(/_/g, ' ');
      statusEl.style.color = 'var(--risk-med)';
    }
  }
}

async function syncUIWithSession(data) {
  currentStage = data.stage;
  spill = data.spill;
  updateWorkflowPills(data.stage);

  if (data.stage === 'AIS_CORRELATED' || data.stage === 'VESSELS_RANKED') {
    const [cRes, tRes] = await Promise.all([
      fetch(apiUrl('/api/candidates')).then(r => r.json()),
      fetch(apiUrl('/api/tracks')).then(r => r.json())
    ]);
    candidates = cRes;
    tracks = tRes;
    if (!selected || !tracks[selected]) {
      selected = candidates[0] ? candidates[0].vessel_id : Object.keys(tracks)[0];
    }
  } else {
    candidates = [];
    tracks = {};
    selected = null;
  }

  // Update Status Bar
  if ($('#meta-case-id')) {
    $('#meta-case-id').textContent = data.case_id || 'SAR-2026-01339';
  }
  if ($('#meta-detect-status')) {
    if (data.stage === 'NOT_STARTED' || data.stage === 'SAR_INGESTED') {
      $('#meta-detect-status').textContent = 'NOT RUN';
      $('#meta-detect-status').className = 'status-chip';
    } else {
      $('#meta-detect-status').textContent = (spill.detector_status || 'NOT RUN').replace(/_/g, ' ').toUpperCase();
      $('#meta-detect-status').className = (spill.detector_status === 'suspected_slick_detected') ? 'status-chip danger' : 'status-chip';
    }
  }
  if ($('#meta-ais-count')) {
    if (data.stage === 'NOT_STARTED' || data.stage === 'SAR_INGESTED' || data.stage === 'SLICK_DETECTED') {
      $('#meta-ais-count').textContent = 'AWAITING INTERCEPT';
      $('#meta-ais-count').className = 'status-chip';
    } else {
      $('#meta-ais-count').textContent = `${candidates.length} VESSELS CORRELATED`;
      $('#meta-ais-count').className = 'status-chip cyan';
    }
  }

  // Update KPI Cards
  renderKPICards(spill, data.stage);
  renderDetectionEngine(spill);

  // Update Leaflet Map Layers
  if (map) {
    updateMapForStage(data.stage);
  }

  // Update Replay Vessel Selector
  const vesselSelect = $('#vessel');
  if (vesselSelect) {
    vesselSelect.innerHTML = candidates.map(x => `<option value="${x.vessel_id}">${esc(x.vessel_name)} (${x.vessel_id})</option>`).join('');
    if (selected) vesselSelect.value = selected;
  }
  if (selected && tracks[selected] && $('#time')) {
    $('#time').max = tracks[selected].length - 1;
    $('#time').value = 0;
  }

  // Render Table & Forensic Breakdown
  render();
}

function updateMapForStage(stage) {
  if (!map) return;
  if (layerGroups.radius) layerGroups.radius.clearLayers();
  if (layerGroups.spill) layerGroups.spill.clearLayers();
  if (layerGroups.tracks) layerGroups.tracks.clearLayers();
  if (layerGroups.replay) layerGroups.replay.clearLayers();

  if (stage === 'NOT_STARTED' || stage === 'SAR_INGESTED') {
    return;
  }

  // Step 2 Slick Mask: draw spill origin and polygon
  if (stage === 'SLICK_DETECTED' || stage === 'AIS_CORRELATED' || stage === 'VESSELS_RANKED') {
    if (spill) {
      if (spill.polygon && spill.polygon.length > 2) {
        L.polygon(spill.polygon, {
          color: '#dc2626',
          weight: 2,
          dashArray: '4, 4',
          fillColor: '#ef4444',
          fillOpacity: 0.25
        }).bindPopup(`<b>Estimated Slick Extent</b><br>Area: ${spill.area} ${spill.area_unit}<br>Confidence: ${Math.round(spill.confidence * 100)}%`).addTo(layerGroups.spill);
      }

      const spillIcon = L.divIcon({
        className: 'custom-spill-div-icon',
        html: '<div class="spill-origin-pulse"></div>',
        iconSize: [24, 24],
        iconAnchor: [12, 12]
      });

      L.marker([spill.latitude, spill.longitude], { icon: spillIcon })
        .bindPopup(`<b>🛢️ Estimated Spill Origin</b><br>Lat: ${spill.latitude.toFixed(4)}°, Lon: ${spill.longitude.toFixed(4)}°<br>Acquisition: ${spill.timestamp.replace('T', ' ').replace('Z', ' UTC')}`)
        .addTo(layerGroups.spill);
    }
  }

  // Step 3 & 4 AIS: draw search radius and tracks
  if (stage === 'AIS_CORRELATED' || stage === 'VESSELS_RANKED') {
    if (spill) {
      const searchRadiusMeters = 15000;
      L.circle([spill.latitude, spill.longitude], {
        radius: searchRadiusMeters,
        color: '#0284c7',
        weight: 1.5,
        dashArray: '6, 6',
        fillColor: '#38bdf8',
        fillOpacity: 0.08
      }).bindTooltip('15 km Investigation Perimeter', { direction: 'top' }).addTo(layerGroups.radius);
    }

    if (candidates && candidates.length && tracks) {
      drawVesselTracks(candidates, tracks);
      updateReplayPosition();
    }
  }
}

async function runWorkflowStep(stepNum) {
  setNotice('');
  if (stepNum === 2 && currentStage === 'NOT_STARTED') {
    setNotice('Prerequisite: Execute Step 1 (SAR Ingest) before Step 2.', true);
    return false;
  }
  if (stepNum === 3 && (currentStage === 'NOT_STARTED' || currentStage === 'SAR_INGESTED')) {
    setNotice('Prerequisite: Execute Step 2 (Slick Mask) before Step 3.', true);
    return false;
  }
  if (stepNum === 4 && (currentStage !== 'AIS_CORRELATED' && currentStage !== 'VESSELS_RANKED')) {
    setNotice('Prerequisite: Execute Step 3 (AIS Intercept) before Step 4.', true);
    return false;
  }

  const pillEl = $(`#wf-step-${stepNum}`);
  if (pillEl) pillEl.classList.add('running');

  try {
    const res = await fetch(apiUrl('/api/workflow/step'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ step: stepNum })
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      setNotice(data.error || `Step ${stepNum} failed`, true);
      if (pillEl) pillEl.classList.remove('running');
      return false;
    }

    await syncUIWithSession(data);
    return true;
  } catch (err) {
    setNotice(`Workflow request error: ${err.message}`, true);
    if (pillEl) pillEl.classList.remove('running');
    return false;
  }
}

async function runFullInvestigation() {
  setNotice('');
  const runBtn = $('#btn-run-workflow');
  if (runBtn) {
    runBtn.disabled = true;
    runBtn.innerHTML = '⏳ In Progress...';
  }

  try {
    const s1 = await runWorkflowStep(1);
    if (!s1) throw new Error('SAR Ingest stage failed');
    await new Promise(r => setTimeout(r, 450));

    const s2 = await runWorkflowStep(2);
    if (!s2) throw new Error('Slick Mask detection stage failed');
    await new Promise(r => setTimeout(r, 450));

    const s3 = await runWorkflowStep(3);
    if (!s3) throw new Error('AIS Intercept correlation stage failed');
    await new Promise(r => setTimeout(r, 450));

    const s4 = await runWorkflowStep(4);
    if (!s4) throw new Error('Attribution Rank stage failed');

    setNotice('Investigation completed: Top Candidate identified with explainable multi-factor attribution score.');
  } catch (err) {
    setNotice(`Investigation pipeline stopped: ${err.message}`, true);
  } finally {
    if (runBtn) {
      runBtn.disabled = false;
      runBtn.innerHTML = '⚡ Run Investigation';
    }
  }
}

async function resetInvestigation() {
  setNotice('');
  pauseReplay();
  try {
    const res = await fetch(apiUrl('/api/workflow/reset'), { method: 'POST' });
    const data = await res.json();
    await syncUIWithSession(data);
    setNotice('Investigation reset to initial state. Click "⚡ Run Investigation" or Step 1 to begin.');
  } catch (err) {
    setNotice(`Reset error: ${err.message}`, true);
  }
}

async function initInvestigation() {
  try {
    const [state, cand, trk] = await Promise.all([
      fetch(apiUrl('/api/state')).then(r => r.json()),
      fetch(apiUrl('/api/candidates')).then(r => r.json()),
      fetch(apiUrl('/api/tracks')).then(r => r.json())
    ]);

    spill = state.spill;
    candidates = cand;
    tracks = trk;
    currentStage = state.stage || 'VESSELS_RANKED';
    selected = candidates[0] ? candidates[0].vessel_id : Object.keys(tracks)[0];

    // Initialize Leaflet Map
    initLeafletMap(spill, candidates, tracks);

    // Setup Event Listeners
    initEventListeners();

    // Synchronize UI
    await syncUIWithSession(state);
  } catch (err) {
    console.error('Error initializing investigation:', err);
    setNotice(`Backend communication failure: Ensure backend is running at ${API_BASE_URL}`, true);
  }
}

// Start application
initInvestigation();

// --------------------------------------------------------------------------
// 2. KPI Cards Rendering
// --------------------------------------------------------------------------
function renderKPICards(s, stage = currentStage) {
  const infoContainer = $('#info');
  if (!infoContainer) return;

  const isIngested = stage && stage !== 'NOT_STARTED';
  const isDetected = stage && ['SLICK_DETECTED', 'AIS_CORRELATED', 'VESSELS_RANKED'].includes(stage);

  const kpis = [
    {
      title: 'Spill Location',
      val: isDetected ? `${s.latitude.toFixed(4)}° N, ${s.longitude.toFixed(4)}° E` : (isIngested ? '18.9524° N, 72.8837° E' : 'Pending Ingest'),
      sub: 'Geographic Origin Anchor (DEMO)',
      symbol: '🎯'
    },
    {
      title: 'Spill Area',
      val: isDetected ? `${s.area} ${s.area_unit}` : (isIngested ? 'Awaiting Mask' : 'Pending Ingest'),
      sub: isDetected ? 'Cleaned Spatial Mask Extent' : 'Detection Mask Extent',
      symbol: '📐'
    },
    {
      title: 'Detection Confidence',
      val: isDetected ? `${Math.round(s.confidence * 100)}%` : (isIngested ? 'Awaiting Mask' : 'Pending Ingest'),
      sub: 'SAR Multi-Feature Composite',
      symbol: '🛡️',
      hasBar: isDetected,
      pct: isDetected ? Math.round(s.confidence * 100) : 0
    },
    {
      title: 'Detection Time',
      val: isIngested ? s.timestamp.replace('T', ' ').replace('Z', ' UTC') : 'Pending Ingest',
      sub: 'Sentinel-1 SAR Acquisition',
      symbol: '⏱️'
    }
  ];

  infoContainer.innerHTML = kpis.map(item => `
    <div class="kpi-card-white">
      <div class="kpi-card-head">
        <span class="kpi-card-label">${item.title}</span>
        <span class="kpi-card-symbol">${item.symbol}</span>
      </div>
      <div class="kpi-card-number">${item.val}</div>
      <div class="kpi-card-footnote">${item.sub}</div>
      ${item.hasBar ? `<div class="kpi-confidence-track"><div class="kpi-confidence-fill" style="width: ${item.pct}%;"></div></div>` : ''}
    </div>
  `).join('');
}
// --------------------------------------------------------------------------
// 2B. Detection Engine Output
// --------------------------------------------------------------------------
function renderDetectionEngine(s) {
  const container = $('#detection-engine');
  if (!container) return;

  const confidence = s.detector_confidence != null
    ? Math.round(s.detector_confidence * 100)
    : null;

  const shape = s.shape_score != null
    ? Math.round(s.shape_score * 100)
    : null;

  const area = s.area_score != null
    ? Math.round(s.area_score * 100)
    : null;

  const fallback = s.fallback_used ? 'YES' : 'NO';

  container.innerHTML = `
    <div class="detection-metric">
      <span class="detection-metric-label">DETECTOR STATUS</span>
      <strong>${esc((s.detector_status || 'UNKNOWN').replace(/_/g, ' ').toUpperCase())}</strong>
    </div>

    <div class="detection-metric">
      <span class="detection-metric-label">PROTOTYPE CONFIDENCE</span>
      <strong>${confidence != null ? confidence + '%' : 'N/A'}</strong>
      <div class="detection-mini-track">
        <div style="width:${confidence != null ? confidence : 0}%"></div>
      </div>
    </div>

    <div class="detection-metric">
      <span class="detection-metric-label">DETECTED PIXELS</span>
      <strong>${Number(s.detected_pixels || 0).toLocaleString()}</strong>
    </div>

    <div class="detection-metric">
      <span class="detection-metric-label">SHAPE SCORE</span>
      <strong>${shape != null ? shape + '%' : 'N/A'}</strong>
    </div>

    <div class="detection-metric">
      <span class="detection-metric-label">AREA SCORE</span>
      <strong>${area != null ? area + '%' : 'N/A'}</strong>
    </div>

    <div class="detection-metric">
      <span class="detection-metric-label">SENSITIVITY</span>
      <strong>${s.detection_sensitivity != null ? s.detection_sensitivity.toFixed(2) : 'N/A'}</strong>
    </div>

    <div class="detection-metric">
      <span class="detection-metric-label">FALLBACK MASK</span>
      <strong>${fallback}</strong>
    </div>

    <div class="detection-metric">
      <span class="detection-metric-label">CENTROID</span>
      <strong>${s.centroid_pixel
        ? `[${s.centroid_pixel[0].toFixed(1)}, ${s.centroid_pixel[1].toFixed(1)}]`
        : 'N/A'}</strong>
      <small>Pixel coordinates</small>
    </div>
  `;
}

// --------------------------------------------------------------------------
// 3. Leaflet GIS Map Initialization
// --------------------------------------------------------------------------
function initLeafletMap(s, c, t) {
  if (typeof L === 'undefined') {
    console.error('Leaflet library is not loaded');
    return;
  }

  // Initialize Map Instance centered on investigation area
  map = L.map('gis-map-viewport', {
    center: [s.latitude, s.longitude],
    zoom: 11,
    minZoom: 2,
    maxZoom: 18,
    zoomControl: true,
    attributionControl: true
  });

  // Define Legitimate Basemap Providers
  basemaps = {
    light: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19
    }),
    sat: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      attribution: 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, GIS Community',
      maxZoom: 18
    })
  };

  // Add Default Basemap (Map)
  currentBasemap = basemaps.light.addTo(map);

  // Initialize Layer Groups
  layerGroups.radius = L.layerGroup().addTo(map);
  layerGroups.spill = L.layerGroup().addTo(map);
  layerGroups.tracks = L.layerGroup().addTo(map);
  layerGroups.replay = L.layerGroup().addTo(map);

  // Draw 15 km Search Radius Circle
  const searchRadiusMeters = 15000;
  L.circle([s.latitude, s.longitude], {
    radius: searchRadiusMeters,
    color: '#0284c7',
    weight: 1.5,
    dashArray: '6, 6',
    fillColor: '#38bdf8',
    fillOpacity: 0.08
  }).bindTooltip('15 km Investigation Perimeter', { direction: 'top' }).addTo(layerGroups.radius);

  // Draw Spill Polygon if available
  if (s.polygon && s.polygon.length > 2) {
    L.polygon(s.polygon, {
      color: '#dc2626',
      weight: 2,
      dashArray: '4, 4',
      fillColor: '#ef4444',
      fillOpacity: 0.25
    }).bindPopup(`<b>Estimated Slick Extent</b><br>Area: ${s.area} ${s.area_unit}<br>Confidence: ${Math.round(s.confidence * 100)}%`).addTo(layerGroups.spill);
  }

  // Draw Spill Origin Custom Marker
  const spillIcon = L.divIcon({
    className: 'custom-spill-div-icon',
    html: '<div class="spill-origin-pulse"></div>',
    iconSize: [24, 24],
    iconAnchor: [12, 12]
  });

  L.marker([s.latitude, s.longitude], { icon: spillIcon })
    .bindPopup(`<b>🛢️ Estimated Spill Origin</b><br>Lat: ${s.latitude.toFixed(4)}°, Lon: ${s.longitude.toFixed(4)}°<br>Acquisition: ${s.timestamp.replace('T', ' ').replace('Z', ' UTC')}`)
    .addTo(layerGroups.spill);

  // Draw Vessel Tracks on Map
  drawVesselTracks(c, t);

  // Draw Initial Replay Position
  updateReplayPosition();
}

// --------------------------------------------------------------------------
// 4. Vessel Tracks Drawing on Leaflet Map
// --------------------------------------------------------------------------
function drawVesselTracks(candidatesList, tracksDict) {
  if (!layerGroups.tracks) return;
  layerGroups.tracks.clearLayers();
  trackLayers = {};
  vesselMarkers = {};

  const showLabels = $('#layer-labels') ? $('#layer-labels').checked : true;

  candidatesList.forEach(c => {
    const p = tracksDict[c.vessel_id];
    if (!p || !p.length) return;

    const isSelected = (c.vessel_id === selected);
    const color = c.risk === 'HIGH' ? '#dc2626' : c.risk === 'MEDIUM' ? '#d97706' : '#16a34a';
    const latLngs = p.map(pt => [pt.latitude, pt.longitude]);

    // Polyline Track
    const polyline = L.polyline(latLngs, {
      color: color,
      weight: isSelected ? 4.5 : 2,
      opacity: isSelected ? 1.0 : 0.45,
      lineCap: 'round',
      lineJoin: 'round'
    });

    polyline.on('click', () => pick(c.vessel_id));
    polyline.addTo(layerGroups.tracks);
    trackLayers[c.vessel_id] = polyline;

    // Track Waypoint Dots for Selected Vessel
    if (isSelected) {
      p.forEach((pt, idx) => {
        const dot = L.circleMarker([pt.latitude, pt.longitude], {
          radius: 3.5,
          color: '#0284c7',
          fillColor: '#ffffff',
          fillOpacity: 1,
          weight: 1.5
        }).bindTooltip(`<b>${esc(c.vessel_name)}</b><br>Passage: ${pt.timestamp.replace('T', ' ').replace('Z', ' UTC')}<br>Speed: ${pt.speed.toFixed(1)} kn · Heading: ${pt.heading.toFixed(0)}°`);
        dot.addTo(layerGroups.tracks);
      });
    }

    // Endpoint Marker
    const last = p[p.length - 1];
    const marker = L.circleMarker([last.latitude, last.longitude], {
      radius: isSelected ? 6.5 : 4.5,
      color: '#061325',
      weight: 1.5,
      fillColor: color,
      fillOpacity: 1
    });

    if (showLabels || isSelected) {
      marker.bindTooltip(`<b>${esc(c.vessel_name)}</b> (${c.risk})`, {
        permanent: isSelected || showLabels,
        direction: 'top',
        className: `gis-tooltip-${c.risk.toLowerCase()}`
      });
    }

    marker.on('click', () => pick(c.vessel_id));
    marker.addTo(layerGroups.tracks);
    vesselMarkers[c.vessel_id] = marker;
  });
}

// --------------------------------------------------------------------------
// 5. Update Replay Position on Map
// --------------------------------------------------------------------------
function updateReplayPosition() {
  if (!layerGroups.replay || !tracks || !selected || !tracks[selected]) return;
  layerGroups.replay.clearLayers();

  const stepIdx = +$('#time').value;
  const p = tracks[selected][stepIdx] || tracks[selected][0];

  const replayIcon = L.divIcon({
    className: 'custom-replay-marker',
    html: '<div class="replay-marker-icon" style="width: 14px; height: 14px;"></div>',
    iconSize: [14, 14],
    iconAnchor: [7, 7]
  });

  const replayMarker = L.marker([p.latitude, p.longitude], { icon: replayIcon, zIndexOffset: 1000 })
    .bindTooltip(`<b>REPLAY: ${esc(p.vessel_name)}</b><br>${p.speed.toFixed(1)} kn · ${p.heading.toFixed(0)}°<br>${p.timestamp.replace('T', ' ').replace('Z', ' UTC')}`, {
      permanent: false,
      direction: 'right'
    })
    .addTo(layerGroups.replay);

  // Update Replay Telemetry Bar
  if ($('#stamp')) {
    $('#stamp').textContent = p.timestamp.replace('T', ' ').replace('Z', ' UTC');
  }
  if ($('#current-step')) {
    $('#current-step').textContent = stepIdx + 1;
  }
  if ($('#total-steps')) {
    $('#total-steps').textContent = tracks[selected].length;
  }
}

// --------------------------------------------------------------------------
// 6. Main UI Render (Table & Evidence Breakdown)
// --------------------------------------------------------------------------
function render() {
  const tbody = $('#rows');
  const evidenceContainer = $('#evidence');

  if (!candidates || !candidates.length) {
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 32px 16px; font-size: 13px;">Awaiting Attribution Rank. Click <b>"⚡ Run Investigation"</b> or Step 4 above.</td></tr>`;
    }
    if (evidenceContainer) {
      evidenceContainer.innerHTML = `<div style="text-align: center; color: var(--text-muted); padding: 40px 16px; font-size: 13px;">Forensic evidence decomposition will appear once Attribution Rank executes.</div>`;
    }
    return;
  }

  // Update Column Header Sort Indicators
  document.querySelectorAll('th[data-k]').forEach(th => {
    const arrow = th.querySelector('.sort-arrow');
    if (arrow) {
      arrow.textContent = (th.dataset.k === sortKey) ? (asc ? '▲' : '▼') : '';
    }
  });

  // Sort candidate list
  const ordered = [...candidates].sort((a, b) => {
    let v = a[sortKey], w = b[sortKey];
    return (v > w ? 1 : v < w ? -1 : 0) * (asc ? 1 : -1);
  });

  // Render Table Rows
  tbody.innerHTML = ordered.map(c => {
    const originalRank = c.rank || (candidates.indexOf(c) + 1);
    const isSelected = c.vessel_id === selected;
    const isTop = originalRank === 1;

    return `
      <tr class="${isSelected ? 'selected-vessel' : ''} ${isTop ? 'top-ranked' : ''}" onclick="pick('${c.vessel_id}')">
        <td><span class="rank-badge ${isTop ? 'gold' : ''}">#${originalRank}</span></td>
        <td>
          <span class="vessel-cell-title">${esc(c.vessel_name)}</span>
          <span class="vessel-cell-id">${c.vessel_id}</span>
        </td>
        <td><b style="color: ${c.risk === 'HIGH' ? 'var(--risk-high)' : c.risk === 'MEDIUM' ? 'var(--risk-med)' : 'var(--risk-low)'}; font-size: 13.5px;">${c.final_score}</b><span style="color: var(--text-muted); font-size: 10px;">/100</span></td>
        <td><span class="risk-tag ${c.risk}">${c.risk}</span></td>
        <td>${c.closest_distance_km.toFixed(1)} km</td>
        <td>${c.time_gap_minutes.toFixed(0)} min</td>
        <td>${c.track_alignment.toFixed(0)}%</td>
      </tr>
    `;
  }).join('');

  // Render Evidence & Score Decomposition Panel
  const c = candidates.find(x => x.vessel_id === selected) || candidates[0];
  const b = c.score_breakdown;
  const rankNum = c.rank || (candidates.indexOf(c) + 1);
  const isTopCandidate = (c.is_top_candidate || rankNum === 1);

  const distPts = (b.distance * 0.30).toFixed(1);
  const timePts = (b.time * 0.25).toFixed(1);
  const trackPts = (b.track_alignment * 0.20).toFixed(1);
  const speedPts = (b.speed * 0.10).toFixed(1);
  const aisPts = (b.ais_behavior * 0.15).toFixed(1);

  $('#evidence').innerHTML = `
    <div class="evidence-hero-box">
      <div class="vessel-hero-summary">
        ${isTopCandidate ? '<div class="top-candidate-badge">★ TOP CANDIDATE (INVESTIGATIVE PRIORITIZATION ONLY)</div>' : ''}
        <h3>${esc(c.vessel_name)} <span class="risk-tag ${c.risk}">${c.risk} RISK</span></h3>
        <div class="vessel-telemetry">Rank #${rankNum} · IMO: ${c.vessel_id} · Speed: ${c.speed.toFixed(1)} kn · Heading: ${c.heading.toFixed(0)}°</div>
      </div>
      <div class="score-hero-block">
        <div class="score-hero-digits">${c.final_score}<span class="score-hero-max">/100</span></div>
        <div class="score-hero-caption">Attribution Score</div>
      </div>
    </div>

    <div class="findings-box">
      <div class="findings-box-heading">📌 Key Attribution Findings</div>
      <ul class="findings-list">
        ${c.reasons.map(r => `
          <li class="finding-row">
            <span class="finding-bullet">▸</span>
            <span>${esc(r)}</span>
          </li>
        `).join('')}
      </ul>
      ${c.ais_flags && c.ais_flags.length ? `
        <div class="ais-tags-row">
          ${c.ais_flags.map(f => `<span class="ais-anomaly-tag">⚠️ ${esc(f)}</span>`).join('')}
        </div>
      ` : ''}
    </div>

    <div class="score-meters-box">
      <div class="meters-title">📊 Multi-Factor Score Decomposition</div>
      <div class="meter-list">
        
        <div class="meter-row">
          <div class="meter-meta">
            <span class="meter-name">Distance Proximity <span class="meter-weight-tag">(30% max)</span></span>
            <span class="meter-score-val">${distPts} / 30.0</span>
          </div>
          <div class="meter-base-bar">
            <div class="meter-bar-progress" style="width: ${(distPts / 30.0 * 100).toFixed(1)}%;"></div>
          </div>
        </div>

        <div class="meter-row">
          <div class="meter-meta">
            <span class="meter-name">Temporal Proximity <span class="meter-weight-tag">(25% max)</span></span>
            <span class="meter-score-val">${timePts} / 25.0</span>
          </div>
          <div class="meter-base-bar">
            <div class="meter-bar-progress" style="width: ${(timePts / 25.0 * 100).toFixed(1)}%;"></div>
          </div>
        </div>

        <div class="meter-row">
          <div class="meter-meta">
            <span class="meter-name">Track Alignment <span class="meter-weight-tag">(20% max)</span></span>
            <span class="meter-score-val">${trackPts} / 20.0</span>
          </div>
          <div class="meter-base-bar">
            <div class="meter-bar-progress" style="width: ${(trackPts / 20.0 * 100).toFixed(1)}%;"></div>
          </div>
        </div>

        <div class="meter-row">
          <div class="meter-meta">
            <span class="meter-name">Speed Consistency <span class="meter-weight-tag">(10% max)</span></span>
            <span class="meter-score-val">${speedPts} / 10.0</span>
          </div>
          <div class="meter-base-bar">
            <div class="meter-bar-progress" style="width: ${(speedPts / 10.0 * 100).toFixed(1)}%;"></div>
          </div>
        </div>

        <div class="meter-row">
          <div class="meter-meta">
            <span class="meter-name">AIS Behavioral Anomaly <span class="meter-weight-tag">(15% max)</span></span>
            <span class="meter-score-val">${aisPts} / 15.0</span>
          </div>
          <div class="meter-base-bar">
            <div class="meter-bar-progress anomaly-bar" style="width: ${(aisPts / 15.0 * 100).toFixed(1)}%;"></div>
          </div>
        </div>

      </div>
    </div>
  `;

  // Synchronize Map Tracks Highlighting
  if (map && layerGroups.tracks) {
    drawVesselTracks(candidates, tracks);
    updateReplayPosition();
  }
}

// --------------------------------------------------------------------------
// 7. Vessel Selection Function (pick)
// --------------------------------------------------------------------------
function pick(id) {
  if (!tracks[id]) return;
  selected = id;

  if ($('#vessel')) {
    $('#vessel').value = id;
  }
  if ($('#time')) {
    $('#time').max = tracks[id].length - 1;
    $('#time').value = 0;
  }

  pauseReplay();
  render();
}
window.pick = pick;

// Keep the upload control available while preserving the AIS workflow handlers.
const sarUploadButton = $('#btn-upload-detect');
if (sarUploadButton) {
  sarUploadButton.onclick = uploadSARImage;
}

// --------------------------------------------------------------------------
// 8. Event Listeners Initialization
// --------------------------------------------------------------------------
function initEventListeners() {
  // Workflow Control Actions
  if ($('#btn-run-workflow')) {
    $('#btn-run-workflow').onclick = () => runFullInvestigation();
  }

  if ($('#btn-reset-workflow')) {
    $('#btn-reset-workflow').onclick = () => resetInvestigation();
  }

  // Workflow Step Pills
  for (let i = 1; i <= 4; i++) {
    const pill = $(`#wf-step-${i}`);
    if (pill) {
      pill.onclick = () => runWorkflowStep(i);
    }
  }

  // Table Sorting Handlers
  document.querySelectorAll('th[data-k]').forEach(th => {
    th.onclick = () => {
      asc = (sortKey === th.dataset.k) ? !asc : false;
      sortKey = th.dataset.k;
      render();
    };
  });

  // Basemap Switcher Buttons
  const basemapButtons = document.querySelectorAll('.btn-basemap');
  basemapButtons.forEach(btn => {
    btn.onclick = () => {
      basemapButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const bmType = btn.dataset.bm;

      if (map && basemaps[bmType]) {
        if (currentBasemap) {
          map.removeLayer(currentBasemap);
        }
        currentBasemap = basemaps[bmType].addTo(map);
      }
    };
  });

  // Layer Toggles
  if ($('#layer-radius')) {
    $('#layer-radius').onchange = e => {
      if (layerGroups.radius) {
        if (e.target.checked) map.addLayer(layerGroups.radius);
        else map.removeLayer(layerGroups.radius);
      }
    };
  }

  if ($('#layer-spill')) {
    $('#layer-spill').onchange = e => {
      if (layerGroups.spill) {
        if (e.target.checked) map.addLayer(layerGroups.spill);
        else map.removeLayer(layerGroups.spill);
      }
    };
  }

  if ($('#layer-tracks')) {
    $('#layer-tracks').onchange = e => {
      if (layerGroups.tracks) {
        if (e.target.checked) map.addLayer(layerGroups.tracks);
        else map.removeLayer(layerGroups.tracks);
      }
    };
  }

  if ($('#layer-labels')) {
    $('#layer-labels').onchange = () => {
      drawVesselTracks(candidates, tracks);
    };
  }

  // Focus & Overview Action Buttons
  if ($('#btn-focus-spill')) {
    $('#btn-focus-spill').onclick = () => {
      if (map && spill) {
        map.flyTo([spill.latitude, spill.longitude], 12, { duration: 1.2 });
      }
    };
  }

  if ($('#btn-world-view')) {
    $('#btn-world-view').onclick = () => {
      if (map) {
        map.flyTo([20, 40], 2.5, { duration: 1.5 });
      }
    };
  }

  // AIS Replay Controls
  if ($('#vessel')) {
    $('#vessel').onchange = e => pick(e.target.value);
  }

  if ($('#time')) {
    $('#time').oninput = () => updateReplayPosition();
  }

  if ($('#btn-step-prev')) {
    $('#btn-step-prev').onclick = () => {
      pauseReplay();
      let i = +$('#time').value;
      if (i > 0) {
        $('#time').value = i - 1;
        updateReplayPosition();
      }
    };
  }

  if ($('#btn-step-next')) {
    $('#btn-step-next').onclick = () => {
      pauseReplay();
      let i = +$('#time').value;
      let max = +$('#time').max;
      if (i < max) {
        $('#time').value = i + 1;
        updateReplayPosition();
      }
    };
  }

  if ($('#play')) {
    $('#play').onclick = () => {
      if (timer) {
        pauseReplay();
      } else {
        if (+$('#time').value >= +$('#time').max) {
          $('#time').value = 0;
        }
        startReplay();
      }
    };
  }

  // Speed Buttons
  const speedBtns = document.querySelectorAll('.btn-speed');
  speedBtns.forEach(btn => {
    btn.onclick = () => {
      speedBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      replayIntervalMs = parseInt(btn.dataset.speed, 10);
      if (timer) {
        startReplay();
      }
    };
  });
}

// --------------------------------------------------------------------------
// 9. AIS Replay Playback Timer
// --------------------------------------------------------------------------
function startReplay() {
  clearInterval(timer);
  const playBtn = $('#play');
  if (playBtn) {
    playBtn.textContent = '⏸ Pause';
    playBtn.classList.add('active');
  }

  timer = setInterval(() => {
    let i = +$('#time').value;
    let max = +$('#time').max;
    if (i >= max) {
      pauseReplay();
    } else {
      $('#time').value = i + 1;
      updateReplayPosition();
    }
  }, replayIntervalMs);
}

function pauseReplay() {
  clearInterval(timer);
  timer = null;
  const playBtn = $('#play');
  if (playBtn) {
    playBtn.textContent = '▶ Play';
    playBtn.classList.remove('active');
  }
}

async function uploadSARImage() {
  const input = $('#sar-upload-input');
  const button = $('#btn-upload-detect');
  const box = $('#upload-result');
  if (!input || !box) return;
  const file = input.files && input.files[0];
  if (!file) { setNotice('Choose a .tif/.tiff file before running detection.', true); return; }
  if (!/\.tiff?$/i.test(file.name)) { setNotice('Unsupported file type. Please upload a .tif or .tiff image.', true); return; }
  const formData = new FormData();
  formData.append('file', file);
  if (button) { button.disabled = true; button.textContent = 'Processing...'; }
  try {
    const res = await fetch(apiUrl('/api/detect-image'), { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || 'Detection request failed.');
    renderUploadResult(data);
    spill = Object.assign({}, spill || {}, { detector_status: data.detector_status, confidence: data.confidence, detector_confidence: data.confidence, detected_pixels: data.mask_pixels, area: data.spill_area, area_unit: data.spill_area.includes('km²') ? 'km²' : 'pixels' });
    renderDetectionEngine(spill);
    setNotice('Uploaded ' + file.name + ': ' + data.detector_status.replace(/_/g, ' ') + '. ' + (data.spill_area ? 'Area: ' + data.spill_area : ''));
  } catch (err) {
    renderUploadResult({ error: err.message });
    setNotice(err.message, true);
  } finally {
    if (button) { button.disabled = false; button.textContent = 'Run Detector'; }
  }
}

function renderUploadResult(result) {
  const container = $('#upload-result');
  if (!container) return;

  if (result.error) {
    container.innerHTML = `<div class="upload-error">${esc(result.error)}</div>`;
    return;
  }

  const status = (result.detector_status || 'UNKNOWN').replace(/_/g, ' ').toUpperCase();
  const areaText = result.spill_area ? `${result.spill_area}` : 'N/A';
  const confidenceText = result.confidence != null ? `${Math.round(result.confidence * 100)}%` : 'N/A';

  container.innerHTML = `
    <div class="upload-preview-grid">
      <div class="upload-preview-card">
        <div class="upload-preview-header">Original Uploaded Image</div>
        <img src="${result.original_image || ''}" alt="Original SAR upload" />
      </div>
      <div class="upload-preview-card">
        <div class="upload-preview-header">Detected Oil-Spill Mask</div>
        <img src="${result.mask_image || ''}" alt="Detected oil spill mask" />
      </div>
    </div>
    <div class="upload-metadata">
      <div><span>Status</span><strong>${esc(status)}</strong></div>
      <div><span>Spill Area</span><strong>${esc(areaText)}</strong></div>
      <div><span>Contrast Score</span><strong>${result.contrast_score != null ? Number(result.contrast_score).toFixed(3) : 'N/A'}</strong></div>
      <div><span>Confidence</span><strong>${esc(confidenceText)}</strong></div>
      <div><span>Mask Pixels</span><strong>${Number(result.mask_pixels || 0).toLocaleString()}</strong></div>
    </div>
  `;
}

async function initInvestigation() {
  try {
    const [state, cand, trk] = await Promise.all([
      fetch(apiUrl('/api/state')).then(r => r.json()),
      fetch(apiUrl('/api/candidates')).then(r => r.json()),
      fetch(apiUrl('/api/tracks')).then(r => r.json())
    ]);

    spill = state.spill;
    candidates = cand;
    tracks = trk;
    currentStage = state.stage || 'VESSELS_RANKED';
    selected = candidates[0] ? candidates[0].vessel_id : Object.keys(tracks)[0];

    // Initialize Leaflet Map
    initLeafletMap(spill, candidates, tracks);

    // Setup Event Listeners
    initEventListeners();

    // Synchronize UI
    await syncUIWithSession(state);
  } catch (err) {
    console.error('Error initializing investigation:', err);
    setNotice(`Backend communication failure: Ensure backend is running at ${API_BASE_URL}`, true);
  }
}

// Start application
initInvestigation();

// --------------------------------------------------------------------------
// 2. KPI Cards Rendering
// --------------------------------------------------------------------------
function renderKPICards(s, stage = currentStage) {
  const infoContainer = $('#info');
  if (!infoContainer) return;

  const isIngested = stage && stage !== 'NOT_STARTED';
  const isDetected = stage && ['SLICK_DETECTED', 'AIS_CORRELATED', 'VESSELS_RANKED'].includes(stage);

  const kpis = [
    {
      title: 'Spill Location',
      val: isDetected ? `${s.latitude.toFixed(4)}° N, ${s.longitude.toFixed(4)}° E` : (isIngested ? '18.9524° N, 72.8837° E' : 'Pending Ingest'),
      sub: 'Geographic Origin Anchor (DEMO)',
      symbol: '🎯'
    },
    {
      title: 'Spill Area',
      val: isDetected ? `${s.area} ${s.area_unit}` : (isIngested ? 'Awaiting Mask' : 'Pending Ingest'),
      sub: isDetected ? 'Cleaned Spatial Mask Extent' : 'Detection Mask Extent',
      symbol: '📐'
    },
    {
      title: 'Detection Confidence',
      val: isDetected ? `${Math.round(s.confidence * 100)}%` : (isIngested ? 'Awaiting Mask' : 'Pending Ingest'),
      sub: 'SAR Multi-Feature Composite',
      symbol: '🛡️',
      hasBar: isDetected,
      pct: isDetected ? Math.round(s.confidence * 100) : 0
    },
    {
      title: 'Detection Time',
      val: isIngested ? s.timestamp.replace('T', ' ').replace('Z', ' UTC') : 'Pending Ingest',
      sub: 'Sentinel-1 SAR Acquisition',
      symbol: '⏱️'
    }
  ];

  infoContainer.innerHTML = kpis.map(item => `
    <div class="kpi-card-white">
      <div class="kpi-card-head">
        <span class="kpi-card-label">${item.title}</span>
        <span class="kpi-card-symbol">${item.symbol}</span>
      </div>
      <div class="kpi-card-number">${item.val}</div>
      <div class="kpi-card-footnote">${item.sub}</div>
      ${item.hasBar ? `<div class="kpi-confidence-track"><div class="kpi-confidence-fill" style="width: ${item.pct}%;"></div></div>` : ''}
    </div>
  `).join('');
}
// --------------------------------------------------------------------------
// 2B. Detection Engine Output
// --------------------------------------------------------------------------
function renderDetectionEngine(s) {
  const container = $('#detection-engine');
  if (!container) return;

  const confidence = s.detector_confidence != null
    ? Math.round(s.detector_confidence * 100)
    : null;

  const shape = s.shape_score != null
    ? Math.round(s.shape_score * 100)
    : null;

  const area = s.area_score != null
    ? Math.round(s.area_score * 100)
    : null;

  const fallback = s.fallback_used ? 'YES' : 'NO';

  container.innerHTML = `
    <div class="detection-metric">
      <span class="detection-metric-label">DETECTOR STATUS</span>
      <strong>${esc((s.detector_status || 'UNKNOWN').replace(/_/g, ' ').toUpperCase())}</strong>
    </div>

    <div class="detection-metric">
      <span class="detection-metric-label">PROTOTYPE CONFIDENCE</span>
      <strong>${confidence != null ? confidence + '%' : 'N/A'}</strong>
      <div class="detection-mini-track">
        <div style="width:${confidence != null ? confidence : 0}%"></div>
      </div>
    </div>

    <div class="detection-metric">
      <span class="detection-metric-label">DETECTED PIXELS</span>
      <strong>${Number(s.detected_pixels || 0).toLocaleString()}</strong>
    </div>

    <div class="detection-metric">
      <span class="detection-metric-label">SHAPE SCORE</span>
      <strong>${shape != null ? shape + '%' : 'N/A'}</strong>
    </div>

    <div class="detection-metric">
      <span class="detection-metric-label">AREA SCORE</span>
      <strong>${area != null ? area + '%' : 'N/A'}</strong>
    </div>

    <div class="detection-metric">
      <span class="detection-metric-label">SENSITIVITY</span>
      <strong>${s.detection_sensitivity != null ? s.detection_sensitivity.toFixed(2) : 'N/A'}</strong>
    </div>

    <div class="detection-metric">
      <span class="detection-metric-label">FALLBACK MASK</span>
      <strong>${fallback}</strong>
    </div>

    <div class="detection-metric">
      <span class="detection-metric-label">CENTROID</span>
      <strong>${s.centroid_pixel
        ? `[${s.centroid_pixel[0].toFixed(1)}, ${s.centroid_pixel[1].toFixed(1)}]`
        : 'N/A'}</strong>
      <small>Pixel coordinates</small>
    </div>
  `;
}

// --------------------------------------------------------------------------
// 3. Leaflet GIS Map Initialization
// --------------------------------------------------------------------------
function initLeafletMap(s, c, t) {
  if (typeof L === 'undefined') {
    console.error('Leaflet library is not loaded');
    return;
  }

  // Initialize Map Instance centered on investigation area
  map = L.map('gis-map-viewport', {
    center: [s.latitude, s.longitude],
    zoom: 11,
    minZoom: 2,
    maxZoom: 18,
    zoomControl: true,
    attributionControl: true
  });

  // Define Legitimate Basemap Providers
  basemaps = {
    light: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19
    }),
    sat: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      attribution: 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, GIS Community',
      maxZoom: 18
    })
  };

  // Add Default Basemap (Map)
  currentBasemap = basemaps.light.addTo(map);

  // Initialize Layer Groups
  layerGroups.radius = L.layerGroup().addTo(map);
  layerGroups.spill = L.layerGroup().addTo(map);
  layerGroups.tracks = L.layerGroup().addTo(map);
  layerGroups.replay = L.layerGroup().addTo(map);

  // Draw 15 km Search Radius Circle
  const searchRadiusMeters = 15000;
  L.circle([s.latitude, s.longitude], {
    radius: searchRadiusMeters,
    color: '#0284c7',
    weight: 1.5,
    dashArray: '6, 6',
    fillColor: '#38bdf8',
    fillOpacity: 0.08
  }).bindTooltip('15 km Investigation Perimeter', { direction: 'top' }).addTo(layerGroups.radius);

  // Draw Spill Polygon if available
  if (s.polygon && s.polygon.length > 2) {
    L.polygon(s.polygon, {
      color: '#dc2626',
      weight: 2,
      dashArray: '4, 4',
      fillColor: '#ef4444',
      fillOpacity: 0.25
    }).bindPopup(`<b>Estimated Slick Extent</b><br>Area: ${s.area} ${s.area_unit}<br>Confidence: ${Math.round(s.confidence * 100)}%`).addTo(layerGroups.spill);
  }

  // Draw Spill Origin Custom Marker
  const spillIcon = L.divIcon({
    className: 'custom-spill-div-icon',
    html: '<div class="spill-origin-pulse"></div>',
    iconSize: [24, 24],
    iconAnchor: [12, 12]
  });

  L.marker([s.latitude, s.longitude], { icon: spillIcon })
    .bindPopup(`<b>🛢️ Estimated Spill Origin</b><br>Lat: ${s.latitude.toFixed(4)}°, Lon: ${s.longitude.toFixed(4)}°<br>Acquisition: ${s.timestamp.replace('T', ' ').replace('Z', ' UTC')}`)
    .addTo(layerGroups.spill);

  // Draw Vessel Tracks on Map
  drawVesselTracks(c, t);

  // Draw Initial Replay Position
  updateReplayPosition();
}

// --------------------------------------------------------------------------
// 4. Vessel Tracks Drawing on Leaflet Map
// --------------------------------------------------------------------------
function drawVesselTracks(candidatesList, tracksDict) {
  if (!layerGroups.tracks) return;
  layerGroups.tracks.clearLayers();
  trackLayers = {};
  vesselMarkers = {};

  const showLabels = $('#layer-labels') ? $('#layer-labels').checked : true;

  candidatesList.forEach(c => {
    const p = tracksDict[c.vessel_id];
    if (!p || !p.length) return;

    const isSelected = (c.vessel_id === selected);
    const color = c.risk === 'HIGH' ? '#dc2626' : c.risk === 'MEDIUM' ? '#d97706' : '#16a34a';
    const latLngs = p.map(pt => [pt.latitude, pt.longitude]);

    // Polyline Track
    const polyline = L.polyline(latLngs, {
      color: color,
      weight: isSelected ? 4.5 : 2,
      opacity: isSelected ? 1.0 : 0.45,
      lineCap: 'round',
      lineJoin: 'round'
    });

    polyline.on('click', () => pick(c.vessel_id));
    polyline.addTo(layerGroups.tracks);
    trackLayers[c.vessel_id] = polyline;

    // Track Waypoint Dots for Selected Vessel
    if (isSelected) {
      p.forEach((pt, idx) => {
        const dot = L.circleMarker([pt.latitude, pt.longitude], {
          radius: 3.5,
          color: '#0284c7',
          fillColor: '#ffffff',
          fillOpacity: 1,
          weight: 1.5
        }).bindTooltip(`<b>${esc(c.vessel_name)}</b><br>Passage: ${pt.timestamp.replace('T', ' ').replace('Z', ' UTC')}<br>Speed: ${pt.speed.toFixed(1)} kn · Heading: ${pt.heading.toFixed(0)}°`);
        dot.addTo(layerGroups.tracks);
      });
    }

    // Endpoint Marker
    const last = p[p.length - 1];
    const marker = L.circleMarker([last.latitude, last.longitude], {
      radius: isSelected ? 6.5 : 4.5,
      color: '#061325',
      weight: 1.5,
      fillColor: color,
      fillOpacity: 1
    });

    if (showLabels || isSelected) {
      marker.bindTooltip(`<b>${esc(c.vessel_name)}</b> (${c.risk})`, {
        permanent: isSelected || showLabels,
        direction: 'top',
        className: `gis-tooltip-${c.risk.toLowerCase()}`
      });
    }

    marker.on('click', () => pick(c.vessel_id));
    marker.addTo(layerGroups.tracks);
    vesselMarkers[c.vessel_id] = marker;
  });
}

// --------------------------------------------------------------------------
// 5. Update Replay Position on Map
// --------------------------------------------------------------------------
function updateReplayPosition() {
  if (!layerGroups.replay || !tracks || !selected || !tracks[selected]) return;
  layerGroups.replay.clearLayers();

  const stepIdx = +$('#time').value;
  const p = tracks[selected][stepIdx] || tracks[selected][0];

  const replayIcon = L.divIcon({
    className: 'custom-replay-marker',
    html: '<div class="replay-marker-icon" style="width: 14px; height: 14px;"></div>',
    iconSize: [14, 14],
    iconAnchor: [7, 7]
  });

  const replayMarker = L.marker([p.latitude, p.longitude], { icon: replayIcon, zIndexOffset: 1000 })
    .bindTooltip(`<b>REPLAY: ${esc(p.vessel_name)}</b><br>${p.speed.toFixed(1)} kn · ${p.heading.toFixed(0)}°<br>${p.timestamp.replace('T', ' ').replace('Z', ' UTC')}`, {
      permanent: false,
      direction: 'right'
    })
    .addTo(layerGroups.replay);

  // Update Replay Telemetry Bar
  if ($('#stamp')) {
    $('#stamp').textContent = p.timestamp.replace('T', ' ').replace('Z', ' UTC');
  }
  if ($('#current-step')) {
    $('#current-step').textContent = stepIdx + 1;
  }
  if ($('#total-steps')) {
    $('#total-steps').textContent = tracks[selected].length;
  }
}

// --------------------------------------------------------------------------
// 6. Main UI Render (Table & Evidence Breakdown)
// --------------------------------------------------------------------------
function render() {
  const tbody = $('#rows');
  const evidenceContainer = $('#evidence');

  if (!candidates || !candidates.length) {
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 32px 16px; font-size: 13px;">Awaiting Attribution Rank. Click <b>"⚡ Run Investigation"</b> or Step 4 above.</td></tr>`;
    }
    if (evidenceContainer) {
      evidenceContainer.innerHTML = `<div style="text-align: center; color: var(--text-muted); padding: 40px 16px; font-size: 13px;">Forensic evidence decomposition will appear once Attribution Rank executes.</div>`;
    }
    return;
  }

  // Update Column Header Sort Indicators
  document.querySelectorAll('th[data-k]').forEach(th => {
    const arrow = th.querySelector('.sort-arrow');
    if (arrow) {
      arrow.textContent = (th.dataset.k === sortKey) ? (asc ? '▲' : '▼') : '';
    }
  });

  // Sort candidate list
  const ordered = [...candidates].sort((a, b) => {
    let v = a[sortKey], w = b[sortKey];
    return (v > w ? 1 : v < w ? -1 : 0) * (asc ? 1 : -1);
  });

  // Render Table Rows
  tbody.innerHTML = ordered.map(c => {
    const originalRank = c.rank || (candidates.indexOf(c) + 1);
    const isSelected = c.vessel_id === selected;
    const isTop = originalRank === 1;

    return `
      <tr class="${isSelected ? 'selected-vessel' : ''} ${isTop ? 'top-ranked' : ''}" onclick="pick('${c.vessel_id}')">
        <td><span class="rank-badge ${isTop ? 'gold' : ''}">#${originalRank}</span></td>
        <td>
          <span class="vessel-cell-title">${esc(c.vessel_name)}</span>
          <span class="vessel-cell-id">${c.vessel_id}</span>
        </td>
        <td><b style="color: ${c.risk === 'HIGH' ? 'var(--risk-high)' : c.risk === 'MEDIUM' ? 'var(--risk-med)' : 'var(--risk-low)'}; font-size: 13.5px;">${c.final_score}</b><span style="color: var(--text-muted); font-size: 10px;">/100</span></td>
        <td><span class="risk-tag ${c.risk}">${c.risk}</span></td>
        <td>${c.closest_distance_km.toFixed(1)} km</td>
        <td>${c.time_gap_minutes.toFixed(0)} min</td>
        <td>${c.track_alignment.toFixed(0)}%</td>
      </tr>
    `;
  }).join('');

  // Render Evidence & Score Decomposition Panel
  const c = candidates.find(x => x.vessel_id === selected) || candidates[0];
  const b = c.score_breakdown;
  const rankNum = c.rank || (candidates.indexOf(c) + 1);
  const isTopCandidate = (c.is_top_candidate || rankNum === 1);

  const distPts = (b.distance * 0.30).toFixed(1);
  const timePts = (b.time * 0.25).toFixed(1);
  const trackPts = (b.track_alignment * 0.20).toFixed(1);
  const speedPts = (b.speed * 0.10).toFixed(1);
  const aisPts = (b.ais_behavior * 0.15).toFixed(1);

  $('#evidence').innerHTML = `
    <div class="evidence-hero-box">
      <div class="vessel-hero-summary">
        ${isTopCandidate ? '<div class="top-candidate-badge">★ TOP CANDIDATE (INVESTIGATIVE PRIORITIZATION ONLY)</div>' : ''}
        <h3>${esc(c.vessel_name)} <span class="risk-tag ${c.risk}">${c.risk} RISK</span></h3>
        <div class="vessel-telemetry">Rank #${rankNum} · IMO: ${c.vessel_id} · Speed: ${c.speed.toFixed(1)} kn · Heading: ${c.heading.toFixed(0)}°</div>
      </div>
      <div class="score-hero-block">
        <div class="score-hero-digits">${c.final_score}<span class="score-hero-max">/100</span></div>
        <div class="score-hero-caption">Attribution Score</div>
      </div>
    </div>

    <div class="findings-box">
      <div class="findings-box-heading">📌 Key Attribution Findings</div>
      <ul class="findings-list">
        ${c.reasons.map(r => `
          <li class="finding-row">
            <span class="finding-bullet">▸</span>
            <span>${esc(r)}</span>
          </li>
        `).join('')}
      </ul>
      ${c.ais_flags && c.ais_flags.length ? `
        <div class="ais-tags-row">
          ${c.ais_flags.map(f => `<span class="ais-anomaly-tag">⚠️ ${esc(f)}</span>`).join('')}
        </div>
      ` : ''}
    </div>

    <div class="score-meters-box">
      <div class="meters-title">📊 Multi-Factor Score Decomposition</div>
      <div class="meter-list">
        
        <div class="meter-row">
          <div class="meter-meta">
            <span class="meter-name">Distance Proximity <span class="meter-weight-tag">(30% max)</span></span>
            <span class="meter-score-val">${distPts} / 30.0</span>
          </div>
          <div class="meter-base-bar">
            <div class="meter-bar-progress" style="width: ${(distPts / 30.0 * 100).toFixed(1)}%;"></div>
          </div>
        </div>

        <div class="meter-row">
          <div class="meter-meta">
            <span class="meter-name">Temporal Proximity <span class="meter-weight-tag">(25% max)</span></span>
            <span class="meter-score-val">${timePts} / 25.0</span>
          </div>
          <div class="meter-base-bar">
            <div class="meter-bar-progress" style="width: ${(timePts / 25.0 * 100).toFixed(1)}%;"></div>
          </div>
        </div>

        <div class="meter-row">
          <div class="meter-meta">
            <span class="meter-name">Track Alignment <span class="meter-weight-tag">(20% max)</span></span>
            <span class="meter-score-val">${trackPts} / 20.0</span>
          </div>
          <div class="meter-base-bar">
            <div class="meter-bar-progress" style="width: ${(trackPts / 20.0 * 100).toFixed(1)}%;"></div>
          </div>
        </div>

        <div class="meter-row">
          <div class="meter-meta">
            <span class="meter-name">Speed Consistency <span class="meter-weight-tag">(10% max)</span></span>
            <span class="meter-score-val">${speedPts} / 10.0</span>
          </div>
          <div class="meter-base-bar">
            <div class="meter-bar-progress" style="width: ${(speedPts / 10.0 * 100).toFixed(1)}%;"></div>
          </div>
        </div>

        <div class="meter-row">
          <div class="meter-meta">
            <span class="meter-name">AIS Behavioral Anomaly <span class="meter-weight-tag">(15% max)</span></span>
            <span class="meter-score-val">${aisPts} / 15.0</span>
          </div>
          <div class="meter-base-bar">
            <div class="meter-bar-progress anomaly-bar" style="width: ${(aisPts / 15.0 * 100).toFixed(1)}%;"></div>
          </div>
        </div>

      </div>
    </div>
  `;

  // Synchronize Map Tracks Highlighting
  if (map && layerGroups.tracks) {
    drawVesselTracks(candidates, tracks);
    updateReplayPosition();
  }
}

// --------------------------------------------------------------------------
// 7. Vessel Selection Function (pick)
// --------------------------------------------------------------------------
function pick(id) {
  if (!tracks[id]) return;
  selected = id;

  if ($('#vessel')) {
    $('#vessel').value = id;
  }
  if ($('#time')) {
    $('#time').max = tracks[id].length - 1;
    $('#time').value = 0;
  }

  pauseReplay();
  render();
}
window.pick = pick;

// --------------------------------------------------------------------------
// 8. Event Listeners Initialization
// --------------------------------------------------------------------------
function initEventListeners() {
  // Workflow Control Actions
  if ($('#btn-run-workflow')) {
    $('#btn-run-workflow').onclick = () => runFullInvestigation();
  }

  if ($('#btn-reset-workflow')) {
    $('#btn-reset-workflow').onclick = () => resetInvestigation();
  }

  // Workflow Step Pills
  for (let i = 1; i <= 4; i++) {
    const pill = $(`#wf-step-${i}`);
    if (pill) {
      pill.onclick = () => runWorkflowStep(i);
    }
  }

  // Table Sorting Handlers
  document.querySelectorAll('th[data-k]').forEach(th => {
    th.onclick = () => {
      asc = (sortKey === th.dataset.k) ? !asc : false;
      sortKey = th.dataset.k;
      render();
    };
  });

  // Basemap Switcher Buttons
  const basemapButtons = document.querySelectorAll('.btn-basemap');
  basemapButtons.forEach(btn => {
    btn.onclick = () => {
      basemapButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const bmType = btn.dataset.bm;

      if (map && basemaps[bmType]) {
        if (currentBasemap) {
          map.removeLayer(currentBasemap);
        }
        currentBasemap = basemaps[bmType].addTo(map);
      }
    };
  });

  // Layer Toggles
  if ($('#layer-radius')) {
    $('#layer-radius').onchange = e => {
      if (layerGroups.radius) {
        if (e.target.checked) map.addLayer(layerGroups.radius);
        else map.removeLayer(layerGroups.radius);
      }
    };
  }

  if ($('#layer-spill')) {
    $('#layer-spill').onchange = e => {
      if (layerGroups.spill) {
        if (e.target.checked) map.addLayer(layerGroups.spill);
        else map.removeLayer(layerGroups.spill);
      }
    };
  }

  if ($('#layer-tracks')) {
    $('#layer-tracks').onchange = e => {
      if (layerGroups.tracks) {
        if (e.target.checked) map.addLayer(layerGroups.tracks);
        else map.removeLayer(layerGroups.tracks);
      }
    };
  }

  if ($('#layer-labels')) {
    $('#layer-labels').onchange = () => {
      drawVesselTracks(candidates, tracks);
    };
  }

  // Focus & Overview Action Buttons
  if ($('#btn-focus-spill')) {
    $('#btn-focus-spill').onclick = () => {
      if (map && spill) {
        map.flyTo([spill.latitude, spill.longitude], 12, { duration: 1.2 });
      }
    };
  }

  if ($('#btn-world-view')) {
    $('#btn-world-view').onclick = () => {
      if (map) {
        map.flyTo([20, 40], 2.5, { duration: 1.5 });
      }
    };
  }

  // AIS Replay Controls
  if ($('#vessel')) {
    $('#vessel').onchange = e => pick(e.target.value);
  }

  if ($('#time')) {
    $('#time').oninput = () => updateReplayPosition();
  }

  if ($('#btn-step-prev')) {
    $('#btn-step-prev').onclick = () => {
      pauseReplay();
      let i = +$('#time').value;
      if (i > 0) {
        $('#time').value = i - 1;
        updateReplayPosition();
      }
    };
  }

  if ($('#btn-step-next')) {
    $('#btn-step-next').onclick = () => {
      pauseReplay();
      let i = +$('#time').value;
      let max = +$('#time').max;
      if (i < max) {
        $('#time').value = i + 1;
        updateReplayPosition();
      }
    };
  }

  if ($('#play')) {
    $('#play').onclick = () => {
      if (timer) {
        pauseReplay();
      } else {
        if (+$('#time').value >= +$('#time').max) {
          $('#time').value = 0;
        }
        startReplay();
      }
    };
  }

  // Speed Buttons
  const speedBtns = document.querySelectorAll('.btn-speed');
  speedBtns.forEach(btn => {
    btn.onclick = () => {
      speedBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      replayIntervalMs = parseInt(btn.dataset.speed, 10);
      if (timer) {
        startReplay();
      }
    };
  });
}

// --------------------------------------------------------------------------
// 9. AIS Replay Playback Timer
// --------------------------------------------------------------------------
function startReplay() {
  clearInterval(timer);
  const playBtn = $('#play');
  if (playBtn) {
    playBtn.textContent = '⏸ Pause';
    playBtn.classList.add('active');
  }

  timer = setInterval(() => {
    let i = +$('#time').value;
    let max = +$('#time').max;
    if (i >= max) {
      pauseReplay();
    } else {
      $('#time').value = i + 1;
      updateReplayPosition();
    }
  }, replayIntervalMs);
}

function pauseReplay() {
  clearInterval(timer);
  timer = null;
  const playBtn = $('#play');
  if (playBtn) {
    playBtn.textContent = '▶ Play';
    playBtn.classList.remove('active');
  }
}

async function uploadSARImage() {
  const input = $('#sar-upload-input');
  const button = $('#btn-upload-detect');
  const box = $('#upload-result');
  if (!input || !box) return;
  const file = input.files && input.files[0];
  if (!file) { setNotice('Choose a .tif/.tiff file before running detection.', true); return; }
  if (!/\.tiff?$/i.test(file.name)) { setNotice('Unsupported file type. Please upload a .tif or .tiff image.', true); return; }
  const formData = new FormData();
  formData.append('file', file);
  if (button) { button.disabled = true; button.textContent = 'Processing...'; }
  try {
    const res = await fetch(apiUrl('/api/detect-image'), { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || 'Detection request failed.');
    renderUploadResult(data);
    spill = Object.assign({}, spill || {}, { detector_status: data.detector_status, confidence: data.confidence, detector_confidence: data.confidence, detected_pixels: data.mask_pixels, area: data.spill_area, area_unit: data.spill_area.includes('km²') ? 'km²' : 'pixels' });
    renderDetectionEngine(spill);
    setNotice('Uploaded ' + file.name + ': ' + data.detector_status.replace(/_/g, ' ') + '. ' + (data.spill_area ? 'Area: ' + data.spill_area : ''));
  } catch (err) {
    renderUploadResult({ error: err.message });
    setNotice(err.message, true);
  } finally {
    if (button) { button.disabled = false; button.textContent = 'Run Detector'; }
  }
}

function renderUploadResult(result) {
  const container = $('#upload-result');
  if (!container) return;

  if (result.error) {
    container.innerHTML = `<div class="upload-error">${esc(result.error)}</div>`;
    return;
  }

  const status = (result.detector_status || 'UNKNOWN').replace(/_/g, ' ').toUpperCase();
  const areaText = result.spill_area ? `${result.spill_area}` : 'N/A';
  const confidenceText = result.confidence != null ? `${Math.round(result.confidence * 100)}%` : 'N/A';

  container.innerHTML = `
    <div class="upload-preview-grid">
      <div class="upload-preview-card">
        <div class="upload-preview-header">Original Uploaded Image</div>
        <img src="${result.original_image || ''}" alt="Original SAR upload" />
      </div>
      <div class="upload-preview-card">
        <div class="upload-preview-header">Detected Oil-Spill Mask</div>
        <img src="${result.mask_image || ''}" alt="Detected oil spill mask" />
      </div>
    </div>
    <div class="upload-metadata">
      <div><span>Status</span><strong>${esc(status)}</strong></div>
      <div><span>Spill Area</span><strong>${esc(areaText)}</strong></div>
      <div><span>Contrast Score</span><strong>${result.contrast_score != null ? Number(result.contrast_score).toFixed(3) : 'N/A'}</strong></div>
      <div><span>Confidence</span><strong>${esc(confidenceText)}</strong></div>
      <div><span>Mask Pixels</span><strong>${Number(result.mask_pixels || 0).toLocaleString()}</strong></div>
    </div>
  `;
}

async function initInvestigation() {
  try {
    const [state, cand, trk] = await Promise.all([
      fetch(apiUrl('/api/state')).then(r => r.json()),
      fetch(apiUrl('/api/candidates')).then(r => r.json()),
      fetch(apiUrl('/api/tracks')).then(r => r.json())
    ]);

    spill = state.spill;
    candidates = cand;
    tracks = trk;
    currentStage = state.stage || 'VESSELS_RANKED';
    selected = candidates[0] ? candidates[0].vessel_id : Object.keys(tracks)[0];

    // Initialize Leaflet Map
    initLeafletMap(spill, candidates, tracks);

    // Setup Event Listeners
    initEventListeners();

    // Synchronize UI
    await syncUIWithSession(state);
  } catch (err) {
    console.error('Error initializing investigation:', err);
    setNotice(`Backend communication failure: Ensure backend is running at ${API_BASE_URL}`, true);
  }
}

// Start application
initInvestigation();

// --------------------------------------------------------------------------
// 2. KPI Cards Rendering
// --------------------------------------------------------------------------
function renderKPICards(s, stage = currentStage) {
  const infoContainer = $('#info');
  if (!infoContainer) return;

  const isIngested = stage && stage !== 'NOT_STARTED';
  const isDetected = stage && ['SLICK_DETECTED', 'AIS_CORRELATED', 'VESSELS_RANKED'].includes(stage);

  const kpis = [
    {
      title: 'Spill Location',
      val: isDetected ? `${s.latitude.toFixed(4)}° N, ${s.longitude.toFixed(4)}° E` : (isIngested ? '18.9524° N, 72.8837° E' : 'Pending Ingest'),
      sub: 'Geographic Origin Anchor (DEMO)',
      symbol: '🎯'
    },
    {
      title: 'Spill Area',
      val: isDetected ? `${s.area} ${s.area_unit}` : (isIngested ? 'Awaiting Mask' : 'Pending Ingest'),
      sub: isDetected ? 'Cleaned Spatial Mask Extent' : 'Detection Mask Extent',
      symbol: '📐'
    },
    {
      title: 'Detection Confidence',
      val: isDetected ? `${Math.round(s.confidence * 100)}%` : (isIngested ? 'Awaiting Mask' : 'Pending Ingest'),
      sub: 'SAR Multi-Feature Composite',
      symbol: '🛡️',
      hasBar: isDetected,
      pct: isDetected ? Math.round(s.confidence * 100) : 0
    },
    {
      title: 'Detection Time',
      val: isIngested ? s.timestamp.replace('T', ' ').replace('Z', ' UTC') : 'Pending Ingest',
      sub: 'Sentinel-1 SAR Acquisition',
      symbol: '⏱️'
    }
  ];

  infoContainer.innerHTML = kpis.map(item => `
    <div class="kpi-card-white">
      <div class="kpi-card-head">
        <span class="kpi-card-label">${item.title}</span>
        <span class="kpi-card-symbol">${item.symbol}</span>
      </div>
      <div class="kpi-card-number">${item.val}</div>
      <div class="kpi-card-footnote">${item.sub}</div>
      ${item.hasBar ? `<div class="kpi-confidence-track"><div class="kpi-confidence-fill" style="width: ${item.pct}%;"></div></div>` : ''}
    </div>
  `).join('');
}
// --------------------------------------------------------------------------
// 2B. Detection Engine Output
// --------------------------------------------------------------------------
function renderDetectionEngine(s) {
  const container = $('#detection-engine');
  if (!container) return;

  const confidence = s.detector_confidence != null
    ? Math.round(s.detector_confidence * 100)
    : null;

  const shape = s.shape_score != null
    ? Math.round(s.shape_score * 100)
    : null;

  const area = s.area_score != null
    ? Math.round(s.area_score * 100)
    : null;

  const fallback = s.fallback_used ? 'YES' : 'NO';

  container.innerHTML = `
    <div class="detection-metric">
      <span class="detection-metric-label">DETECTOR STATUS</span>
      <strong>${esc((s.detector_status || 'UNKNOWN').replace(/_/g, ' ').toUpperCase())}</strong>
    </div>

    <div class="detection-metric">
      <span class="detection-metric-label">PROTOTYPE CONFIDENCE</span>
      <strong>${confidence != null ? confidence + '%' : 'N/A'}</strong>
      <div class="detection-mini-track">
        <div style="width:${confidence != null ? confidence : 0}%"></div>
      </div>
    </div>

    <div class="detection-metric">
      <span class="detection-metric-label">DETECTED PIXELS</span>
      <strong>${Number(s.detected_pixels || 0).toLocaleString()}</strong>
    </div>

    <div class="detection-metric">
      <span class="detection-metric-label">SHAPE SCORE</span>
      <strong>${shape != null ? shape + '%' : 'N/A'}</strong>
    </div>

    <div class="detection-metric">
      <span class="detection-metric-label">AREA SCORE</span>
      <strong>${area != null ? area + '%' : 'N/A'}</strong>
    </div>

    <div class="detection-metric">
      <span class="detection-metric-label">SENSITIVITY</span>
      <strong>${s.detection_sensitivity != null ? s.detection_sensitivity.toFixed(2) : 'N/A'}</strong>
    </div>

    <div class="detection-metric">
      <span class="detection-metric-label">FALLBACK MASK</span>
      <strong>${fallback}</strong>
    </div>

    <div class="detection-metric">
      <span class="detection-metric-label">CENTROID</span>
      <strong>${s.centroid_pixel
        ? `[${s.centroid_pixel[0].toFixed(1)}, ${s.centroid_pixel[1].toFixed(1)}]`
        : 'N/A'}</strong>
      <small>Pixel coordinates</small>
    </div>
  `;
}

// --------------------------------------------------------------------------
// 3. Leaflet GIS Map Initialization
// --------------------------------------------------------------------------
function initLeafletMap(s, c, t) {
  if (typeof L === 'undefined') {
    console.error('Leaflet library is not loaded');
    return;
  }

  // Initialize Map Instance centered on investigation area
  map = L.map('gis-map-viewport', {
    center: [s.latitude, s.longitude],
    zoom: 11,
    minZoom: 2,
    maxZoom: 18,
    zoomControl: true,
    attributionControl: true
  });

  // Define Legitimate Basemap Providers
  basemaps = {
    light: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19
    }),
    sat: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      attribution: 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, GIS Community',
      maxZoom: 18
    })
  };

  // Add Default Basemap (Map)
  currentBasemap = basemaps.light.addTo(map);

  // Initialize Layer Groups
  layerGroups.radius = L.layerGroup().addTo(map);
  layerGroups.spill = L.layerGroup().addTo(map);
  layerGroups.tracks = L.layerGroup().addTo(map);
  layerGroups.replay = L.layerGroup().addTo(map);

  // Draw 15 km Search Radius Circle
  const searchRadiusMeters = 15000;
  L.circle([s.latitude, s.longitude], {
    radius: searchRadiusMeters,
    color: '#0284c7',
    weight: 1.5,
    dashArray: '6, 6',
    fillColor: '#38bdf8',
    fillOpacity: 0.08
  }).bindTooltip('15 km Investigation Perimeter', { direction: 'top' }).addTo(layerGroups.radius);

  // Draw Spill Polygon if available
  if (s.polygon && s.polygon.length > 2) {
    L.polygon(s.polygon, {
      color: '#dc2626',
      weight: 2,
      dashArray: '4, 4',
      fillColor: '#ef4444',
      fillOpacity: 0.25
    }).bindPopup(`<b>Estimated Slick Extent</b><br>Area: ${s.area} ${s.area_unit}<br>Confidence: ${Math.round(s.confidence * 100)}%`).addTo(layerGroups.spill);
  }

  // Draw Spill Origin Custom Marker
  const spillIcon = L.divIcon({
    className: 'custom-spill-div-icon',
    html: '<div class="spill-origin-pulse"></div>',
    iconSize: [24, 24],
    iconAnchor: [12, 12]
  });

  L.marker([s.latitude, s.longitude], { icon: spillIcon })
    .bindPopup(`<b>🛢️ Estimated Spill Origin</b><br>Lat: ${s.latitude.toFixed(4)}°, Lon: ${s.longitude.toFixed(4)}°<br>Acquisition: ${s.timestamp.replace('T', ' ').replace('Z', ' UTC')}`)
    .addTo(layerGroups.spill);

  // Draw Vessel Tracks on Map
  drawVesselTracks(c, t);

  // Draw Initial Replay Position
  updateReplayPosition();
}

// --------------------------------------------------------------------------
// 4. Vessel Tracks Drawing on Leaflet Map
// --------------------------------------------------------------------------
function drawVesselTracks(candidatesList, tracksDict) {
  if (!layerGroups.tracks) return;
  layerGroups.tracks.clearLayers();
  trackLayers = {};
  vesselMarkers = {};

  const showLabels = $('#layer-labels') ? $('#layer-labels').checked : true;

  candidatesList.forEach(c => {
    const p = tracksDict[c.vessel_id];
    if (!p || !p.length) return;

    const isSelected = (c.vessel_id === selected);
    const color = c.risk === 'HIGH' ? '#dc2626' : c.risk === 'MEDIUM' ? '#d97706' : '#16a34a';
    const latLngs = p.map(pt => [pt.latitude, pt.longitude]);

    // Polyline Track
    const polyline = L.polyline(latLngs, {
      color: color,
      weight: isSelected ? 4.5 : 2,
      opacity: isSelected ? 1.0 : 0.45,
      lineCap: 'round',
      lineJoin: 'round'
    });

    polyline.on('click', () => pick(c.vessel_id));
    polyline.addTo(layerGroups.tracks);
    trackLayers[c.vessel_id] = polyline;

    // Track Waypoint Dots for Selected Vessel
    if (isSelected) {
      p.forEach((pt, idx) => {
        const dot = L.circleMarker([pt.latitude, pt.longitude], {
          radius: 3.5,
          color: '#0284c7',
          fillColor: '#ffffff',
          fillOpacity: 1,
          weight: 1.5
        }).bindTooltip(`<b>${esc(c.vessel_name)}</b><br>Passage: ${pt.timestamp.replace('T', ' ').replace('Z', ' UTC')}<br>Speed: ${pt.speed.toFixed(1)} kn · Heading: ${pt.heading.toFixed(0)}°`);
        dot.addTo(layerGroups.tracks);
      });
    }

    // Endpoint Marker
    const last = p[p.length - 1];
    const marker = L.circleMarker([last.latitude, last.longitude], {
      radius: isSelected ? 6.5 : 4.5,
      color: '#061325',
      weight: 1.5,
      fillColor: color,
      fillOpacity: 1
    });

    if (showLabels || isSelected) {
      marker.bindTooltip(`<b>${esc(c.vessel_name)}</b> (${c.risk})`, {
        permanent: isSelected || showLabels,
        direction: 'top',
        className: `gis-tooltip-${c.risk.toLowerCase()}`
      });
    }

    marker.on('click', () => pick(c.vessel_id));
    marker.addTo(layerGroups.tracks);
    vesselMarkers[c.vessel_id] = marker;
  });
}

// --------------------------------------------------------------------------
// 5. Update Replay Position on Map
// --------------------------------------------------------------------------
function updateReplayPosition() {
  if (!layerGroups.replay || !tracks || !selected || !tracks[selected]) return;
  layerGroups.replay.clearLayers();

  const stepIdx = +$('#time').value;
  const p = tracks[selected][stepIdx] || tracks[selected][0];

  const replayIcon = L.divIcon({
    className: 'custom-replay-marker',
    html: '<div class="replay-marker-icon" style="width: 14px; height: 14px;"></div>',
    iconSize: [14, 14],
    iconAnchor: [7, 7]
  });

  const replayMarker = L.marker([p.latitude, p.longitude], { icon: replayIcon, zIndexOffset: 1000 })
    .bindTooltip(`<b>REPLAY: ${esc(p.vessel_name)}</b><br>${p.speed.toFixed(1)} kn · ${p.heading.toFixed(0)}°<br>${p.timestamp.replace('T', ' ').replace('Z', ' UTC')}`, {
      permanent: false,
      direction: 'right'
    })
    .addTo(layerGroups.replay);

  // Update Replay Telemetry Bar
  if ($('#stamp')) {
    $('#stamp').textContent = p.timestamp.replace('T', ' ').replace('Z', ' UTC');
  }
  if ($('#current-step')) {
    $('#current-step').textContent = stepIdx + 1;
  }
  if ($('#total-steps')) {
    $('#total-steps').textContent = tracks[selected].length;
  }
}

// --------------------------------------------------------------------------
// 6. Main UI Render (Table & Evidence Breakdown)
// --------------------------------------------------------------------------
function render() {
  const tbody = $('#rows');
  const evidenceContainer = $('#evidence');

  if (!candidates || !candidates.length) {
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 32px 16px; font-size: 13px;">Awaiting Attribution Rank. Click <b>"⚡ Run Investigation"</b> or Step 4 above.</td></tr>`;
    }
    if (evidenceContainer) {
      evidenceContainer.innerHTML = `<div style="text-align: center; color: var(--text-muted); padding: 40px 16px; font-size: 13px;">Forensic evidence decomposition will appear once Attribution Rank executes.</div>`;
    }
    return;
  }

  // Update Column Header Sort Indicators
  document.querySelectorAll('th[data-k]').forEach(th => {
    const arrow = th.querySelector('.sort-arrow');
    if (arrow) {
      arrow.textContent = (th.dataset.k === sortKey) ? (asc ? '▲' : '▼') : '';
    }
  });

  // Sort candidate list
  const ordered = [...candidates].sort((a, b) => {
    let v = a[sortKey], w = b[sortKey];
    return (v > w ? 1 : v < w ? -1 : 0) * (asc ? 1 : -1);
  });

  // Render Table Rows
  tbody.innerHTML = ordered.map(c => {
    const originalRank = c.rank || (candidates.indexOf(c) + 1);
    const isSelected = c.vessel_id === selected;
    const isTop = originalRank === 1;

    return `
      <tr class="${isSelected ? 'selected-vessel' : ''} ${isTop ? 'top-ranked' : ''}" onclick="pick('${c.vessel_id}')">
        <td><span class="rank-badge ${isTop ? 'gold' : ''}">#${originalRank}</span></td>
        <td>
          <span class="vessel-cell-title">${esc(c.vessel_name)}</span>
          <span class="vessel-cell-id">${c.vessel_id}</span>
        </td>
        <td><b style="color: ${c.risk === 'HIGH' ? 'var(--risk-high)' : c.risk === 'MEDIUM' ? 'var(--risk-med)' : 'var(--risk-low)'}; font-size: 13.5px;">${c.final_score}</b><span style="color: var(--text-muted); font-size: 10px;">/100</span></td>
        <td><span class="risk-tag ${c.risk}">${c.risk}</span></td>
        <td>${c.closest_distance_km.toFixed(1)} km</td>
        <td>${c.time_gap_minutes.toFixed(0)} min</td>
        <td>${c.track_alignment.toFixed(0)}%</td>
      </tr>
    `;
  }).join('');

  // Render Evidence & Score Decomposition Panel
  const c = candidates.find(x => x.vessel_id === selected) || candidates[0];
  const b = c.score_breakdown;
  const rankNum = c.rank || (candidates.indexOf(c) + 1);
  const isTopCandidate = (c.is_top_candidate || rankNum === 1);

  const distPts = (b.distance * 0.30).toFixed(1);
  const timePts = (b.time * 0.25).toFixed(1);
  const trackPts = (b.track_alignment * 0.20).toFixed(1);
  const speedPts = (b.speed * 0.10).toFixed(1);
  const aisPts = (b.ais_behavior * 0.15).toFixed(1);

  $('#evidence').innerHTML = `
    <div class="evidence-hero-box">
      <div class="vessel-hero-summary">
        ${isTopCandidate ? '<div class="top-candidate-badge">★ TOP CANDIDATE (INVESTIGATIVE PRIORITIZATION ONLY)</div>' : ''}
        <h3>${esc(c.vessel_name)} <span class="risk-tag ${c.risk}">${c.risk} RISK</span></h3>
        <div class="vessel-telemetry">Rank #${rankNum} · IMO: ${c.vessel_id} · Speed: ${c.speed.toFixed(1)} kn · Heading: ${c.heading.toFixed(0)}°</div>
      </div>
      <div class="score-hero-block">
        <div class="score-hero-digits">${c.final_score}<span class="score-hero-max">/100</span></div>
        <div class="score-hero-caption">Attribution Score</div>
      </div>
    </div>

    <div class="findings-box">
      <div class="findings-box-heading">📌 Key Attribution Findings</div>
      <ul class="findings-list">
        ${c.reasons.map(r => `
          <li class="finding-row">
            <span class="finding-bullet">▸</span>
            <span>${esc(r)}</span>
          </li>
        `).join('')}
      </ul>
      ${c.ais_flags && c.ais_flags.length ? `
        <div class="ais-tags-row">
          ${c.ais_flags.map(f => `<span class="ais-anomaly-tag">⚠️ ${esc(f)}</span>`).join('')}
        </div>
      ` : ''}
    </div>

    <div class="score-meters-box">
      <div class="meters-title">📊 Multi-Factor Score Decomposition</div>
      <div class="meter-list">
        
        <div class="meter-row">
          <div class="meter-meta">
            <span class="meter-name">Distance Proximity <span class="meter-weight-tag">(30% max)</span></span>
            <span class="meter-score-val">${distPts} / 30.0</span>
          </div>
          <div class="meter-base-bar">
            <div class="meter-bar-progress" style="width: ${(distPts / 30.0 * 100).toFixed(1)}%;"></div>
          </div>
        </div>

        <div class="meter-row">
          <div class="meter-meta">
            <span class="meter-name">Temporal Proximity <span class="meter-weight-tag">(25% max)</span></span>
            <span class="meter-score-val">${timePts} / 25.0</span>
          </div>
          <div class="meter-base-bar">
            <div class="meter-bar-progress" style="width: ${(timePts / 25.0 * 100).toFixed(1)}%;"></div>
          </div>
        </div>

        <div class="meter-row">
          <div class="meter-meta">
            <span class="meter-name">Track Alignment <span class="meter-weight-tag">(20% max)</span></span>
            <span class="meter-score-val">${trackPts} / 20.0</span>
          </div>
          <div class="meter-base-bar">
            <div class="meter-bar-progress" style="width: ${(trackPts / 20.0 * 100).toFixed(1)}%;"></div>
          </div>
        </div>

        <div class="meter-row">
          <div class="meter-meta">
            <span class="meter-name">Speed Consistency <span class="meter-weight-tag">(10% max)</span></span>
            <span class="meter-score-val">${speedPts} / 10.0</span>
          </div>
          <div class="meter-base-bar">
            <div class="meter-bar-progress" style="width: ${(speedPts / 10.0 * 100).toFixed(1)}%;"></div>
          </div>
        </div>

        <div class="meter-row">
          <div class="meter-meta">
            <span class="meter-name">AIS Behavioral Anomaly <span class="meter-weight-tag">(15% max)</span></span>
            <span class="meter-score-val">${aisPts} / 15.0</span>
          </div>
          <div class="meter-base-bar">
            <div class="meter-bar-progress anomaly-bar" style="width: ${(aisPts / 15.0 * 100).toFixed(1)}%;"></div>
          </div>
        </div>

      </div>
    </div>
  `;

  // Synchronize Map Tracks Highlighting
  if (map && layerGroups.tracks) {
    drawVesselTracks(candidates, tracks);
    updateReplayPosition();
  }
}

// --------------------------------------------------------------------------
// 7. Vessel Selection Function (pick)
// --------------------------------------------------------------------------
function pick(id) {
  if (!tracks[id]) return;
  selected = id;

  if ($('#vessel')) {
    $('#vessel').value = id;
  }
  if ($('#time')) {
    $('#time').max = tracks[id].length - 1;
    $('#time').value = 0;
  }

  pauseReplay();
  render();
}
window.pick = pick;

// --------------------------------------------------------------------------
// 8. Event Listeners Initialization
// --------------------------------------------------------------------------
function initEventListeners() {
  // Workflow Control Actions
  if ($('#btn-run-workflow')) {
    $('#btn-run-workflow').onclick = () => runFullInvestigation();
  }

  if ($('#btn-reset-workflow')) {
    $('#btn-reset-workflow').onclick = () => resetInvestigation();
  }

  // Workflow Step Pills
  for (let i = 1; i <= 4; i++) {
    const pill = $(`#wf-step-${i}`);
    if (pill) {
      pill.onclick = () => runWorkflowStep(i);
    }
  }

  // Table Sorting Handlers
  document.querySelectorAll('th[data-k]').forEach(th => {
    th.onclick = () => {
      asc = (sortKey === th.dataset.k) ? !asc : false;
      sortKey = th.dataset.k;
      render();
    };
  });

  // Basemap Switcher Buttons
  const basemapButtons = document.querySelectorAll('.btn-basemap');
  basemapButtons.forEach(btn => {
    btn.onclick = () => {
      basemapButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const bmType = btn.dataset.bm;

      if (map && basemaps[bmType]) {
        if (currentBasemap) {
          map.removeLayer(currentBasemap);
        }
        currentBasemap = basemaps[bmType].addTo(map);
      }
    };
  });

  // Layer Toggles
  if ($('#layer-radius')) {
    $('#layer-radius').onchange = e => {
      if (layerGroups.radius) {
        if (e.target.checked) map.addLayer(layerGroups.radius);
        else map.removeLayer(layerGroups.radius);
      }
    };
  }

  if ($('#layer-spill')) {
    $('#layer-spill').onchange = e => {
      if (layerGroups.spill) {
        if (e.target.checked) map.addLayer(layerGroups.spill);
        else map.removeLayer(layerGroups.spill);
      }
    };
  }

  if ($('#layer-tracks')) {
    $('#layer-tracks').onchange = e => {
      if (layerGroups.tracks) {
        if (e.target.checked) map.addLayer(layerGroups.tracks);
        else map.removeLayer(layerGroups.tracks);
      }
    };
  }

  if ($('#layer-labels')) {
    $('#layer-labels').onchange = () => {
      drawVesselTracks(candidates, tracks);
    };
  }

  // Focus & Overview Action Buttons
  if ($('#btn-focus-spill')) {
    $('#btn-focus-spill').onclick = () => {
      if (map && spill) {
        map.flyTo([spill.latitude, spill.longitude], 12, { duration: 1.2 });
      }
    };
  }

  if ($('#btn-world-view')) {
    $('#btn-world-view').onclick = () => {
      if (map) {
        map.flyTo([20, 40], 2.5, { duration: 1.5 });
      }
    };
  }

  // AIS Replay Controls
  if ($('#vessel')) {
    $('#vessel').onchange = e => pick(e.target.value);
  }

  if ($('#time')) {
    $('#time').oninput = () => updateReplayPosition();
  }

  if ($('#btn-step-prev')) {
    $('#btn-step-prev').onclick = () => {
      pauseReplay();
      let i = +$('#time').value;
      if (i > 0) {
        $('#time').value = i - 1;
        updateReplayPosition();
      }
    };
  }

  if ($('#btn-step-next')) {
    $('#btn-step-next').onclick = () => {
      pauseReplay();
      let i = +$('#time').value;
      let max = +$('#time').max;
      if (i < max) {
        $('#time').value = i + 1;
        updateReplayPosition();
      }
    };
  }

  if ($('#play')) {
    $('#play').onclick = () => {
      if (timer) {
        pauseReplay();
      } else {
        if (+$('#time').value >= +$('#time').max) {
          $('#time').value = 0;
        }
        startReplay();
      }
    };
  }

  // Speed Buttons
  const speedBtns = document.querySelectorAll('.btn-speed');
  speedBtns.forEach(btn => {
    btn.onclick = () => {
      speedBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      replayIntervalMs = parseInt(btn.dataset.speed, 10);
      if (timer) {
        startReplay();
      }
    };
  });
}

// --------------------------------------------------------------------------
// 9. AIS Replay Playback Timer
// --------------------------------------------------------------------------
function startReplay() {
  clearInterval(timer);
  const playBtn = $('#play');
  if (playBtn) {
    playBtn.textContent = '⏸ Pause';
    playBtn.classList.add('active');
  }

  timer = setInterval(() => {
    let i = +$('#time').value;
    let max = +$('#time').max;
    if (i >= max) {
      pauseReplay();
    } else {
      $('#time').value = i + 1;
      updateReplayPosition();
    }
  }, replayIntervalMs);
}

function pauseReplay() {
  clearInterval(timer);
  timer = null;
  const playBtn = $('#play');
  if (playBtn) {
    playBtn.textContent = '▶ Play';
    playBtn.classList.remove('active');
  }
}

async function uploadSARImage() {
  const input = $('#sar-upload-input');
  const button = $('#btn-upload-detect');
  const box = $('#upload-result');
  if (!input || !box) return;
  const file = input.files && input.files[0];
  if (!file) { setNotice('Choose a .tif/.tiff file before running detection.', true); return; }
  if (!/\.tiff?$/i.test(file.name)) { setNotice('Unsupported file type. Please upload a .tif or .tiff image.', true); return; }
  const formData = new FormData();
  formData.append('file', file);
  if (button) { button.disabled = true; button.textContent = 'Processing...'; }
  try {
    const res = await fetch(apiUrl('/api/detect-image'), { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || 'Detection request failed.');
    renderUploadResult(data);
    spill = Object.assign({}, spill || {}, { detector_status: data.detector_status, confidence: data.confidence, detector_confidence: data.confidence, detected_pixels: data.mask_pixels, area: data.spill_area, area_unit: data.spill_area.includes('km²') ? 'km²' : 'pixels' });
    renderDetectionEngine(spill);
    setNotice('Uploaded ' + file.name + ': ' + data.detector_status.replace(/_/g, ' ') + '. ' + (data.spill_area ? 'Area: ' + data.spill_area : ''));
  } catch (err) {
    renderUploadResult({ error: err.message });
    setNotice(err.message, true);
  } finally {
    if (button) { button.disabled = false; button.textContent = 'Run Detector'; }
  }
}

function renderUploadResult(result) {
  const container = $('#upload-result');
  if (!container) return;

  if (result.error) {
    container.innerHTML = `<div class="upload-error">${esc(result.error)}</div>`;
    return;
  }

  const status = (result.detector_status || 'UNKNOWN').replace(/_/g, ' ').toUpperCase();
  const areaText = result.spill_area ? `${result.spill_area}` : 'N/A';
  const confidenceText = result.confidence != null ? `${Math.round(result.confidence * 100)}%` : 'N/A';

  container.innerHTML = `
    <div class="upload-preview-grid">
      <div class="upload-preview-card">
        <div class="upload-preview-header">Original Uploaded Image</div>
        <img src="${result.original_image || ''}" alt="Original SAR upload" />
      </div>
      <div class="upload-preview-card">
        <div class="upload-preview-header">Detected Oil-Spill Mask</div>
        <img src="${result.mask_image || ''}" alt="Detected oil spill mask" />
      </div>
    </div>
    <div class="upload-metadata">
      <div><span>Status</span><strong>${esc(status)}</strong></div>
      <div><span>Spill Area</span><strong>${esc(areaText)}</strong></div>
      <div><span>Contrast Score</span><strong>${result.contrast_score != null ? Number(result.contrast_score).toFixed(3) : 'N/A'}</strong></div>
      <div><span>Confidence</span><strong>${esc(confidenceText)}</strong></div>
      <div><span>Mask Pixels</span><strong>${Number(result.mask_pixels || 0).toLocaleString()}</strong></div>
    </div>
  `;
}

async function initInvestigation() {
  try {
    const [state, cand, trk] = await Promise.all([
      fetch(apiUrl('/api/state')).then(r => r.json()),
      fetch(apiUrl('/api/candidates')).then(r => r.json()),
      fetch(apiUrl('/api/tracks')).then(r => r.json())
    ]);

    spill = state.spill;
    candidates = cand;
    tracks = trk;
    currentStage = state.stage || 'VESSELS_RANKED';
    selected = candidates[0] ? candidates[0].vessel_id : Object.keys(tracks)[0];

    // Initialize Leaflet Map
    initLeafletMap(spill, candidates, tracks);

    // Setup Event Listeners
    initEventListeners();

    // Synchronize UI
    await syncUIWithSession(state);
  } catch (err) {
    console.error('Error initializing investigation:', err);
    setNotice(`Backend communication failure: Ensure backend is running at ${API_BASE_URL}`, true);
  }
}

// Start application
initInvestigation();

// --------------------------------------------------------------------------
// 2. KPI Cards Rendering
// --------------------------------------------------------------------------
function renderKPICards(s, stage = currentStage) {
  const infoContainer = $('#info');
  if (!infoContainer) return;

  const isIngested = stage && stage !== 'NOT_STARTED';
  const isDetected = stage && ['SLICK_DETECTED', 'AIS_CORRELATED', 'VESSELS_RANKED'].includes(stage);

  const kpis = [
    {
      title: 'Spill Location',
      val: isDetected ? `${s.latitude.toFixed(4)}° N, ${s.longitude.toFixed(4)}° E` : (isIngested ? '18.9524° N, 72.8837° E' : 'Pending Ingest'),
      sub: 'Geographic Origin Anchor (DEMO)',
      symbol: '🎯'
    },
    {
      title: 'Spill Area',
      val: isDetected ? `${s.area} ${s.area_unit}` : (isIngested ? 'Awaiting Mask' : 'Pending Ingest'),
      sub: isDetected ? 'Cleaned Spatial Mask Extent' : 'Detection Mask Extent',
      symbol: '📐'
    },
    {
      title: 'Detection Confidence',
      val: isDetected ? `${Math.round(s.confidence * 100)}%` : (isIngested ? 'Awaiting Mask' : 'Pending Ingest'),
      sub: 'SAR Multi-Feature Composite',
      symbol: '🛡️',
      hasBar: isDetected,
      pct: isDetected ? Math.round(s.confidence * 100) : 0
    },
    {
      title: 'Detection Time',
      val: isIngested ? s.timestamp.replace('T', ' ').replace('Z', ' UTC') : 'Pending Ingest',
      sub: 'Sentinel-1 SAR Acquisition',
      symbol: '⏱️'
    }
  ];

  infoContainer.innerHTML = kpis.map(item => `
    <div class="kpi-card-white">
      <div class="kpi-card-head">
        <span class="kpi-card-label">${item.title}</span>
        <span class="kpi-card-symbol">${item.symbol}</span>
      </div>
      <div class="kpi-card-number">${item.val}</div>
      <div class="kpi-card-footnote">${item.sub}</div>
      ${item.hasBar ? `<div class="kpi-confidence-track"><div class="kpi-confidence-fill" style="width: ${item.pct}%;"></div></div>` : ''}
    </div>
  `).join('');
}
// --------------------------------------------------------------------------
// 2B. Detection Engine Output
// --------------------------------------------------------------------------
function renderDetectionEngine(s) {
  const container = $('#detection-engine');
  if (!container) return;

  const confidence = s.detector_confidence != null
    ? Math.round(s.detector_confidence * 100)
    : null;

  const shape = s.shape_score != null
    ? Math.round(s.shape_score * 100)
    : null;

  const area = s.area_score != null
    ? Math.round(s.area_score * 100)
    : null;

  const fallback = s.fallback_used ? 'YES' : 'NO';

  container.innerHTML = `
    <div class="detection-metric">
      <span class="detection-metric-label">DETECTOR STATUS</span>
      <strong>${esc((s.detector_status || 'UNKNOWN').replace(/_/g, ' ').toUpperCase())}</strong>
    </div>

    <div class="detection-metric">
      <span class="detection-metric-label">PROTOTYPE CONFIDENCE</span>
      <strong>${confidence != null ? confidence + '%' : 'N/A'}</strong>
      <div class="detection-mini-track">
        <div style="width:${confidence != null ? confidence : 0}%"></div>
      </div>
    </div>

    <div class="detection-metric">
      <span class="detection-metric-label">DETECTED PIXELS</span>
      <strong>${Number(s.detected_pixels || 0).toLocaleString()}</strong>
    </div>

    <div class="detection-metric">
      <span class="detection-metric-label">SHAPE SCORE</span>
      <strong>${shape != null ? shape + '%' : 'N/A'}</strong>
    </div>

    <div class="detection-metric">
      <span class="detection-metric-label">AREA SCORE</span>
      <strong>${area != null ? area + '%' : 'N/A'}</strong>
    </div>

    <div class="detection-metric">
      <span class="detection-metric-label">SENSITIVITY</span>
      <strong>${s.detection_sensitivity != null ? s.detection_sensitivity.toFixed(2) : 'N/A'}</strong>
    </div>

    <div class="detection-metric">
      <span class="detection-metric-label">FALLBACK MASK</span>
      <strong>${fallback}</strong>
    </div>

    <div class="detection-metric">
      <span class="detection-metric-label">CENTROID</span>
      <strong>${s.centroid_pixel
        ? `[${s.centroid_pixel[0].toFixed(1)}, ${s.centroid_pixel[1].toFixed(1)}]`
        : 'N/A'}</strong>
      <small>Pixel coordinates</small>
    </div>
  `;
}

// --------------------------------------------------------------------------
// 3. Leaflet GIS Map Initialization
// --------------------------------------------------------------------------
function initLeafletMap(s, c, t) {
  if (typeof L === 'undefined') {
    console.error('Leaflet library is not loaded');
    return;
  }

  // Initialize Map Instance centered on investigation area
  map = L.map('gis-map-viewport', {
    center: [s.latitude, s.longitude],
    zoom: 11,
    minZoom: 2,
    maxZoom: 18,
    zoomControl: true,
    attributionControl: true
  });

  // Define Legitimate Basemap Providers
  basemaps = {
    light: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19
    }),
    sat: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      attribution: 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, GIS Community',
      maxZoom: 18
    })
  };

  // Add Default Basemap (Map)
  currentBasemap = basemaps.light.addTo(map);

  // Initialize Layer Groups
  layerGroups.radius = L.layerGroup().addTo(map);
  layerGroups.spill = L.layerGroup().addTo(map);
  layerGroups.tracks = L.layerGroup().addTo(map);
  layerGroups.replay = L.layerGroup().addTo(map);

  // Draw 15 km Search Radius Circle
  const searchRadiusMeters = 15000;
  L.circle([s.latitude, s.longitude], {
    radius: searchRadiusMeters,
    color: '#0284c7',
    weight: 1.5,
    dashArray: '6, 6',
    fillColor: '#38bdf8',
    fillOpacity: 0.08
  }).bindTooltip('15 km Investigation Perimeter', { direction: 'top' }).addTo(layerGroups.radius);

  // Draw Spill Polygon if available
  if (s.polygon && s.polygon.length > 2) {
    L.polygon(s.polygon, {
      color: '#dc2626',
      weight: 2,
      dashArray: '4, 4',
      fillColor: '#ef4444',
      fillOpacity: 0.25
    }).bindPopup(`<b>Estimated Slick Extent</b><br>Area: ${s.area} ${s.area_unit}<br>Confidence: ${Math.round(s.confidence * 100)}%`).addTo(layerGroups.spill);
  }

  // Draw Spill Origin Custom Marker
  const spillIcon = L.divIcon({
    className: 'custom-spill-div-icon',
    html: '<div class="spill-origin-pulse"></div>',
    iconSize: [24, 24],
    iconAnchor: [12, 12]
  });

  L.marker([s.latitude, s.longitude], { icon: spillIcon })
    .bindPopup(`<b>🛢️ Estimated Spill Origin</b><br>Lat: ${s.latitude.toFixed(4)}°, Lon: ${s.longitude.toFixed(4)}°<br>Acquisition: ${s.timestamp.replace('T', ' ').replace('Z', ' UTC')}`)
    .addTo(layerGroups.spill);

  // Draw Vessel Tracks on Map
  drawVesselTracks(c, t);

  // Draw Initial Replay Position
  updateReplayPosition();
}

// --------------------------------------------------------------------------
// 4. Vessel Tracks Drawing on Leaflet Map
// --------------------------------------------------------------------------
function drawVesselTracks(candidatesList, tracksDict) {
  if (!layerGroups.tracks) return;
  layerGroups.tracks.clearLayers();
  trackLayers = {};
  vesselMarkers = {};

  const showLabels = $('#layer-labels') ? $('#layer-labels').checked : true;

  candidatesList.forEach(c => {
    const p = tracksDict[c.vessel_id];
    if (!p || !p.length) return;

    const isSelected = (c.vessel_id === selected);
    const color = c.risk === 'HIGH' ? '#dc2626' : c.risk === 'MEDIUM' ? '#d97706' : '#16a34a';
    const latLngs = p.map(pt => [pt.latitude, pt.longitude]);

    // Polyline Track
    const polyline = L.polyline(latLngs, {
      color: color,
      weight: isSelected ? 4.5 : 2,
      opacity: isSelected ? 1.0 : 0.45,
      lineCap: 'round',
      lineJoin: 'round'
    });

    polyline.on('click', () => pick(c.vessel_id));
    polyline.addTo(layerGroups.tracks);
    trackLayers[c.vessel_id] = polyline;

    // Track Waypoint Dots for Selected Vessel
    if (isSelected) {
      p.forEach((pt, idx) => {
        const dot = L.circleMarker([pt.latitude, pt.longitude], {
          radius: 3.5,
          color: '#0284c7',
          fillColor: '#ffffff',
          fillOpacity: 1,
          weight: 1.5
        }).bindTooltip(`<b>${esc(c.vessel_name)}</b><br>Passage: ${pt.timestamp.replace('T', ' ').replace('Z', ' UTC')}<br>Speed: ${pt.speed.toFixed(1)} kn · Heading: ${pt.heading.toFixed(0)}°`);
        dot.addTo(layerGroups.tracks);
      });
    }

    // Endpoint Marker
    const last = p[p.length - 1];
    const marker = L.circleMarker([last.latitude, last.longitude], {
      radius: isSelected ? 6.5 : 4.5,
      color: '#061325',
      weight: 1.5,
      fillColor: color,
      fillOpacity: 1
    });

    if (showLabels || isSelected) {
      marker.bindTooltip(`<b>${esc(c.vessel_name)}</b> (${c.risk})`, {
        permanent: isSelected || showLabels,
        direction: 'top',
        className: `gis-tooltip-${c.risk.toLowerCase()}`
      });
    }

    marker.on('click', () => pick(c.vessel_id));
    marker.addTo(layerGroups.tracks);
    vesselMarkers[c.vessel_id] = marker;
  });
}

// --------------------------------------------------------------------------
// 5. Update Replay Position on Map
// --------------------------------------------------------------------------
function updateReplayPosition() {
  if (!layerGroups.replay || !tracks || !selected || !tracks[selected]) return;
  layerGroups.replay.clearLayers();

  const stepIdx = +$('#time').value;
  const p = tracks[selected][stepIdx] || tracks[selected][0];

  const replayIcon = L.divIcon({
    className: 'custom-replay-marker',
    html: '<div class="replay-marker-icon" style="width: 14px; height: 14px;"></div>',
    iconSize: [14, 14],
    iconAnchor: [7, 7]
  });

  const replayMarker = L.marker([p.latitude, p.longitude], { icon: replayIcon, zIndexOffset: 1000 })
    .bindTooltip(`<b>REPLAY: ${esc(p.vessel_name)}</b><br>${p.speed.toFixed(1)} kn · ${p.heading.toFixed(0)}°<br>${p.timestamp.replace('T', ' ').replace('Z', ' UTC')}`, {
      permanent: false,
      direction: 'right'
    })
    .addTo(layerGroups.replay);

  // Update Replay Telemetry Bar
  if ($('#stamp')) {
    $('#stamp').textContent = p.timestamp.replace('T', ' ').replace('Z', ' UTC');
  }
  if ($('#current-step')) {
    $('#current-step').textContent = stepIdx + 1;
  }
  if ($('#total-steps')) {
    $('#total-steps').textContent = tracks[selected].length;
  }
}

// --------------------------------------------------------------------------
// 6. Main UI Render (Table & Evidence Breakdown)
// --------------------------------------------------------------------------
function render() {
  const tbody = $('#rows');
  const evidenceContainer = $('#evidence');

  if (!candidates || !candidates.length) {
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 32px 16px; font-size: 13px;">Awaiting Attribution Rank. Click <b>"⚡ Run Investigation"</b> or Step 4 above.</td></tr>`;
    }
    if (evidenceContainer) {
      evidenceContainer.innerHTML = `<div style="text-align: center; color: var(--text-muted); padding: 40px 16px; font-size: 13px;">Forensic evidence decomposition will appear once Attribution Rank executes.</div>`;
    }
    return;
  }

  // Update Column Header Sort Indicators
  document.querySelectorAll('th[data-k]').forEach(th => {
    const arrow = th.querySelector('.sort-arrow');
    if (arrow) {
      arrow.textContent = (th.dataset.k === sortKey) ? (asc ? '▲' : '▼') : '';
    }
  });

  // Sort candidate list
  const ordered = [...candidates].sort((a, b) => {
    let v = a[sortKey], w = b[sortKey];
    return (v > w ? 1 : v < w ? -1 : 0) * (asc ? 1 : -1);
  });

  // Render Table Rows
  tbody.innerHTML = ordered.map(c => {
    const originalRank = c.rank || (candidates.indexOf(c) + 1);
    const isSelected = c.vessel_id === selected;
    const isTop = originalRank === 1;

    return `
      <tr class="${isSelected ? 'selected-vessel' : ''} ${isTop ? 'top-ranked' : ''}" onclick="pick('${c.vessel_id}')">
        <td><span class="rank-badge ${isTop ? 'gold' : ''}">#${originalRank}</span></td>
        <td>
          <span class="vessel-cell-title">${esc(c.vessel_name)}</span>
          <span class="vessel-cell-id">${c.vessel_id}</span>
        </td>
        <td><b style="color: ${c.risk === 'HIGH' ? 'var(--risk-high)' : c.risk === 'MEDIUM' ? 'var(--risk-med)' : 'var(--risk-low)'}; font-size: 13.5px;">${c.final_score}</b><span style="color: var(--text-muted); font-size: 10px;">/100</span></td>
        <td><span class="risk-tag ${c.risk}">${c.risk}</span></td>
        <td>${c.closest_distance_km.toFixed(1)} km</td>
        <td>${c.time_gap_minutes.toFixed(0)} min</td>
        <td>${c.track_alignment.toFixed(0)}%</td>
      </tr>
    `;
  }).join('');

  // Render Evidence & Score Decomposition Panel
  const c = candidates.find(x => x.vessel_id === selected) || candidates[0];
  const b = c.score_breakdown;
  const rankNum = c.rank || (candidates.indexOf(c) + 1);
  const isTopCandidate = (c.is_top_candidate || rankNum === 1);

  const distPts = (b.distance * 0.30).toFixed(1);
  const timePts = (b.time * 0.25).toFixed(1);
  const trackPts = (b.track_alignment * 0.20).toFixed(1);
  const speedPts = (b.speed * 0.10).toFixed(1);
  const aisPts = (b.ais_behavior * 0.15).toFixed(1);

  $('#evidence').innerHTML = `
    <div class="evidence-hero-box">
      <div class="vessel-hero-summary">
        ${isTopCandidate ? '<div class="top-candidate-badge">★ TOP CANDIDATE (INVESTIGATIVE PRIORITIZATION ONLY)</div>' : ''}
        <h3>${esc(c.vessel_name)} <span class="risk-tag ${c.risk}">${c.risk} RISK</span></h3>
        <div class="vessel-telemetry">Rank #${rankNum} · IMO: ${c.vessel_id} · Speed: ${c.speed.toFixed(1)} kn · Heading: ${c.heading.toFixed(0)}°</div>
      </div>
      <div class="score-hero-block">
        <div class="score-hero-digits">${c.final_score}<span class="score-hero-max">/100</span></div>
        <div class="score-hero-caption">Attribution Score</div>
      </div>
    </div>

    <div class="findings-box">
      <div class="findings-box-heading">📌 Key Attribution Findings</div>
      <ul class="findings-list">
        ${c.reasons.map(r => `
          <li class="finding-row">
            <span class="finding-bullet">▸</span>
            <span>${esc(r)}</span>
          </li>
        `).join('')}
      </ul>
      ${c.ais_flags && c.ais_flags.length ? `
        <div class="ais-tags-row">
          ${c.ais_flags.map(f => `<span class="ais-anomaly-tag">⚠️ ${esc(f)}</span>`).join('')}
        </div>
      ` : ''}
    </div>

    <div class="score-meters-box">
      <div class="meters-title">📊 Multi-Factor Score Decomposition</div>
      <div class="meter-list">
        
        <div class="meter-row">
          <div class="meter-meta">
            <span class="meter-name">Distance Proximity <span class="meter-weight-tag">(30% max)</span></span>
            <span class="meter-score-val">${distPts} / 30.0</span>
          </div>
          <div class="meter-base-bar">
            <div class="meter-bar-progress" style="width: ${(distPts / 30.0 * 100).toFixed(1)}%;"></div>
          </div>
        </div>

        <div class="meter-row">
          <div class="meter-meta">
            <span class="meter-name">Temporal Proximity <span class="meter-weight-tag">(25% max)</span></span>
            <span class="meter-score-val">${timePts} / 25.0</span>
          </div>
          <div class="meter-base-bar">
            <div class="meter-bar-progress" style="width: ${(timePts / 25.0 * 100).toFixed(1)}%;"></div>
          </div>
        </div>

        <div class="meter-row">
          <div class="meter-meta">
            <span class="meter-name">Track Alignment <span class="meter-weight-tag">(20% max)</span></span>
            <span class="meter-score-val">${trackPts} / 20.0</span>
          </div>
          <div class="meter-base-bar">
            <div class="meter-bar-progress" style="width: ${(trackPts / 20.0 * 100).toFixed(1)}%;"></div>
          </div>
        </div>

        <div class="meter-row">
          <div class="meter-meta">
            <span class="meter-name">Speed Consistency <span class="meter-weight-tag">(10% max)</span></span>
            <span class="meter-score-val">${speedPts} / 10.0</span>
          </div>
          <div class="meter-base-bar">
            <div class="meter-bar-progress" style="width: ${(speedPts / 10.0 * 100).toFixed(1)}%;"></div>
          </div>
        </div>

        <div class="meter-row">
          <div class="meter-meta">
            <span class="meter-name">AIS Behavioral Anomaly <span class="meter-weight-tag">(15% max)</span></span>
            <span class="meter-score-val">${aisPts} / 15.0</span>
          </div>
          <div class="meter-base-bar">
            <div class="meter-bar-progress anomaly-bar" style="width: ${(aisPts / 15.0 * 100).toFixed(1)}%;"></div>
          </div>
        </div>

      </div>
    </div>
  `;

  // Synchronize Map Tracks Highlighting
  if (map && layerGroups.tracks) {
    drawVesselTracks(candidates, tracks);
    updateReplayPosition();
  }
}

// --------------------------------------------------------------------------
// 7. Vessel Selection Function (pick)
// --------------------------------------------------------------------------
function pick(id) {
  if (!tracks[id]) return;
  selected = id;

  if ($('#vessel')) {
    $('#vessel').value = id;
  }
  if ($('#time')) {
    $('#time').max = tracks[id].length - 1;
    $('#time').value = 0;
  }

  pauseReplay();
  render();
}
window.pick = pick;

// --------------------------------------------------------------------------
// 8. Event Listeners Initialization
// --------------------------------------------------------------------------
function initEventListeners() {
  // Workflow Control Actions
  if ($('#btn-run-workflow')) {
    $('#btn-run-workflow').onclick = () => runFullInvestigation();
  }

  if ($('#btn-reset-workflow')) {
    $('#btn-reset-workflow').onclick = () => resetInvestigation();
  }

  // Workflow Step Pills
  for (let i = 1; i <= 4; i++) {
    const pill = $(`#wf-step-${i}`);
    if (pill) {
      pill.onclick = () => runWorkflowStep(i);
    }
  }

  // Table Sorting Handlers
  document.querySelectorAll('th[data-k]').forEach(th => {
    th.onclick = () => {
      asc = (sortKey === th.dataset.k) ? !asc : false;
      sortKey = th.dataset.k;
      render();
    };
  });

  // Basemap Switcher Buttons
  const basemapButtons = document.querySelectorAll('.btn-basemap');
  basemapButtons.forEach(btn => {
    btn.onclick = () => {
      basemapButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const bmType = btn.dataset.bm;

      if (map && basemaps[bmType]) {
        if (currentBasemap) {
          map.removeLayer(currentBasemap);
        }
        currentBasemap = basemaps[bmType].addTo(map);
      }
    };
  });

  // Layer Toggles
  if ($('#layer-radius')) {
    $('#layer-radius').onchange = e => {
      if (layerGroups.radius) {
        if (e.target.checked) map.addLayer(layerGroups.radius);
        else map.removeLayer(layerGroups.radius);
      }
    };
  }

  if ($('#layer-spill')) {
    $('#layer-spill').onchange = e => {
      if (layerGroups.spill) {
        if (e.target.checked) map.addLayer(layerGroups.spill);
        else map.removeLayer(layerGroups.spill);
      }
    };
  }

  if ($('#layer-tracks')) {
    $('#layer-tracks').onchange = e => {
      if (layerGroups.tracks) {
        if (e.target.checked) map.addLayer(layerGroups.tracks);
        else map.removeLayer(layerGroups.tracks);
      }
    };
  }

  if ($('#layer-labels')) {
    $('#layer-labels').onchange = () => {
      drawVesselTracks(candidates, tracks);
    };
  }

  // Focus & Overview Action Buttons
  if ($('#btn-focus-spill')) {
    $('#btn-focus-spill').onclick = () => {
      if (map && spill) {
        map.flyTo([spill.latitude, spill.longitude], 12, { duration: 1.2 });
      }
    };
  }

  if ($('#btn-world-view')) {
    $('#btn-world-view').onclick = () => {
      if (map) {
        map.flyTo([20, 40], 2.5, { duration: 1.5 });
      }
    };
  }

  // AIS Replay Controls
  if ($('#vessel')) {
    $('#vessel').onchange = e => pick(e.target.value);
  }

  if ($('#time')) {
    $('#time').oninput = () => updateReplayPosition();
  }

  if ($('#btn-step-prev')) {
    $('#btn-step-prev').onclick = () => {
      pauseReplay();
      let i = +$('#time').value;
      if (i > 0) {
        $('#time').value = i - 1;
        updateReplayPosition();
      }
    };
  }

  if ($('#btn-step-next')) {
    $('#btn-step-next').onclick = () => {
      pauseReplay();
      let i = +$('#time').value;
      let max = +$('#time').max;
      if (i < max) {
        $('#time').value = i + 1;
        updateReplayPosition();
      }
    };
  }

  if ($('#play')) {
    $('#play').onclick = () => {
      if (timer) {
        pauseReplay();
      } else {
        if (+$('#time').value >= +$('#time').max) {
          $('#time').value = 0;
        }
        startReplay();
      }
    };
  }

  // Speed Buttons
  const speedBtns = document.querySelectorAll('.btn-speed');
  speedBtns.forEach(btn => {
    btn.onclick = () => {
      speedBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      replayIntervalMs = parseInt(btn.dataset.speed, 10);
      if (timer) {
        startReplay();
      }
    };
  });
}

// --------------------------------------------------------------------------
// 9. AIS Replay Playback Timer
// --------------------------------------------------------------------------
function startReplay() {
  clearInterval(timer);
  const playBtn = $('#play');
  if (playBtn) {
    playBtn.textContent = '⏸ Pause';
    playBtn.classList.add('active');
  }

  timer = setInterval(() => {
    let i = +$('#time').value;
    let max = +$('#time').max;
    if (i >= max) {
      pauseReplay();
    } else {
      $('#time').value = i + 1;
      updateReplayPosition();
    }
  }, replayIntervalMs);
}

function pauseReplay() {
  clearInterval(timer);
  timer = null;
  const playBtn = $('#play');
  if (playBtn) {
    playBtn.textContent = '▶ Play';
    playBtn.classList.remove('active');
  }
}

async function uploadSARImage() {
  const input = $('#sar-upload-input');
  const button = $('#btn-upload-detect');
  const box = $('#upload-result');
  if (!input || !box) return;
  const file = input.files && input.files[0];
  if (!file) { setNotice('Choose a .tif/.tiff file before running detection.', true); return; }
  if (!/\.tiff?$/i.test(file.name)) { setNotice('Unsupported file type. Please upload a .tif or .tiff image.', true); return; }
  const formData = new FormData();
  formData.append('file', file);
  if (button) { button.disabled = true; button.textContent = 'Processing...'; }
  try {
    const res = await fetch(apiUrl('/api/detect-image'), { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || 'Detection request failed.');
    renderUploadResult(data);
    spill = Object.assign({}, spill || {}, { detector_status: data.detector_status, confidence: data.confidence, detector_confidence: data.confidence, detected_pixels: data.mask_pixels, area: data.spill_area, area_unit: data.spill_area.includes('km²') ? 'km²' : 'pixels' });
    renderDetectionEngine(spill);
    setNotice('Uploaded ' + file.name + ': ' + data.detector_status.replace(/_/g, ' ') + '. ' + (data.spill_area ? 'Area: ' + data.spill_area : ''));
  } catch (err) {
    renderUploadResult({ error: err.message });
    setNotice(err.message, true);
  } finally {
    if (button) { button.disabled = false; button.textContent = 'Run Detector'; }
  }
}

function renderUploadResult(result) {
  const container = $('#upload-result');
  if (!container) return;

  if (result.error) {
    container.innerHTML = `<div class="upload-error">${esc(result.error)}</div>`;
    return;
  }

  const status = (result.detector_status || 'UNKNOWN').replace(/_/g, ' ').toUpperCase();
  const areaText = result.spill_area ? `${result.spill_area}` : 'N/A';
  const confidenceText = result.confidence != null ? `${Math.round(result.confidence * 100)}%` : 'N/A';

  container.innerHTML = `
    <div class="upload-preview-grid">
      <div class="upload-preview-card">
        <div class="upload-preview-header">Original Uploaded Image</div>
        <img src="${result.original_image || ''}" alt="Original SAR upload" />
      </div>
      <div class="upload-preview-card">
        <div class="upload-preview-header">Detected Oil-Spill Mask</div>
        <img src="${result.mask_image || ''}" alt="Detected oil spill mask" />
      </div>
    </div>
    <div class="upload-metadata">
      <div><span>Status</span><strong>${esc(status)}</strong></div>
      <div><span>Spill Area</span><strong>${esc(areaText)}</strong></div>
      <div><span>Contrast Score</span><strong>${result.contrast_score != null ? Number(result.contrast_score).toFixed(3) : 'N/A'}</strong></div>
      <div><span>Confidence</span><strong>${esc(confidenceText)}</strong></div>
      <div><span>Mask Pixels</span><strong>${Number(result.mask_pixels || 0).toLocaleString()}</strong></div>
    </div>
  `;
}

async function initInvestigation() {
  try {
    const [state, cand, trk] = await Promise.all([
      fetch(apiUrl('/api/state')).then(r => r.json()),
      fetch(apiUrl('/api/candidates')).then(r => r.json()),
      fetch(apiUrl('/api/tracks')).then(r => r.json())
    ]);

    spill = state.spill;
    candidates = cand;
    tracks = trk;
    currentStage = state.stage || 'VESSELS_RANKED';
    selected = candidates[0] ? candidates[0].vessel_id : Object.keys(tracks)[0];

    // Initialize Leaflet Map
    initLeafletMap(spill, candidates, tracks);

    // Setup Event Listeners
    initEventListeners();

    // Synchronize UI
    await syncUIWithSession(state);
  } catch (err) {
    console.error('Error initializing investigation:', err);
    setNotice(`Backend communication failure: Ensure backend is running at ${API_BASE_URL}`, true);
  }
}

// Start application
initInvestigation();

// --------------------------------------------------------------------------
// 2. KPI Cards Rendering
// --------------------------------------------------------------------------
function renderKPICards(s, stage = currentStage) {
  const infoContainer = $('#info');
  if (!infoContainer) return;

  const isIngested = stage && stage !== 'NOT_STARTED';
  const isDetected = stage && ['SLICK_DETECTED', 'AIS_CORRELATED', 'VESSELS_RANKED'].includes(stage);

  const kpis = [
    {
      title: 'Spill Location',
      val: isDetected ? `${s.latitude.toFixed(4)}° N, ${s.longitude.toFixed(4)}° E` : (isIngested ? '18.9524° N, 72.8837° E' : 'Pending Ingest'),
      sub: 'Geographic Origin Anchor (DEMO)',
      symbol: '🎯'
    },
    {
      title: 'Spill Area',
      val: isDetected ? `${s.area} ${s.area_unit}` : (isIngested ? 'Awaiting Mask' : 'Pending Ingest'),
      sub: isDetected ? 'Cleaned Spatial Mask Extent' : 'Detection Mask Extent',
      symbol: '📐'
    },
    {
      title: 'Detection Confidence',
      val: isDetected ? `${Math.round(s.confidence * 100)}%` : (isIngested ? 'Awaiting Mask' : 'Pending Ingest'),
      sub: 'SAR Multi-Feature Composite',
      symbol: '🛡️',
      hasBar: isDetected,
      pct: isDetected ? Math.round(s.confidence * 100) : 0
    },
    {
      title: 'Detection Time',
      val: isIngested ? s.timestamp.replace('T', ' ').replace('Z', ' UTC') : 'Pending Ingest',
      sub: 'Sentinel-1 SAR Acquisition',
      symbol: '⏱️'
    }
  ];

  infoContainer.innerHTML = kpis.map(item => `
    <div class="kpi-card-white">
      <div class="kpi-card-head">
        <span class="kpi-card-label">${item.title}</span>
        <span class="kpi-card-symbol">${item.symbol}</span>
      </div>
      <div class="kpi-card-number">${item.val}</div>
      <div class="kpi-card-footnote">${item.sub}</div>
      ${item.hasBar ? `<div class="kpi-confidence-track"><div class="kpi-confidence-fill" style="width: ${item.pct}%;"></div></div>` : ''}
    </div>
  `).join('');
}
// --------------------------------------------------------------------------
// 2B. Detection Engine Output
// --------------------------------------------------------------------------
function renderDetectionEngine(s) {
  const container = $('#detection-engine');
  if (!container) return;

  const confidence = s.detector_confidence != null
    ? Math.round(s.detector_confidence * 100)
    : null;

  const shape = s.shape_score != null
    ? Math.round(s.shape_score * 100)
    : null;

  const area = s.area_score != null
    ? Math.round(s.area_score * 100)
    : null;

  const fallback = s.fallback_used ? 'YES' : 'NO';

  container.innerHTML = `
    <div class="detection-metric">
      <span class="detection-metric-label">DETECTOR STATUS</span>
      <strong>${esc((s.detector_status || 'UNKNOWN').replace(/_/g, ' ').toUpperCase())}</strong>
    </div>

    <div class="detection-metric">
      <span class="detection-metric-label">PROTOTYPE CONFIDENCE</span>
      <strong>${confidence != null ? confidence + '%' : 'N/A'}</strong>
      <div class="detection-mini-track">
        <div style="width:${confidence != null ? confidence : 0}%"></div>
      </div>
    </div>

    <div class="detection-metric">
      <span class="detection-metric-label">DETECTED PIXELS</span>
      <strong>${Number(s.detected_pixels || 0).toLocaleString()}</strong>
    </div>

    <div class="detection-metric">
      <span class="detection-metric-label">SHAPE SCORE</span>
      <strong>${shape != null ? shape + '%' : 'N/A'}</strong>
    </div>

    <div class="detection-metric">
      <span class="detection-metric-label">AREA SCORE</span>
      <strong>${area != null ? area + '%' : 'N/A'}</strong>
    </div>

    <div class="detection-metric">
      <span class="detection-metric-label">SENSITIVITY</span>
      <strong>${s.detection_sensitivity != null ? s.detection_sensitivity.toFixed(2) : 'N/A'}</strong>
    </div>

    <div class="detection-metric">
      <span class="detection-metric-label">FALLBACK MASK</span>
      <strong>${fallback}</strong>
    </div>

    <div class="detection-metric">
      <span class="detection-metric-label">CENTROID</span>
      <strong>${s.centroid_pixel
        ? `[${s.centroid_pixel[0].toFixed(1)}, ${s.centroid_pixel[1].toFixed(1)}]`
        : 'N/A'}</strong>
      <small>Pixel coordinates</small>
    </div>
  `;
}

// --------------------------------------------------------------------------
// 3. Leaflet GIS Map Initialization
// --------------------------------------------------------------------------
function initLeafletMap(s, c, t) {
  if (typeof L === 'undefined') {
    console.error('Leaflet library is not loaded');
    return;
  }

  // Initialize Map Instance centered on investigation area
  map = L.map('gis-map-viewport', {
    center: [s.latitude, s.longitude],
    zoom: 11,
    minZoom: 2,
    maxZoom: 18,
    zoomControl: true,
    attributionControl: true
  });

  // Define Legitimate Basemap Providers
  basemaps = {
    light: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19
    }),
    sat: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      attribution: 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, GIS Community',
      maxZoom: 18
    })
  };

  // Add Default Basemap (Map)
  currentBasemap = basemaps.light.addTo(map);

  // Initialize Layer Groups
  layerGroups.radius = L.layerGroup().addTo(map);
  layerGroups.spill = L.layerGroup().addTo(map);
  layerGroups.tracks = L.layerGroup().addTo(map);
  layerGroups.replay = L.layerGroup().addTo(map);

  // Draw 15 km Search Radius Circle
  const searchRadiusMeters = 15000;
  L.circle([s.latitude, s.longitude], {
    radius: searchRadiusMeters,
    color: '#0284c7',
    weight: 1.5,
    dashArray: '6, 6',
    fillColor: '#38bdf8',
    fillOpacity: 0.08
  }).bindTooltip('15 km Investigation Perimeter', { direction: 'top' }).addTo(layerGroups.radius);

  // Draw Spill Polygon if available
  if (s.polygon && s.polygon.length > 2) {
    L.polygon(s.polygon, {
      color: '#dc2626',
      weight: 2,
      dashArray: '4, 4',
      fillColor: '#ef4444',
      fillOpacity: 0.25
    }).bindPopup(`<b>Estimated Slick Extent</b><br>Area: ${s.area} ${s.area_unit}<br>Confidence: ${Math.round(s.confidence * 100)}%`).addTo(layerGroups.spill);
  }

  // Draw Spill Origin Custom Marker
  const spillIcon = L.divIcon({
    className: 'custom-spill-div-icon',
    html: '<div class="spill-origin-pulse"></div>',
    iconSize: [24, 24],
    iconAnchor: [12, 12]
  });

  L.marker([s.latitude, s.longitude], { icon: spillIcon })
    .bindPopup(`<b>🛢️ Estimated Spill Origin</b><br>Lat: ${s.latitude.toFixed(4)}°, Lon: ${s.longitude.toFixed(4)}°<br>Acquisition: ${s.timestamp.replace('T', ' ').replace('Z', ' UTC')}`)
    .addTo(layerGroups.spill);

  // Draw Vessel Tracks on Map
  drawVesselTracks(c, t);

  // Draw Initial Replay Position
  updateReplayPosition();
}

// --------------------------------------------------------------------------
// 4. Vessel Tracks Drawing on Leaflet Map
// --------------------------------------------------------------------------
function drawVesselTracks(candidatesList, tracksDict) {
  if (!layerGroups.tracks) return;
  layerGroups.tracks.clearLayers();
  trackLayers = {};
  vesselMarkers = {};

  const showLabels = $('#layer-labels') ? $('#layer-labels').checked : true;

  candidatesList.forEach(c => {
    const p = tracksDict[c.vessel_id];
    if (!p || !p.length) return;

    const isSelected = (c.vessel_id === selected);
    const color = c.risk === 'HIGH' ? '#dc2626' : c.risk === 'MEDIUM' ? '#d97706' : '#16a34a';
    const latLngs = p.map(pt => [pt.latitude, pt.longitude]);

    // Polyline Track
    const polyline = L.polyline(latLngs, {
      color: color,
      weight: isSelected ? 4.5 : 2,
      opacity: isSelected ? 1.0 : 0.45,
      lineCap: 'round',
      lineJoin: 'round'
    });

    polyline.on('click', () => pick(c.vessel_id));
    polyline.addTo(layerGroups.tracks);
    trackLayers[c.vessel_id] = polyline;

    // Track Waypoint Dots for Selected Vessel
    if (isSelected) {
      p.forEach((pt, idx) => {
        const dot = L.circleMarker([pt.latitude, pt.longitude], {
          radius: 3.5,
          color: '#0284c7',
          fillColor: '#ffffff',
          fillOpacity: 1,
          weight: 1.5
        }).bindTooltip(`<b>${esc(c.vessel_name)}</b><br>Passage: ${pt.timestamp.replace('T', ' ').replace('Z', ' UTC')}<br>Speed: ${pt.speed.toFixed(1)} kn · Heading: ${pt.heading.toFixed(0)}°`);
        dot.addTo(layerGroups.tracks);
      });
    }

    // Endpoint Marker
    const last = p[p.length - 1];
    const marker = L.circleMarker([last.latitude, last.longitude], {
      radius: isSelected ? 6.5 : 4.5,
      color: '#061325',
      weight: 1.5,
      fillColor: color,
      fillOpacity: 1
    });

    if (showLabels || isSelected) {
      marker.bindTooltip(`<b>${esc(c.vessel_name)}</b> (${c.risk})`, {
        permanent: isSelected || showLabels,
        direction: 'top',
        className: `gis-tooltip-${c.risk.toLowerCase()}`
      });
    }

    marker.on('click', () => pick(c.vessel_id));
    marker.addTo(layerGroups.tracks);
    vesselMarkers[c.vessel_id] = marker;
  });
}

// --------------------------------------------------------------------------
// 5. Update Replay Position on Map
// --------------------------------------------------------------------------
function updateReplayPosition() {
  if (!layerGroups.replay || !tracks || !selected || !tracks[selected]) return;
  layerGroups.replay.clearLayers();

  const stepIdx = +$('#time').value;
  const p = tracks[selected][stepIdx] || tracks[selected][0];

  const replayIcon = L.divIcon({
    className: 'custom-replay-marker',
    html: '<div class="replay-marker-icon" style="width: 14px; height: 14px;"></div>',
    iconSize: [14, 14],
    iconAnchor: [7, 7]
  });

  const replayMarker = L.marker([p.latitude, p.longitude], { icon: replayIcon, zIndexOffset: 1000 })
    .bindTooltip(`<b>REPLAY: ${esc(p.vessel_name)}</b><br>${p.speed.toFixed(1)} kn · ${p.heading.toFixed(0)}°<br>${p.timestamp.replace('T', ' ').replace('Z', ' UTC')}`, {
      permanent: false,
      direction: 'right'
    })
    .addTo(layerGroups.replay);

  // Update Replay Telemetry Bar
  if ($('#stamp')) {
    $('#stamp').textContent = p.timestamp.replace('T', ' ').replace('Z', ' UTC');
  }
  if ($('#current-step')) {
    $('#current-step').textContent = stepIdx + 1;
  }
  if ($('#total-steps')) {
    $('#total-steps').textContent = tracks[selected].length;
  }
}

// --------------------------------------------------------------------------
// 6. Main UI Render (Table & Evidence Breakdown)
// --------------------------------------------------------------------------
function render() {
  const tbody = $('#rows');
  const evidenceContainer = $('#evidence');

  if (!candidates || !candidates.length) {
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 32px 16px; font-size: 13px;">Awaiting Attribution Rank. Click <b>"⚡ Run Investigation"</b> or Step 4 above.</td></tr>`;
    }
    if (evidenceContainer) {
      evidenceContainer.innerHTML = `<div style="text-align: center; color: var(--text-muted); padding: 40px 16px; font-size: 13px;">Forensic evidence decomposition will appear once Attribution Rank executes.</div>`;
    }
    return;
  }

  // Update Column Header Sort Indicators
  document.querySelectorAll('th[data-k]').forEach(th => {
    const arrow = th.querySelector('.sort-arrow');
    if (arrow) {
      arrow.textContent = (th.dataset.k === sortKey) ? (asc ? '▲' : '▼') : '';
    }
  });

  // Sort candidate list
  const ordered = [...candidates].sort((a, b) => {
    let v = a[sortKey], w = b[sortKey];
    return (v > w ? 1 : v < w ? -1 : 0) * (asc ? 1 : -1);
  });

  // Render Table Rows
  tbody.innerHTML = ordered.map(c => {
    const originalRank = c.rank || (candidates.indexOf(c) + 1);
    const isSelected = c.vessel_id === selected;
    const isTop = originalRank === 1;

    return `
      <tr class="${isSelected ? 'selected-vessel' : ''} ${isTop ? 'top-ranked' : ''}" onclick="pick('${c.vessel_id}')">
        <td><span class="rank-badge ${isTop ? 'gold' : ''}">#${originalRank}</span></td>
        <td>
          <span class="vessel-cell-title">${esc(c.vessel_name)}</span>
          <span class="vessel-cell-id">${c.vessel_id}</span>
        </td>
        <td><b style="color: ${c.risk === 'HIGH' ? 'var(--risk-high)' : c.risk === 'MEDIUM' ? 'var(--risk-med)' : 'var(--risk-low)'}; font-size: 13.5px;">${c.final_score}</b><span style="color: var(--text-muted); font-size: 10px;">/100</span></td>
        <td><span class="risk-tag ${c.risk}">${c.risk}</span></td>
        <td>${c.closest_distance_km.toFixed(1)} km</td>
        <td>${c.time_gap_minutes.toFixed(0)} min</td>
        <td>${c.track_alignment.toFixed(0)}%</td>
      </tr>
    `;
  }).join('');

  // Render Evidence & Score Decomposition Panel
  const c = candidates.find(x => x.vessel_id === selected) || candidates[0];
  const b = c.score_breakdown;
  const rankNum = c.rank || (candidates.indexOf(c) + 1);
  const isTopCandidate = (c.is_top_candidate || rankNum === 1);

  const distPts = (b.distance * 0.30).toFixed(1);
  const timePts = (b.time * 0.25).toFixed(1);
  const trackPts = (b.track_alignment * 0.20).toFixed(1);
  const speedPts = (b.speed * 0.10).toFixed(1);
  const aisPts = (b.ais_behavior * 0.15).toFixed(1);

  $('#evidence').innerHTML = `
    <div class="evidence-hero-box">
      <div class="vessel-hero-summary">
        ${isTopCandidate ? '<div class="top-candidate-badge">★ TOP CANDIDATE (INVESTIGATIVE PRIORITIZATION ONLY)</div>' : ''}
        <h3>${esc(c.vessel_name)} <span class="risk-tag ${c.risk}">${c.risk} RISK</span></h3>
        <div class="vessel-telemetry">Rank #${rankNum} · IMO: ${c.vessel_id} · Speed: ${c.speed.toFixed(1)} kn · Heading: ${c.heading.toFixed(0)}°</div>
      </div>
      <div class="score-hero-block">
        <div class="score-hero-digits">${c.final_score}<span class="score-hero-max">/100</span></div>
        <div class="score-hero-caption">Attribution Score</div>
      </div>
    </div>

    <div class="findings-box">
      <div class="findings-box-heading">📌 Key Attribution Findings</div>
      <ul class="findings-list">
        ${c.reasons.map(r => `
          <li class="finding-row">
            <span class="finding-bullet">▸</span>
            <span>${esc(r)}</span>
          </li>
        `).join('')}
      </ul>
      ${c.ais_flags && c.ais_flags.length ? `
        <div class="ais-tags-row">
          ${c.ais_flags.map(f => `<span class="ais-anomaly-tag">⚠️ ${esc(f)}</span>`).join('')}
        </div>
      ` : ''}
    </div>

    <div class="score-meters-box">
      <div class="meters-title">📊 Multi-Factor Score Decomposition</div>
      <div class="meter-list">
        
        <div class="meter-row">
          <div class="meter-meta">
            <span class="meter-name">Distance Proximity <span class="meter-weight-tag">(30% max)</span></span>
            <span class="meter-score-val">${distPts} / 30.0</span>
          </div>
          <div class="meter-base-bar">
            <div class="meter-bar-progress" style="width: ${(distPts / 30.0 * 100).toFixed(1)}%;"></div>
          </div>
        </div>

        <div class="meter-row">
          <div class="meter-meta">
            <span class="meter-name">Temporal Proximity <span class="meter-weight-tag">(25% max)</span></span>
            <span class="meter-score-val">${timePts} / 25.0</span>
          </div>
          <div class="meter-base-bar">
            <div class="meter-bar-progress" style="width: ${(timePts / 25.0 * 100).toFixed(1)}%;"></div>
          </div>
        </div>

        <div class="meter-row">
          <div class="meter-meta">
            <span class="meter-name">Track Alignment <span class="meter-weight-tag">(20% max)</span></span>
            <span class="meter-score-val">${trackPts} / 20.0</span>
          </div>
          <div class="meter-base-bar">
            <div class="meter-bar-progress" style="width: ${(trackPts / 20.0 * 100).toFixed(1)}%;"></div>
          </div>
        </div>

        <div class="meter-row">
          <div class="meter-meta">
            <span class="meter-name">Speed Consistency <span class="meter-weight-tag">(10% max)</span></span>
            <span class="meter-score-val">${speedPts} / 10.0</span>
          </div>
          <div class="meter-base-bar">
            <div class="meter-bar-progress" style="width: ${(speedPts / 10.0 * 100).toFixed(1)}%;"></div>
          </div>
        </div>

        <div class="meter-row">
          <div class="meter-meta">
            <span class="meter-name">AIS Behavioral Anomaly <span class="meter-weight-tag">(15% max)</span></span>
            <span class="meter-score-val">${aisPts} / 15.0</span>
          </div>
          <div class="meter-base-bar">
            <div class="meter-bar-progress anomaly-bar" style="width: ${(aisPts / 15.0 * 100).toFixed(1)}%;"></div>
          </div>
        </div>

      </div>
    </div>
  `;

  // Synchronize Map Tracks Highlighting
  if (map && layerGroups.tracks) {
    drawVesselTracks(candidates, tracks);
    updateReplayPosition();
  }
}

// --------------------------------------------------------------------------
// 7. Vessel Selection Function (pick)
// --------------------------------------------------------------------------
function pick(id) {
  if (!tracks[id]) return;
  selected = id;

  if ($('#vessel')) {
    $('#vessel').value = id;
  }
  if ($('#time')) {
    $('#time').max = tracks[id].length - 1;
    $('#time').value = 0;
  }

  pauseReplay();
  render();
}
window.pick = pick;

// --------------------------------------------------------------------------
// 8. Event Listeners Initialization
// --------------------------------------------------------------------------
function initEventListeners() {
  // Workflow Control Actions
  if ($('#btn-run-workflow')) {
    $('#btn-run-workflow').onclick = () => runFullInvestigation();
  }

  if ($('#btn-reset-workflow')) {
    $('#btn-reset-workflow').onclick = () => resetInvestigation();
  }

  // Workflow Step Pills
  for (let i = 1; i <= 4; i++) {
    const pill = $(`#wf-step-${i}`);
    if (pill) {
      pill.onclick = () => runWorkflowStep(i);
    }
  }

  // Table Sorting Handlers
  document.querySelectorAll('th[data-k]').forEach(th => {
    th.onclick = () => {
      asc = (sortKey === th.dataset.k) ? !asc : false;
      sortKey = th.dataset.k;
      render();
    };
  });

  // Basemap Switcher Buttons
  const basemapButtons = document.querySelectorAll('.btn-basemap');
  basemapButtons.forEach(btn => {
    btn.onclick = () => {
      basemapButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const bmType = btn.dataset.bm;

      if (map && basemaps[bmType]) {
        if (currentBasemap) {
          map.removeLayer(currentBasemap);
        }
        currentBasemap = basemaps[bmType].addTo(map);
      }
    };
  });

  // Layer Toggles
  if ($('#layer-radius')) {
    $('#layer-radius').onchange = e => {
      if (layerGroups.radius) {
        if (e.target.checked) map.addLayer(layerGroups.radius);
        else map.removeLayer(layerGroups.radius);
      }
    };
  }

  if ($('#layer-spill')) {
    $('#layer-spill').onchange = e => {
      if (layerGroups.spill) {
        if (e.target.checked) map.addLayer(layerGroups.spill);
        else map.removeLayer(layerGroups.spill);
      }
    };
  }

  if ($('#layer-tracks')) {
    $('#layer-tracks').onchange = e => {
      if (layerGroups.tracks) {
        if (e.target.checked) map.addLayer(layerGroups.tracks);
        else map.removeLayer(layerGroups.tracks);
      }
    };
  }

  if ($('#layer-labels')) {
    $('#layer-labels').onchange = () => {
      drawVesselTracks(candidates, tracks);
    };
  }

  // Focus & Overview Action Buttons
  if ($('#btn-focus-spill')) {
    $('#btn-focus-spill').onclick = () => {
      if (map && spill) {
        map.flyTo([spill.latitude, spill.longitude], 12, { duration: 1.2 });
      }
    };
  }

  if ($('#btn-world-view')) {
    $('#btn-world-view').onclick = () => {
      if (map) {
        map.flyTo([20, 40], 2.5, { duration: 1.5 });
      }
    };
  }

  // AIS Replay Controls
  if ($('#vessel')) {
    $('#vessel').onchange = e => pick(e.target.value);
  }

  if ($('#time')) {
    $('#time').oninput = () => updateReplayPosition();
  }

  if ($('#btn-step-prev')) {
    $('#btn-step-prev').onclick = () => {
      pauseReplay();
      let i = +$('#time').value;
      if (i > 0) {
        $('#time').value = i - 1;
        updateReplayPosition();
      }
    };
  }

  if ($('#btn-step-next')) {
    $('#btn-step-next').onclick = () => {
      pauseReplay();
      let i = +$('#time').value;
      let max = +$('#time').max;
      if (i < max) {
        $('#time').value = i + 1;
        updateReplayPosition();
      }
    };
  }

  if ($('#play')) {
    $('#play').onclick = () => {
      if (timer) {
        pauseReplay();
      } else {
        if (+$('#time').value >= +$('#time').max) {
          $('#time').value = 0;
        }
        startReplay();
      }
    };
  }

  // Speed Buttons
  const speedBtns = document.querySelectorAll('.btn-speed');
  speedBtns.forEach(btn => {
    btn.onclick = () => {
      speedBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      replayIntervalMs = parseInt(btn.dataset.speed, 10);
      if (timer) {
        startReplay();
      }
    };
  });
}

// --------------------------------------------------------------------------
// 9. AIS Replay Playback Timer
// --------------------------------------------------------------------------
function startReplay() {
  clearInterval(timer);
  const playBtn = $('#play');
  if (playBtn) {
    playBtn.textContent = '⏸ Pause';
    playBtn.classList.add('active');
  }

  timer = setInterval(() => {
    let i = +$('#time').value;
    let max = +$('#time').max;
    if (i >= max) {
      pauseReplay();
    } else {
      $('#time').value = i + 1;
      updateReplayPosition();
    }
  }, replayIntervalMs);
}

function pauseReplay() {
  clearInterval(timer);
  timer = null;
  const playBtn = $('#play');
  if (playBtn) {
    playBtn.textContent = '▶ Play';
    playBtn.classList.remove('active');
  }
}

async function uploadSARImage() {
  const input = $('#sar-upload-input');
  const button = $('#btn-upload-detect');
  const box = $('#upload-result');
  if (!input || !box) return;
  const file = input.files && input.files[0];
  if (!file) { setNotice('Choose a .tif/.tiff file before running detection.', true); return; }
  if (!/\.tiff?$/i.test(file.name)) { setNotice('Unsupported file type. Please upload a .tif or .tiff image.', true); return; }
  const formData = new FormData();
  formData.append('file', file);
  if (button) { button.disabled = true; button.textContent = 'Processing...'; }
  try {
    const res = await fetch(apiUrl('/api/detect-image'), { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || 'Detection request failed.');
    renderUploadResult(data);
    spill = Object.assign({}, spill || {}, { detector_status: data.detector_status, confidence: data.confidence, detector_confidence: data.confidence, detected_pixels: data.mask_pixels, area: data.spill_area, area_unit: data.spill_area.includes('km²') ? 'km²' : 'pixels' });
    renderDetectionEngine(spill);
    setNotice('Uploaded ' + file.name + ': ' + data.detector_status.replace(/_/g, ' ') + '. ' + (data.spill_area ? 'Area: ' + data.spill_area : ''));
  } catch (err) {
    renderUploadResult({ error: err.message });
    setNotice(err.message, true);
  } finally {
    if (button) { button.disabled = false; button.textContent = 'Run Detector'; }
  }
}

function renderUploadResult(result) {
  const container = $('#upload-result');
  if (!container) return;

  if (result.error) {
    container.innerHTML = `<div class="upload-error">${esc(result.error)}</div>`;
    return;
  }

  const status = (result.detector_status || 'UNKNOWN').replace(/_/g, ' ').toUpperCase();
  const areaText = result.spill_area ? `${result.spill_area}` : 'N/A';
  const confidenceText = result.confidence != null ? `${Math.round(result.confidence * 100)}%` : 'N/A';

  container.innerHTML = `
    <div class="upload-preview-grid">
      <div class="upload-preview-card">
        <div class="upload-preview-header">Original Uploaded Image</div>
        <img src="${result.original_image || ''}" alt="Original SAR upload" />
      </div>
      <div class="upload-preview-card">
        <div class="upload-preview-header">Detected Oil-Spill Mask</div>
        <img src="${result.mask_image || ''}" alt="Detected oil spill mask" />
      </div>
    </div>
    <div class="upload-metadata">
      <div><span>Status</span><strong>${esc(status)}</strong></div>
      <div><span>Spill Area</span><strong>${esc(areaText)}</strong></div>
      <div><span>Contrast Score</span><strong>${result.contrast_score != null ? Number(result.contrast_score).toFixed(3) : 'N/A'}</strong></div>
      <div><span>Confidence</span><strong>${esc(confidenceText)}</strong></div>
      <div><span>Mask Pixels</span><strong>${Number(result.mask_pixels || 0).toLocaleString()}</strong></div>
    </div>
  `;
}

async function initInvestigation() {
  try {
    const [state, cand, trk] = await Promise.all([
      fetch(apiUrl('/api/state')).then(r => r.json()),
      fetch(apiUrl('/api/candidates')).then(r => r.json()),
      fetch(apiUrl('/api/tracks')).then(r => r.json())
    ]);

    spill = state.spill;
    candidates = cand;
    tracks = trk;
    currentStage = state.stage || 'VESSELS_RANKED';
    selected = candidates[0] ? candidates[0].vessel_id : Object.keys(tracks)[0];

    // Initialize Leaflet Map
    initLeafletMap(spill, candidates, tracks);

    // Setup Event Listeners
    initEventListeners();

    // Synchronize UI
    await syncUIWithSession(state);
  } catch (err) {
    console.error('Error initializing investigation:', err);
    setNotice(`Backend communication failure: Ensure backend is running at ${API_BASE_URL}`, true);
  }
}

// Start application
initInvestigation();

// --------------------------------------------------------------------------
// 2. KPI Cards Rendering
// --------------------------------------------------------------------------
function renderKPICards(s, stage = currentStage) {
  const infoContainer = $('#info');
  if (!infoContainer) return;

  const isIngested = stage && stage !== 'NOT_STARTED';
  const isDetected = stage && ['SLICK_DETECTED', 'AIS_CORRELATED', 'VESSELS_RANKED'].includes(stage);

  const kpis = [
    {
      title: 'Spill Location',
      val: isDetected ? `${s.latitude.toFixed(4)}° N, ${s.longitude.toFixed(4)}° E` : (isIngested ? '18.9524° N, 72.8837° E' : 'Pending Ingest'),
      sub: 'Geographic Origin Anchor (DEMO)',
      symbol: '🎯'
    },
    {
      title: 'Spill Area',
      val: isDetected ? `${s.area} ${s.area_unit}` : (isIngested ? 'Awaiting Mask' : 'Pending Ingest'),
      sub: isDetected ? 'Cleaned Spatial Mask Extent' : 'Detection Mask Extent',
      symbol: '📐'
    },
    {
      title: 'Detection Confidence',
      val: isDetected ? `${Math.round(s.confidence * 100)}%` : (isIngested ? 'Awaiting Mask' : 'Pending Ingest'),
      sub: 'SAR Multi-Feature Composite',
      symbol: '🛡️',
      hasBar: isDetected,
      pct: isDetected ? Math.round(s.confidence * 100) : 0
    },
    {
      title: 'Detection Time',
      val: isIngested ? s.timestamp.replace('T', ' ').replace('Z', ' UTC') : 'Pending Ingest',
      sub: 'Sentinel-1 SAR Acquisition',
      symbol: '⏱️'
    }
  ];

  infoContainer.innerHTML = kpis.map(item => `
    <div class="kpi-card-white">
      <div class="kpi-card-head">
        <span class="kpi-card-label">${item.title}</span>
        <span class="kpi-card-symbol">${item.symbol}</span>
      </div>
      <div class="kpi-card-number">${item.val}</div>
      <div class="kpi-card-footnote">${item.sub}</div>
      ${item.hasBar ? `<div class="kpi-confidence-track"><div class="kpi-confidence-fill" style="width: ${item.pct}%;"></div></div>` : ''}
    </div>
  `).join('');
}
// --------------------------------------------------------------------------
// 2B. Detection Engine Output
// --------------------------------------------------------------------------
function renderDetectionEngine(s) {
  const container = $('#detection-engine');
  if (!container) return;

  const confidence = s.detector_confidence != null
    ? Math.round(s.detector_confidence * 100)
    : null;

  const shape = s.shape_score != null
    ? Math.round(s.shape_score * 100)
    : null;

  const area = s.area_score != null
    ? Math.round(s.area_score * 100)
    : null;

  const fallback = s.fallback_used ? 'YES' : 'NO';

  container.innerHTML = `
    <div class="detection-metric">
      <span class="detection-metric-label">DETECTOR STATUS</span>
      <strong>${esc((s.detector_status || 'UNKNOWN').replace(/_/g, ' ').toUpperCase())}</strong>
    </div>

    <div class="detection-metric">
      <span class="detection-metric-label">PROTOTYPE CONFIDENCE</span>
      <strong>${confidence != null ? confidence + '%' : 'N/A'}</strong>
      <div class="detection-mini-track">
        <div style="width:${confidence != null ? confidence : 0}%"></div>
      </div>
    </div>

    <div class="detection-metric">
      <span class="detection-metric-label">DETECTED PIXELS</span>
      <strong>${Number(s.detected_pixels || 0).toLocaleString()}</strong>
    </div>

    <div class="detection-metric">
      <span class="detection-metric-label">SHAPE SCORE</span>
      <strong>${shape != null ? shape + '%' : 'N/A'}</strong>
    </div>

    <div class="detection-metric">
      <span class="detection-metric-label">AREA SCORE</span>
      <strong>${area != null ? area + '%' : 'N/A'}</strong>
    </div>

    <div class="detection-metric">
      <span class="detection-metric-label">SENSITIVITY</span>
      <strong>${s.detection_sensitivity != null ? s.detection_sensitivity.toFixed(2) : 'N/A'}</strong>
    </div>

    <div class="detection-metric">
      <span class="detection-metric-label">FALLBACK MASK</span>
      <strong>${fallback}</strong>
    </div>

    <div class="detection-metric">
      <span class="detection-metric-label">CENTROID</span>
      <strong>${s.centroid_pixel
        ? `[${s.centroid_pixel[0].toFixed(1)}, ${s.centroid_pixel[1].toFixed(1)}]`
        : 'N/A'}</strong>
      <small>Pixel coordinates</small>
    </div>
  `;
}

// --------------------------------------------------------------------------
// 3. Leaflet GIS Map Initialization
// --------------------------------------------------------------------------
function initLeafletMap(s, c, t) {
  if (typeof L === 'undefined') {
    console.error('Leaflet library is not loaded');
    return;
  }

  // Initialize Map Instance centered on investigation area
  map = L.map('gis-map-viewport', {
    center: [s.latitude, s.longitude],
    zoom: 11,
    minZoom: 2,
    maxZoom: 18,
    zoomControl: true,
    attributionControl: true
  });

  // Define Legitimate Basemap Providers
  basemaps = {
    light: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19
    }),
    sat: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      attribution: 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, GIS Community',
      maxZoom: 18
    })
  };

  // Add Default Basemap (Map)
  currentBasemap = basemaps.light.addTo(map);

  // Initialize Layer Groups
  layerGroups.radius = L.layerGroup().addTo(map);
  layerGroups.spill = L.layerGroup().addTo(map);
  layerGroups.tracks = L.layerGroup().addTo(map);
  layerGroups.replay = L.layerGroup().addTo(map);

  // Draw 15 km Search Radius Circle
  const searchRadiusMeters = 15000;
  L.circle([s.latitude, s.longitude], {
    radius: searchRadiusMeters,
    color: '#0284c7',
    weight: 1.5,
    dashArray: '6, 6',
    fillColor: '#38bdf8',
    fillOpacity: 0.08
  }).bindTooltip('15 km Investigation Perimeter', { direction: 'top' }).addTo(layerGroups.radius);

  // Draw Spill Polygon if available
  if (s.polygon && s.polygon.length > 2) {
    L.polygon(s.polygon, {
      color: '#dc2626',
      weight: 2,
      dashArray: '4, 4',
      fillColor: '#ef4444',
      fillOpacity: 0.25
    }).bindPopup(`<b>Estimated Slick Extent</b><br>Area: ${s.area} ${s.area_unit}<br>Confidence: ${Math.round(s.confidence * 100)}%`).addTo(layerGroups.spill);
  }

  // Draw Spill Origin Custom Marker
  const spillIcon = L.divIcon({
    className: 'custom-spill-div-icon',
    html: '<div class="spill-origin-pulse"></div>',
    iconSize: [24, 24],
    iconAnchor: [12, 12]
  });

  L.marker([s.latitude, s.longitude], { icon: spillIcon })
    .bindPopup(`<b>🛢️ Estimated Spill Origin</b><br>Lat: ${s.latitude.toFixed(4)}°, Lon: ${s.longitude.toFixed(4)}°<br>Acquisition: ${s.timestamp.replace('T', ' ').replace('Z', ' UTC')}`)
    .addTo(layerGroups.spill);

  // Draw Vessel Tracks on Map
  drawVesselTracks(c, t);

  // Draw Initial Replay Position
  updateReplayPosition();
}

// --------------------------------------------------------------------------
// 4. Vessel Tracks Drawing on Leaflet Map
// --------------------------------------------------------------------------
function drawVesselTracks(candidatesList, tracksDict) {
  if (!layerGroups.tracks) return;
  layerGroups.tracks.clearLayers();
  trackLayers = {};
  vesselMarkers = {};

  const showLabels = $('#layer-labels') ? $('#layer-labels').checked : true;

  candidatesList.forEach(c => {
    const p = tracksDict[c.vessel_id];
    if (!p || !p.length) return;

    const isSelected = (c.vessel_id === selected);
    const color = c.risk === 'HIGH' ? '#dc2626' : c.risk === 'MEDIUM' ? '#d97706' : '#16a34a';
    const latLngs = p.map(pt => [pt.latitude, pt.longitude]);

    // Polyline Track
    const polyline = L.polyline(latLngs, {
      color: color,
      weight: isSelected ? 4.5 : 2,
      opacity: isSelected ? 1.0 : 0.45,
      lineCap: 'round',
      lineJoin: 'round'
    });

    polyline.on('click', () => pick(c.vessel_id));
    polyline.addTo(layerGroups.tracks);
    trackLayers[c.vessel_id] = polyline;

    // Track Waypoint Dots for Selected Vessel
    if (isSelected) {
      p.forEach((pt, idx) => {
        const dot = L.circleMarker([pt.latitude, pt.longitude], {
          radius: 3.5,
          color: '#0284c7',
          fillColor: '#ffffff',
          fillOpacity: 1,
          weight: 1.5
        }).bindTooltip(`<b>${esc(c.vessel_name)}</b><br>Passage: ${pt.timestamp.replace('T', ' ').replace('Z', ' UTC')}<br>Speed: ${pt.speed.toFixed(1)} kn · Heading: ${pt.heading.toFixed(0)}°`);
        dot.addTo(layerGroups.tracks);
      });
    }

    // Endpoint Marker
    const last = p[p.length - 1];
    const marker = L.circleMarker([last.latitude, last.longitude], {
      radius: isSelected ? 6.5 : 4.5,
      color: '#061325',
      weight: 1.5,
      fillColor: color,
      fillOpacity: 1
    });

    if (showLabels || isSelected) {
      marker.bindTooltip(`<b>${esc(c.vessel_name)}</b> (${c.risk})`, {
        permanent: isSelected || showLabels,
        direction: 'top',
        className: `gis-tooltip-${c.risk.toLowerCase()}`
      });
    }

    marker.on('click', () => pick(c.vessel_id));
    marker.addTo(layerGroups.tracks);
    vesselMarkers[c.vessel_id] = marker;
  });
}

// --------------------------------------------------------------------------
// 5. Update Replay Position on Map
// --------------------------------------------------------------------------
function updateReplayPosition() {
  if (!layerGroups.replay || !tracks || !selected || !tracks[selected]) return;
  layerGroups.replay.clearLayers();

  const stepIdx = +$('#time').value;
  const p = tracks[selected][stepIdx] || tracks[selected][0];

  const replayIcon = L.divIcon({
    className: 'custom-replay-marker',
    html: '<div class="replay-marker-icon" style="width: 14px; height: 14px;"></div>',
    iconSize: [14, 14],
    iconAnchor: [7, 7]
  });

  const replayMarker = L.marker([p.latitude, p.longitude], { icon: replayIcon, zIndexOffset: 1000 })
    .bindTooltip(`<b>REPLAY: ${esc(p.vessel_name)}</b><br>${p.speed.toFixed(1)} kn · ${p.heading.toFixed(0)}°<br>${p.timestamp.replace('T', ' ').replace('Z', ' UTC')}`, {
      permanent: false,
      direction: 'right'
    })
    .addTo(layerGroups.replay);

  // Update Replay Telemetry Bar
  if ($('#stamp')) {
    $('#stamp').textContent = p.timestamp.replace('T', ' ').replace('Z', ' UTC');
  }
  if ($('#current-step')) {
    $('#current-step').textContent = stepIdx + 1;
  }
  if ($('#total-steps')) {
    $('#total-steps').textContent = tracks[selected].length;
  }
}

// --------------------------------------------------------------------------
// 6. Main UI Render (Table & Evidence Breakdown)
// --------------------------------------------------------------------------
function render() {
  const tbody = $('#rows');
  const evidenceContainer = $('#evidence');

  if (!candidates || !candidates.length) {
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 32px 16px; font-size: 13px;">Awaiting Attribution Rank. Click <b>"⚡ Run Investigation"</b> or Step 4 above.</td></tr>`;
    }
    if (evidenceContainer) {
      evidenceContainer.innerHTML = `<div style="text-align: center; color: var(--text-muted); padding: 40px 16px; font-size: 13px;">Forensic evidence decomposition will appear once Attribution Rank executes.</div>`;
    }
    return;
  }

  // Update Column Header Sort Indicators
  document.querySelectorAll('th[data-k]').forEach(th => {
    const arrow = th.querySelector('.sort-arrow');
    if (arrow) {
      arrow.textContent = (th.dataset.k === sortKey) ? (asc ? '▲' : '▼') : '';
    }
  });

  // Sort candidate list
  const ordered = [...candidates].sort((a, b) => {
    let v = a[sortKey], w = b[sortKey];
    return (v > w ? 1 : v < w ? -1 : 0) * (asc ? 1 : -1);
  });

  // Render Table Rows
  tbody.innerHTML = ordered.map(c => {
    const originalRank = c.rank || (candidates.indexOf(c) + 1);
    const isSelected = c.vessel_id === selected;
    const isTop = originalRank === 1;

    return `
      <tr class="${isSelected ? 'selected-vessel' : ''} ${isTop ? 'top-ranked' : ''}" onclick="pick('${c.vessel_id}')">
        <td><span class="rank-badge ${isTop ? 'gold' : ''}">#${originalRank}</span></td>
        <td>
          <span class="vessel-cell-title">${esc(c.vessel_name)}</span>
          <span class="vessel-cell-id">${c.vessel_id}</span>
        </td>
        <td><b style="color: ${c.risk === 'HIGH' ? 'var(--risk-high)' : c.risk === 'MEDIUM' ? 'var(--risk-med)' : 'var(--risk-low)'}; font-size: 13.5px;">${c.final_score}</b><span style="color: var(--text-muted); font-size: 10px;">/100</span></td>
        <td><span class="risk-tag ${c.risk}">${c.risk}</span></td>
        <td>${c.closest_distance_km.toFixed(1)} km</td>
        <td>${c.time_gap_minutes.toFixed(0)} min</td>
        <td>${c.track_alignment.toFixed(0)}%</td>
      </tr>
    `;
  }).join('');

  // Render Evidence & Score Decomposition Panel
  const c = candidates.find(x => x.vessel_id === selected) || candidates[0];
  const b = c.score_breakdown;
  const rankNum = c.rank || (candidates.indexOf(c) + 1);
  const isTopCandidate = (c.is_top_candidate || rankNum === 1);

  const distPts = (b.distance * 0.30).toFixed(1);
  const timePts = (b.time * 0.25).toFixed(1);
  const trackPts = (b.track_alignment * 0.20).toFixed(1);
  const speedPts = (b.speed * 0.10).toFixed(1);
  const aisPts = (b.ais_behavior * 0.15).toFixed(1);

  $('#evidence').innerHTML = `
    <div class="evidence-hero-box">
      <div class="vessel-hero-summary">
        ${isTopCandidate ? '<div class="top-candidate-badge">★ TOP CANDIDATE (INVESTIGATIVE PRIORITIZATION ONLY)</div>' : ''}
        <h3>${esc(c.vessel_name)} <span class="risk-tag ${c.risk}">${c.risk} RISK</span></h3>
        <div class="vessel-telemetry">Rank #${rankNum} · IMO: ${c.vessel_id} · Speed: ${c.speed.toFixed(1)} kn · Heading: ${c.heading.toFixed(0)}°</div>
      </div>
      <div class="score-hero-block">
        <div class="score-hero-digits">${c.final_score}<span class="score-hero-max">/100</span></div>
        <div class="score-hero-caption">Attribution Score</div>
      </div>
    </div>

    <div class="findings-box">
      <div class="findings-box-heading">📌 Key Attribution Findings</div>
      <ul class="findings-list">
        ${c.reasons.map(r => `
          <li class="finding-row">
            <span class="finding-bullet">▸</span>
            <span>${esc(r)}</span>
          </li>
        `).join('')}
      </ul>
      ${c.ais_flags && c.ais_flags.length ? `
        <div class="ais-tags-row">
          ${c.ais_flags.map(f => `<span class="ais-anomaly-tag">⚠️ ${esc(f)}</span>`).join('')}
        </div>
      ` : ''}
    </div>

    <div class="score-meters-box">
      <div class="meters-title">📊 Multi-Factor Score Decomposition</div>
      <div class="meter-list">
        
        <div class="meter-row">
          <div class="meter-meta">
            <span class="meter-name">Distance Proximity <span class="meter-weight-tag">(30% max)</span></span>
            <span class="meter-score-val">${distPts} / 30.0</span>
          </div>
          <div class="meter-base-bar">
            <div class="meter-bar-progress" style="width: ${(distPts / 30.0 * 100).toFixed(1)}%;"></div>
          </div>
        </div>

        <div class="meter-row">
          <div class="meter-meta">
            <span class="meter-name">Temporal Proximity <span class="meter-weight-tag">(25% max)</span></span>
            <span class="meter-score-val">${timePts} / 25.0</span>
          </div>
          <div class="meter-base-bar">
            <div class="meter-bar-progress" style="width: ${(timePts / 25.0 * 100).toFixed(1)}%;"></div>
          </div>
        </div>

        <div class="meter-row">
          <div class="meter-meta">
            <span class="meter-name">Track Alignment <span class="meter-weight-tag">(20% max)</span></span>
            <span class="meter-score-val">${trackPts} / 20.0</span>
          </div>
          <div class="meter-base-bar">
            <div class="meter-bar-progress" style="width: ${(trackPts / 20.0 * 100).toFixed(1)}%;"></div>
          </div>
        </div>

        <div class="meter-row">
          <div class="meter-meta">
            <span class="meter-name">Speed Consistency <span class="meter-weight-tag">(10% max)</span></span>
            <span class="meter-score-val">${speedPts} / 10.0</span>
          </div>
          <div class="meter-base-bar">
            <div class="meter-bar-progress" style="width: ${(speedPts / 10.0 * 100).toFixed(1)}%;"></div>
          </div>
        </div>

        <div class="meter-row">
          <div class="meter-meta">
            <span class="meter-name">AIS Behavioral Anomaly <span class="meter-weight-tag">(15% max)</span></span>
            <span class="meter-score-val">${aisPts} / 15.0</span>
          </div>
          <div class="meter-base-bar">
            <div class="meter-bar-progress anomaly-bar" style="width: ${(aisPts / 15.0 * 100).toFixed(1)}%;"></div>
          </div>
        </div>

      </div>
    </div>
  `;

  // Synchronize Map Tracks Highlighting
  if (map && layerGroups.tracks) {
    drawVesselTracks(candidates, tracks);
    updateReplayPosition();
  }
}

// --------------------------------------------------------------------------
// 7. Vessel Selection Function (pick)
// --------------------------------------------------------------------------
function pick(id) {
  if (!tracks[id]) return;
  selected = id;

  if ($('#vessel')) {
    $('#vessel').value = id;
  }
  if ($('#time')) {
    $('#time').max = tracks[id].length - 1;
    $('#time').value = 0;
  }

  pauseReplay();
  render();
}
window.pick = pick;

// --------------------------------------------------------------------------
// 8. Event Listeners Initialization
// --------------------------------------------------------------------------
function initEventListeners() {
  // Workflow Control Actions
  if ($('#btn-run-workflow')) {
    $('#btn-run-workflow').onclick = () => runFullInvestigation();
  }

  if ($('#btn-reset-workflow')) {
    $('#btn-reset-workflow').onclick = () => resetInvestigation();
  }

  // Workflow Step Pills
  for (let i = 1; i <= 4; i++) {
    const pill = $(`#wf-step-${i}`);
    if (pill) {
      pill.onclick = () => runWorkflowStep(i);
    }
  }

  // Table Sorting Handlers
  document.querySelectorAll('th[data-k]').forEach(th => {
    th.onclick = () => {
      asc = (sortKey === th.dataset.k) ? !asc : false;
      sortKey = th.dataset.k;
      render();
    };
  });

  // Basemap Switcher Buttons
  const basemapButtons = document.querySelectorAll('.btn-basemap');
  basemapButtons.forEach(btn => {
    btn.onclick = () => {
      basemapButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const bmType = btn.dataset.bm;

      if (map && basemaps[bmType]) {
        if (currentBasemap) {
          map.removeLayer(currentBasemap);
        }
        currentBasemap = basemaps[bmType].addTo(map);
      }
    };
  });

  // Layer Toggles
  if ($('#layer-radius')) {
    $('#layer-radius').onchange = e => {
      if (layerGroups.radius) {
        if (e.target.checked) map.addLayer(layerGroups.radius);
        else map.removeLayer(layerGroups.radius);
      }
    };
  }

  if ($('#layer-spill')) {
    $('#layer-spill').onchange = e => {
      if (layerGroups.spill) {
        if (e.target.checked) map.addLayer(layerGroups.spill);
        else map.removeLayer(layerGroups.spill);
      }
    };
  }

  if ($('#layer-tracks')) {
    $('#layer-tracks').onchange = e => {
      if (layerGroups.tracks) {
        if (e.target.checked) map.addLayer(layerGroups.tracks);
        else map.removeLayer(layerGroups.tracks);
      }
    };
  }

  if ($('#layer-labels')) {
    $('#layer-labels').onchange = () => {
      drawVesselTracks(candidates, tracks);
    };
  }

  // Focus & Overview Action Buttons
  if ($('#btn-focus-spill')) {
    $('#btn-focus-spill').onclick = () => {
      if (map && spill) {
        map.flyTo([spill.latitude, spill.longitude], 12, { duration: 1.2 });
      }
    };
  }

  if ($('#btn-world-view')) {
    $('#btn-world-view').onclick = () => {
      if (map) {
        map.flyTo([20, 40], 2.5, { duration: 1.5 });
      }
    };
  }

  // AIS Replay Controls
  if ($('#vessel')) {
    $('#vessel').onchange = e => pick(e.target.value);
  }

  if ($('#time')) {
    $('#time').oninput = () => updateReplayPosition();
  }

  if ($('#btn-step-prev')) {
    $('#btn-step-prev').onclick = () => {
      pauseReplay();
      let i = +$('#time').value;
      if (i > 0) {
        $('#time').value = i - 1;
        updateReplayPosition();
      }
    };
  }

  if ($('#btn-step-next')) {
    $('#btn-step-next').onclick = () => {
      pauseReplay();
      let i = +$('#time').value;
      let max = +$('#time').max;
      if (i < max) {
        $('#time').value = i + 1;
        updateReplayPosition();
      }
    };
  }

  if ($('#play')) {
    $('#play').onclick = () => {
      if (timer) {
        pauseReplay();
      } else {
        if (+$('#time').value >= +$('#time').max) {
          $('#time').value = 0;
        }
        startReplay();
      }
    };
  }

  // Speed Buttons
  const speedBtns = document.querySelectorAll('.btn-speed');
  speedBtns.forEach(btn => {
    btn.onclick = () => {
      speedBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      replayIntervalMs = parseInt(btn.dataset.speed, 10);
      if (timer) {
        startReplay();
      }
    };
  });
}

// --------------------------------------------------------------------------
// 9. AIS Replay Playback Timer
// --------------------------------------------------------------------------
function startReplay() {
  clearInterval(timer);
  const playBtn = $('#play');
  if (playBtn) {
    playBtn.textContent = '⏸ Pause';
    playBtn.classList.add('active');
  }

  timer = setInterval(() => {
    let i = +$('#time').value;
    let max = +$('#time').max;
    if (i >= max) {
      pauseReplay();
    } else {
      $('#time').value = i + 1;
      updateReplayPosition();
    }
  }, replayIntervalMs);
}

function pauseReplay() {
  clearInterval(timer);
  timer = null;
  const playBtn = $('#play');
  if (playBtn) {
    playBtn.textContent = '▶ Play';
    playBtn.classList.remove('active');
  }
}

async function uploadSARImage() {
  const input = $('#sar-upload-input');
  const button = $('#btn-upload-detect');
  const box = $('#upload-result');
  if (!input || !box) return;
  const file = input.files && input.files[0];
  if (!file) { setNotice('Choose a .tif/.tiff file before running detection.', true); return; }
  if (!/\.tiff?$/i.test(file.name)) { setNotice('Unsupported file type. Please upload a .tif or .tiff image.', true); return; }
  const formData = new FormData();
  formData.append('file', file);
  if (button) { button.disabled = true; button.textContent = 'Processing...'; }
  try {
    const res = await fetch(apiUrl('/api/detect-image'), { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || 'Detection request failed.');
    renderUploadResult(data);
    spill = Object.assign({}, spill || {}, { detector_status: data.detector_status, confidence: data.confidence, detector_confidence: data.confidence, detected_pixels: data.mask_pixels, area: data.spill_area, area_unit: data.spill_area.includes('km²') ? 'km²' : 'pixels' });
    renderDetectionEngine(spill);
    setNotice('Uploaded ' + file.name + ': ' + data.detector_status.replace(/_/g, ' ') + '. ' + (data.spill_area ? 'Area: ' + data.spill_area : ''));
  } catch (err) {
    renderUploadResult({ error: err.message });
    setNotice(err.message, true);
  } finally {
    if (button) { button.disabled = false; button.textContent = 'Run Detector'; }
  }
}

function renderUploadResult(result) {
  const container = $('#upload-result');
  if (!container) return;

  if (result.error) {
    container.innerHTML = `<div class="upload-error">${esc(result.error)}</div>`;
    return;
  }

  const status = (result.detector_status || 'UNKNOWN').replace(/_/g, ' ').toUpperCase();
  const areaText = result.spill_area ? `${result.spill_area}` : 'N/A';
  const confidenceText = result.confidence != null ? `${Math.round(result.confidence * 100)}%` : 'N/A';

  container.innerHTML = `
    <div class="upload-preview-grid">
      <div class="upload-preview-card">
        <div class="upload-preview-header">Original Uploaded Image</div>
        <img src="${result.original_image || ''}" alt="Original SAR upload" />
      </div>
      <div class="upload-preview-card">
        <div class="upload-preview-header">Detected Oil-Spill Mask</div>
        <img src="${result.mask_image || ''}" alt="Detected oil spill mask" />
      </div>
    </div>
    <div class="upload-metadata">
      <div><span>Status</span><strong>${esc(status)}</strong></div>
      <div><span>Spill Area</span><strong>${esc(areaText)}</strong></div>
      <div><span>Contrast Score</span><strong>${result.contrast_score != null ? Number(result.contrast_score).toFixed(3) : 'N/A'}</strong></div>
      <div><span>Confidence</span><strong>${esc(confidenceText)}</strong></div>
      <div><span>Mask Pixels</span><strong>${Number(result.mask_pixels || 0).toLocaleString()}</strong></div>
    </div>
  `;
}

async function initInvestigation() {
  try {
    const [state, cand, trk] = await Promise.all([
      fetch(apiUrl('/api/state')).then(r => r.json()),
      fetch(apiUrl('/api/candidates')).then(r => r.json()),
      fetch(apiUrl('/api/tracks')).then(r => r.json())
    ]);

    spill = state.spill;
    candidates = cand;
    tracks = trk;
    currentStage = state.stage || 'VESSELS_RANKED';
    selected = candidates[0] ? candidates[0].vessel_id : Object.keys(tracks)[0];

    // Initialize Leaflet Map
    initLeafletMap(spill, candidates, tracks);

    // Setup Event Listeners
    initEventListeners();

    // Synchronize UI
    await syncUIWithSession(state);
  } catch (err) {
    console.error('Error initializing investigation:', err);
    setNotice(`Backend communication failure: Ensure backend is running at ${API_BASE_URL}`, true);
  }
}

// Start application
initInvestigation();

// --------------------------------------------------------------------------
// 2. KPI Cards Rendering
// --------------------------------------------------------------------------
function renderKPICards(s, stage = currentStage) {
  const infoContainer = $('#info');
  if (!infoContainer) return;

  const isIngested = stage && stage !== 'NOT_STARTED';
  const isDetected = stage && ['SLICK_DETECTED', 'AIS_CORRELATED', 'VESSELS_RANKED'].includes(stage);

  const kpis = [
    {
      title: 'Spill Location',
      val: isDetected ? `${s.latitude.toFixed(4)}° N, ${s.longitude.toFixed(4)}° E` : (isIngested ? '18.9524° N, 72.8837° E' : 'Pending Ingest'),
      sub: 'Geographic Origin Anchor (DEMO)',
      symbol: '🎯'
    },
    {
      title: 'Spill Area',
      val: isDetected ? `${s.area} ${s.area_unit}` : (isIngested ? 'Awaiting Mask' : 'Pending Ingest'),
      sub: isDetected ? 'Cleaned Spatial Mask Extent' : 'Detection Mask Extent',
      symbol: '📐'
    },
    {
      title: 'Detection Confidence',
      val: isDetected ? `${Math.round(s.confidence * 100)}%` : (isIngested ? 'Awaiting Mask' : 'Pending Ingest'),
      sub: 'SAR Multi-Feature Composite',
      symbol: '🛡️',
      hasBar: isDetected,
      pct: isDetected ? Math.round(s.confidence * 100) : 0
    },
    {
      title: 'Detection Time',
      val: isIngested ? s.timestamp.replace('T', ' ').replace('Z', ' UTC') : 'Pending Ingest',
      sub: 'Sentinel-1 SAR Acquisition',
      symbol: '⏱️'
    }
  ];

  infoContainer.innerHTML = kpis.map(item => `
    <div class="kpi-card-white">
      <div class="kpi-card-head">
        <span class="kpi-card-label">${item.title}</span>
        <span class="kpi-card-symbol">${item.symbol}</span>
      </div>
      <div class="kpi-card-number">${item.val}</div>
      <div class="kpi-card-footnote">${item.sub}</div>
      ${item.hasBar ? `<div class="kpi-confidence-track"><div class="kpi-confidence-fill" style="width: ${item.pct}%;"></div></div>` : ''}
    </div>
  `).join('');
}
// --------------------------------------------------------------------------
// 2B. Detection Engine Output
// --------------------------------------------------------------------------
function renderDetectionEngine(s) {
  const container = $('#detection-engine');
  if (!container) return;

  const confidence = s.detector_confidence != null
    ? Math.round(s.detector_confidence * 100)
    : null;

  const shape = s.shape_score != null
    ? Math.round(s.shape_score * 100)
    : null;

  const area = s.area_score != null
    ? Math.round(s.area_score * 100)
    : null;

  const fallback = s.fallback_used ? 'YES' : 'NO';

  container.innerHTML = `
    <div class="detection-metric">
      <span class="detection-metric-label">DETECTOR STATUS</span>
      <strong>${esc((s.detector_status || 'UNKNOWN').replace(/_/g, ' ').toUpperCase())}</strong>
    </div>

    <div class="detection-metric">
      <span class="detection-metric-label">PROTOTYPE CONFIDENCE</span>
      <strong>${confidence != null ? confidence + '%' : 'N/A'}</strong>
      <div class="detection-mini-track">
        <div style="width:${confidence != null ? confidence : 0}%"></div>
      </div>
    </div>

    <div class="detection-metric">
      <span class="detection-metric-label">DETECTED PIXELS</span>
      <strong>${Number(s.detected_pixels || 0).toLocaleString()}</strong>
    </div>

    <div class="detection-metric">
      <span class="detection-metric-label">SHAPE SCORE</span>
      <strong>${shape != null ? shape + '%' : 'N/A'}</strong>
    </div>

    <div class="detection-metric">
      <span class="detection-metric-label">AREA SCORE</span>
      <strong>${area != null ? area + '%' : 'N/A'}</strong>
    </div>

    <div class="detection-metric">
      <span class="detection-metric-label">SENSITIVITY</span>
      <strong>${s.detection_sensitivity != null ? s.detection_sensitivity.toFixed(2) : 'N/A'}</strong>
    </div>

    <div class="detection-metric">
      <span class="detection-metric-label">FALLBACK MASK</span>
      <strong>${fallback}</strong>
    </div>

    <div class="detection-metric">
      <span class="detection-metric-label">CENTROID</span>
      <strong>${s.centroid_pixel
        ? `[${s.centroid_pixel[0].toFixed(1)}, ${s.centroid_pixel[1].toFixed(1)}]`
        : 'N/A'}</strong>
      <small>Pixel coordinates</small>
    </div>
  `;
}

// --------------------------------------------------------------------------
// 3. Leaflet GIS Map Initialization
// --------------------------------------------------------------------------
function initLeafletMap(s, c, t) {
  if (typeof L === 'undefined') {
    console.error('Leaflet library is not loaded');
    return;
  }

  // Initialize Map Instance centered on investigation area
  map = L.map('gis-map-viewport', {
    center: [s.latitude, s.longitude],
    zoom: 11,
    minZoom: 2,
    maxZoom: 18,
    zoomControl: true,
    attributionControl: true
  });

  // Define Legitimate Basemap Providers
  basemaps = {
    light: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19
    }),
    sat: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      attribution: 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, GIS Community',
      maxZoom: 18
    })
  };

  // Add Default Basemap (Map)
  currentBasemap = basemaps.light.addTo(map);

  // Initialize Layer Groups
  layerGroups.radius = L.layerGroup().addTo(map);
  layerGroups.spill = L.layerGroup().addTo(map);
  layerGroups.tracks = L.layerGroup().addTo(map);
  layerGroups.replay = L.layerGroup().addTo(map);

  // Draw 15 km Search Radius Circle
  const searchRadiusMeters = 15000;
  L.circle([s.latitude, s.longitude], {
    radius: searchRadiusMeters,
    color: '#0284c7',
    weight: 1.5,
    dashArray: '6, 6',
    fillColor: '#38bdf8',
    fillOpacity: 0.08
  }).bindTooltip('15 km Investigation Perimeter', { direction: 'top' }).addTo(layerGroups.radius);

  // Draw Spill Polygon if available
  if (s.polygon && s.polygon.length > 2) {
    L.polygon(s.polygon, {
      color: '#dc2626',
      weight: 2,
      dashArray: '4, 4',
      fillColor: '#ef4444',
      fillOpacity: 0.25
    }).bindPopup(`<b>Estimated Slick Extent</b><br>Area: ${s.area} ${s.area_unit}<br>Confidence: ${Math.round(s.confidence * 100)}%`).addTo(layerGroups.spill);
  }

  // Draw Spill Origin Custom Marker
  const spillIcon = L.divIcon({
    className: 'custom-spill-div-icon',
    html: '<div class="spill-origin-pulse"></div>',
    iconSize: [24, 24],
    iconAnchor: [12, 12]
  });

  L.marker([s.latitude, s.longitude], { icon: spillIcon })
    .bindPopup(`<b>🛢️ Estimated Spill Origin</b><br>Lat: ${s.latitude.toFixed(4)}°, Lon: ${s.longitude.toFixed(4)}°<br>Acquisition: ${s.timestamp.replace('T', ' ').replace('Z', ' UTC')}`)
    .addTo(layerGroups.spill);

  // Draw Vessel Tracks on Map
  drawVesselTracks(c, t);

  // Draw Initial Replay Position
  updateReplayPosition();
}

// --------------------------------------------------------------------------
// 4. Vessel Tracks Drawing on Leaflet Map
// --------------------------------------------------------------------------
function drawVesselTracks(candidatesList, tracksDict) {
  if (!layerGroups.tracks) return;
  layerGroups.tracks.clearLayers();
  trackLayers = {};
  vesselMarkers = {};

  const showLabels = $('#layer-labels') ? $('#layer-labels').checked : true;

  candidatesList.forEach(c => {
    const p = tracksDict[c.vessel_id];
    if (!p || !p.length) return;

    const isSelected = (c.vessel_id === selected);
    const color = c.risk === 'HIGH' ? '#dc2626' : c.risk === 'MEDIUM' ? '#d97706' : '#16a34a';
    const latLngs = p.map(pt => [pt.latitude, pt.longitude]);

    // Polyline Track
    const polyline = L.polyline(latLngs, {
      color: color,
      weight: isSelected ? 4.5 : 2,
      opacity: isSelected ? 1.0 : 0.45,
      lineCap: 'round',
      lineJoin: 'round'
    });

    polyline.on('click', () => pick(c.vessel_id));
    polyline.addTo(layerGroups.tracks);
    trackLayers[c.vessel_id] = polyline;

    // Track Waypoint Dots for Selected Vessel
    if (isSelected) {
      p.forEach((pt, idx) => {
        const dot = L.circleMarker([pt.latitude, pt.longitude], {
          radius: 3.5,
          color: '#0284c7',
          fillColor: '#ffffff',
          fillOpacity: 1,
          weight: 1.5
        }).bindTooltip(`<b>${esc(c.vessel_name)}</b><br>Passage: ${pt.timestamp.replace('T', ' ').replace('Z', ' UTC')}<br>Speed: ${pt.speed.toFixed(1)} kn · Heading: ${pt.heading.toFixed(0)}°`);
        dot.addTo(layerGroups.tracks);
      });
    }

    // Endpoint Marker
    const last = p[p.length - 1];
    const marker = L.circleMarker([last.latitude, last.longitude], {
      radius: isSelected ? 6.5 : 4.5,
      color: '#061325',
      weight: 1.5,
      fillColor: color,
      fillOpacity: 1
    });

    if (showLabels || isSelected) {
      marker.bindTooltip(`<b>${esc(c.vessel_name)}</b> (${c.risk})`, {
        permanent: isSelected || showLabels,
        direction: 'top',
        className: `gis-tooltip-${c.risk.toLowerCase()}`
      });
    }

    marker.on('click', () => pick(c.vessel_id));
    marker.addTo(layerGroups.tracks);
    vesselMarkers[c.vessel_id] = marker;
  });
}

// --------------------------------------------------------------------------
// 5. Update Replay Position on Map
// --------------------------------------------------------------------------
function updateReplayPosition() {
  if (!layerGroups.replay || !tracks || !selected || !tracks[selected]) return;
  layerGroups.replay.clearLayers();

  const stepIdx = +$('#time').value;
  const p = tracks[selected][stepIdx] || tracks[selected][0];

  const replayIcon = L.divIcon({
    className: 'custom-replay-marker',
    html: '<div class="replay-marker-icon" style="width: 14px; height: 14px;"></div>',
    iconSize: [14, 14],
    iconAnchor: [7, 7]
  });

  const replayMarker = L.marker([p.latitude, p.longitude], { icon: replayIcon, zIndexOffset: 1000 })
    .bindTooltip(`<b>REPLAY: ${esc(p.vessel_name)}</b><br>${p.speed.toFixed(1)} kn · ${p.heading.toFixed(0)}°<br>${p.timestamp.replace('T', ' ').replace('Z', ' UTC')}`, {
      permanent: false,
      direction: 'right'
    })
    .addTo(layerGroups.replay);

  // Update Replay Telemetry Bar
  if ($('#stamp')) {
    $('#stamp').textContent = p.timestamp.replace('T', ' ').replace('Z', ' UTC');
  }
  if ($('#current-step')) {
    $('#current-step').textContent = stepIdx + 1;
  }
  if ($('#total-steps')) {
    $('#total-steps').textContent = tracks[selected].length;
  }
}

// --------------------------------------------------------------------------
// 6. Main UI Render (Table & Evidence Breakdown)
// --------------------------------------------------------------------------
function render() {
  const tbody = $('#rows');
  const evidenceContainer = $('#evidence');

  if (!candidates || !candidates.length) {
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 32px 16px; font-size: 13px;">Awaiting Attribution Rank. Click <b>"⚡ Run Investigation"</b> or Step 4 above.</td></tr>`;
    }
    if (evidenceContainer) {
      evidenceContainer.innerHTML = `<div style="text-align: center; color: var(--text-muted); padding: 40px 16px; font-size: 13px;">Forensic evidence decomposition will appear once Attribution Rank executes.</div>`;
    }
    return;
  }

  // Update Column Header Sort Indicators
  document.querySelectorAll('th[data-k]').forEach(th => {
    const arrow = th.querySelector('.sort-arrow');
    if (arrow) {
      arrow.textContent = (th.dataset.k === sortKey) ? (asc ? '▲' : '▼') : '';
    }
  });

  // Sort candidate list
  const ordered = [...candidates].sort((a, b) => {
    let v = a[sortKey], w = b[sortKey];
    return (v > w ? 1 : v < w ? -1 : 0) * (asc ? 1 : -1);
  });

  // Render Table Rows
  tbody.innerHTML = ordered.map(c => {
    const originalRank = c.rank || (candidates.indexOf(c) + 1);
    const isSelected = c.vessel_id === selected;
    const isTop = originalRank === 1;

    return `
      <tr class="${isSelected ? 'selected-vessel' : ''} ${isTop ? 'top-ranked' : ''}" onclick="pick('${c.vessel_id}')">
        <td><span class="rank-badge ${isTop ? 'gold' : ''}">#${originalRank}</span></td>
        <td>
          <span class="vessel-cell-title">${esc(c.vessel_name)}</span>
          <span class="vessel-cell-id">${c.vessel_id}</span>
        </td>
        <td><b style="color: ${c.risk === 'HIGH' ? 'var(--risk-high)' : c.risk === 'MEDIUM' ? 'var(--risk-med)' : 'var(--risk-low)'}; font-size: 13.5px;">${c.final_score}</b><span style="color: var(--text-muted); font-size: 10px;">/100</span></td>
        <td><span class="risk-tag ${c.risk}">${c.risk}</span></td>
        <td>${c.closest_distance_km.toFixed(1)} km</td>
        <td>${c.time_gap_minutes.toFixed(0)} min</td>
        <td>${c.track_alignment.toFixed(0)}%</td>
      </tr>
    `;
  }).join('');

  // Render Evidence & Score Decomposition Panel
  const c = candidates.find(x => x.vessel_id === selected) || candidates[0];
  const b = c.score_breakdown;
  const rankNum = c.rank || (candidates.indexOf(c) + 1);
  const isTopCandidate = (c.is_top_candidate || rankNum === 1);

  const distPts = (b.distance * 0.30).toFixed(1);
  const timePts = (b.time * 0.25).toFixed(1);
  const trackPts = (b.track_alignment * 0.20).toFixed(1);
  const speedPts = (b.speed * 0.10).toFixed(1);
  const aisPts = (b.ais_behavior * 0.15).toFixed(1);

  $('#evidence').innerHTML = `
    <div class="evidence-hero-box">
      <div class="vessel-hero-summary">
        ${isTopCandidate ? '<div class="top-candidate-badge">★ TOP CANDIDATE (INVESTIGATIVE PRIORITIZATION ONLY)</div>' : ''}
        <h3>${esc(c.vessel_name)} <span class="risk-tag ${c.risk}">${c.risk} RISK</span></h3>
        <div class="vessel-telemetry">Rank #${rankNum} · IMO: ${c.vessel_id} · Speed: ${c.speed.toFixed(1)} kn · Heading: ${c.heading.toFixed(0)}°</div>
      </div>
      <div class="score-hero-block">
        <div class="score-hero-digits">${c.final_score}<span class="score-hero-max">/100</span></div>
        <div class="score-hero-caption">Attribution Score</div>
      </div>
    </div>

    <div class="findings-box">
      <div class="findings-box-heading">📌 Key Attribution Findings</div>
      <ul class="findings-list">
        ${c.reasons.map(r => `
          <li class="finding-row">
            <span class="finding-bullet">▸</span>
            <span>${esc(r)}</span>
          </li>
        `).join('')}
      </ul>
      ${c.ais_flags && c.ais_flags.length ? `
        <div class="ais-tags-row">
          ${c.ais_flags.map(f => `<span class="ais-anomaly-tag">⚠️ ${esc(f)}</span>`).join('')}
        </div>
      ` : ''}
    </div>

    <div class="score-meters-box">
      <div class="meters-title">📊 Multi-Factor Score Decomposition</div>
      <div class="meter-list">
        
        <div class="meter-row">
          <div class="meter-meta">
            <span class="meter-name">Distance Proximity <span class="meter-weight-tag">(30% max)</span></span>
            <span class="meter-score-val">${distPts} / 30.0</span>
          </div>
          <div class="meter-base-bar">
            <div class="meter-bar-progress" style="width: ${(distPts / 30.0 * 100).toFixed(1)}%;"></div>
          </div>
        </div>

        <div class="meter-row">
          <div class="meter-meta">
            <span class="meter-name">Temporal Proximity <span class="meter-weight-tag">(25% max)</span></span>
            <span class="meter-score-val">${timePts} / 25.0</span>
          </div>
          <div class="meter-base-bar">
            <div class="meter-bar-progress" style="width: ${(timePts / 25.0 * 100).toFixed(1)}%;"></div>
          </div>
        </div>

        <div class="meter-row">
          <div class="meter-meta">
            <span class="meter-name">Track Alignment <span class="meter-weight-tag">(20% max)</span></span>
            <span class="meter-score-val">${trackPts} / 20.0</span>
          </div>
          <div class="meter-base-bar">
            <div class="meter-bar-progress" style="width: ${(trackPts / 20.0 * 100).toFixed(1)}%;"></div>
          </div>
        </div>

        <div class="meter-row">
          <div class="meter-meta">
            <span class="meter-name">Speed Consistency <span class="meter-weight-tag">(10% max)</span></span>
            <span class="meter-score-val">${speedPts} / 10.0</span>
          </div>
          <div class="meter-base-bar">
            <div class="meter-bar-progress" style="width: ${(speedPts / 10.0 * 100).toFixed(1)}%;"></div>
          </div>
        </div>

        <div class="meter-row">
          <div class="meter-meta">
            <span class="meter-name">AIS Behavioral Anomaly <span class="meter-weight-tag">(15% max)</span></span>
            <span class="meter-score-val">${aisPts} / 15.0</span>
          </div>
          <div class="meter-base-bar">
            <div class="meter-bar-progress anomaly-bar" style="width: ${(aisPts / 15.0 * 100).toFixed(1)}%;"></div>
          </div>
        </div>

      </div>
    </div>
  `;

  // Synchronize Map Tracks Highlighting
  if (map && layerGroups.tracks) {
    drawVesselTracks(candidates, tracks);
    updateReplayPosition();
  }
}

// --------------------------------------------------------------------------
// 7. Vessel Selection Function (pick)
// --------------------------------------------------------------------------
function pick(id) {
  if (!tracks[id]) return;
  selected = id;

  if ($('#vessel')) {
    $('#vessel').value = id;
  }
  if ($('#time')) {
    $('#time').max = tracks[id].length - 1;
    $('#time').value = 0;
  }

  pauseReplay();
  render();
}
window.pick = pick;

// --------------------------------------------------------------------------
// 8. Event Listeners Initialization
// --------------------------------------------------------------------------
function initEventListeners() {
  // Workflow Control Actions
  if ($('#btn-run-workflow')) {
    $('#btn-run-workflow').onclick = () => runFullInvestigation();
  }

  if ($('#btn-reset-workflow')) {
    $('#btn-reset-workflow').onclick = () => resetInvestigation();
  }

  // Workflow Step Pills
  for (let i = 1; i <= 4; i++) {
    const pill = $(`#wf-step-${i}`);
    if (pill) {
      pill.onclick = () => runWorkflowStep(i);
    }
  }

  // Table Sorting Handlers
  document.querySelectorAll('th[data-k]').forEach(th => {
    th.onclick = () => {
      asc = (sortKey === th.dataset.k) ? !asc : false;
      sortKey = th.dataset.k;
      render();
    };
  });

  // Basemap Switcher Buttons
  const basemapButtons = document.querySelectorAll('.btn-basemap');
  basemapButtons.forEach(btn => {
    btn.onclick = () => {
      basemapButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const bmType = btn.dataset.bm;

      if (map && basemaps[bmType]) {
        if (currentBasemap) {
          map.removeLayer(currentBasemap);
        }
        currentBasemap = basemaps[bmType].addTo(map);
      }
    };
  });

  // Layer Toggles
  if ($('#layer-radius')) {
    $('#layer-radius').onchange = e => {
      if (layerGroups.radius) {
        if (e.target.checked) map.addLayer(layerGroups.radius);
        else map.removeLayer(layerGroups.radius);
      }
    };
  }

  if ($('#layer-spill')) {
    $('#layer-spill').onchange = e => {
      if (layerGroups.spill) {
        if (e.target.checked) map.addLayer(layerGroups.spill);
        else map.removeLayer(layerGroups.spill);
      }
    };
  }

  if ($('#layer-tracks')) {
    $('#layer-tracks').onchange = e => {
      if (layerGroups.tracks) {
        if (e.target.checked) map.addLayer(layerGroups.tracks);
        else map.removeLayer(layerGroups.tracks);
      }
    };
  }

  if ($('#layer-labels')) {
    $('#layer-labels').onchange = () => {
      drawVesselTracks(candidates, tracks);
    };
  }

  // Focus & Overview Action Buttons
  if ($('#btn-focus-spill')) {
    $('#btn-focus-spill').onclick = () => {
      if (map && spill) {
        map.flyTo([spill.latitude, spill.longitude], 12, { duration: 1.2 });
      }
    };
  }

  if ($('#btn-world-view')) {
    $('#btn-world-view').onclick = () => {
      if (map) {
        map.flyTo([20, 40], 2.5, { duration: 1.5 });
      }
    };
  }

  // AIS Replay Controls
  if ($('#vessel')) {
    $('#vessel').onchange = e => pick(e.target.value);
  }

  if ($('#time')) {
    $('#time').oninput = () => updateReplayPosition();
  }

  if ($('#btn-step-prev')) {
    $('#btn-step-prev').onclick = () => {
      pauseReplay();
      let i = +$('#time').value;
      if (i > 0) {
        $('#time').value = i - 1;
        updateReplayPosition();
      }
    };
  }

  if ($('#btn-step-next')) {
    $('#btn-step-next').onclick = () => {
      pauseReplay();
      let i = +$('#time').value;
      let max = +$('#time').max;
      if (i < max) {
        $('#time').value = i + 1;
        updateReplayPosition();
      }
    };
  }

  if ($('#play')) {
    $('#play').onclick = () => {
      if (timer) {
        pauseReplay();
      } else {
        if (+$('#time').value >= +$('#time').max) {
          $('#time').value = 0;
        }
        startReplay();
      }
    };
  }

  // Speed Buttons
  const speedBtns = document.querySelectorAll('.btn-speed');
  speedBtns.forEach(btn => {
    btn.onclick = () => {
      speedBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      replayIntervalMs = parseInt(btn.dataset.speed, 10);
      if (timer) {
        startReplay();
      }
    };
  });
}

// --------------------------------------------------------------------------
// 9. AIS Replay Playback Timer
// --------------------------------------------------------------------------
function startReplay() {
  clearInterval(timer);
  const playBtn = $('#play');
  if (playBtn) {
    playBtn.textContent = '⏸ Pause';
    playBtn.classList.add('active');
  }

  timer = setInterval(() => {
    let i = +$('#time').value;
    let max = +$('#time').max;
    if (i >= max) {
      pauseReplay();
    } else {
      $('#time').value = i + 1;
      updateReplayPosition();
    }
  }, replayIntervalMs);
}

function pauseReplay() {
  clearInterval(timer);
  timer = null;
  const playBtn = $('#play');
  if (playBtn) {
    playBtn.textContent = '▶ Play';
    playBtn.classList.remove('active');
  }
}

async function uploadSARImage() {
  const input = $('#sar-upload-input');
  const button = $('#btn-upload-detect');
  const box = $('#upload-result');
  if (!input || !box) return;
  const file = input.files && input.files[0];
  if (!file) { setNotice('Choose a .tif/.tiff file before running detection.', true); return; }
  if (!/\.tiff?$/i.test(file.name)) { setNotice('Unsupported file type. Please upload a .tif or .tiff image.', true); return; }
  const formData = new FormData();
  formData.append('file', file);
  if (button) { button.disabled = true; button.textContent = 'Processing...'; }
  try {
    const res = await fetch(apiUrl('/api/detect-image'), { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || 'Detection request failed.');
    renderUploadResult(data);
    spill = Object.assign({}, spill || {}, { detector_status: data.detector_status, confidence: data.confidence, detector_confidence: data.confidence, detected_pixels: data.mask_pixels, area: data.spill_area, area_unit: data.spill_area.includes('km²') ? 'km²' : 'pixels' });
    renderDetectionEngine(spill);
    setNotice('Uploaded ' + file.name + ': ' + data.detector_status.replace(/_/g, ' ') + '. ' + (data.spill_area ? 'Area: ' + data.spill_area : ''));
  } catch (err) {
    renderUploadResult({ error: err.message });
    setNotice(err.message, true);
  } finally {
    if (button) { button.disabled = false; button.textContent = 'Run Detector'; }
  }
}

function renderUploadResult(result) {
  const container = $('#upload-result');
  if (!container) return;

  if (result.error) {
    container.innerHTML = `<div class="upload-error">${esc(result.error)}</div>`;
    return;
  }

  const status = (result.detector_status || 'UNKNOWN').replace(/_/g, ' ').toUpperCase();
  const areaText = result.spill_area ? `${result.spill_area}` : 'N/A';
  const confidenceText = result.confidence != null ? `${Math.round(result.confidence * 100)}%` : 'N/A';

  container.innerHTML = `
    <div class="upload-preview-grid">
      <div class="upload-preview-card">
        <div class="upload-preview-header">Original Uploaded Image</div>
        <img src="${result.original_image || ''}" alt="Original SAR upload" />
      </div>
      <div class="upload-preview-card">
        <div class="upload-preview-header">Detected Oil-Spill Mask</div>
        <img src="${result.mask_image || ''}" alt="Detected oil spill mask" />
      </div>
    </div>
    <div class="upload-metadata">
      <div><span>Status</span><strong>${esc(status)}</strong></div>
      <div><span>Spill Area</span><strong>${esc(areaText)}</strong></div>
      <div><span>Contrast Score</span><strong>${result.contrast_score != null ? Number(result.contrast_score).toFixed(3) : 'N/A'}</strong></div>
      <div><span>Confidence</span><strong>${esc(confidenceText)}</strong></div>
      <div><span>Mask Pixels</span><strong>${Number(result.mask_pixels || 0).toLocaleString()}</strong></div>
    </div>
  `;
}

async function initInvestigation() {
  try {
    const [state, cand, trk] = await Promise.all([
      fetch(apiUrl('/api/state')).then(r => r.json()),
      fetch(apiUrl('/api/candidates')).then(r => r.json()),
      fetch(apiUrl('/api/tracks')).then(r => r.json())
    ]);

    spill = state.spill;
    candidates = cand;
    tracks = trk;
    currentStage = state.stage || 'VESSELS_RANKED';
    selected = candidates[0] ? candidates[0].vessel_id : Object.keys(tracks)[0];

    // Initialize Leaflet Map
    initLeafletMap(spill, candidates, tracks);

    // Setup Event Listeners
    initEventListeners();

    // Synchronize UI
    await syncUIWithSession(state);
  } catch (err) {
    console.error('Error initializing investigation:', err);
    setNotice(`Backend communication failure: Ensure backend is running at ${API_BASE_URL}`, true);
  }
}

// Start application
initInvestigation();

// --------------------------------------------------------------------------
// 2. KPI Cards Rendering
// --------------------------------------------------------------------------
function renderKPICards(s, stage = currentStage) {
  const infoContainer = $('#info');
  if (!infoContainer) return;

  const isIngested = stage && stage !== 'NOT_STARTED';
  const isDetected = stage && ['SLICK_DETECTED', 'AIS_CORRELATED', 'VESSELS_RANKED'].includes(stage);

  const kpis = [
    {
      title: 'Spill Location',
      val: isDetected ? `${s.latitude.toFixed(4)}° N, ${s.longitude.toFixed(4)}° E` : (isIngested ? '18.9524° N, 72.8837° E' : 'Pending Ingest'),
      sub: 'Geographic Origin Anchor (DEMO)',
      symbol: '🎯'
    },
    {
      title: 'Spill Area',
      val: isDetected ? `${s.area} ${s.area_unit}` : (isIngested ? 'Awaiting Mask' : 'Pending Ingest'),
      sub: isDetected ? 'Cleaned Spatial Mask Extent' : 'Detection Mask Extent',
      symbol: '📐'
    },
    {
      title: 'Detection Confidence',
      val: isDetected ? `${Math.round(s.confidence * 100)}%` : (isIngested ? 'Awaiting Mask' : 'Pending Ingest'),
      sub: 'SAR Multi-Feature Composite',
      symbol: '🛡️',
      hasBar: isDetected,
      pct: isDetected ? Math.round(s.confidence * 100) : 0
    },
    {
      title: 'Detection Time',
      val: isIngested ? s.timestamp.replace('T', ' ').replace('Z', ' UTC') : 'Pending Ingest',
      sub: 'Sentinel-1 SAR Acquisition',
      symbol: '⏱️'
    }
  ];

  infoContainer.innerHTML = kpis.map(item => `
    <div class="kpi-card-white">
      <div class="kpi-card-head">
        <span class="kpi-card-label">${item.title}</span>
        <span class="kpi-card-symbol">${item.symbol}</span>
      </div>
      <div class="kpi-card-number">${item.val}</div>
      <div class="kpi-card-footnote">${item.sub}</div>
      ${item.hasBar ? `<div class="kpi-confidence-track"><div class="kpi-confidence-fill" style="width: ${item.pct}%;"></div></div>` : ''}
    </div>
  `).join('');
}
// --------------------------------------------------------------------------
// 2B. Detection Engine Output
// --------------------------------------------------------------------------
function renderDetectionEngine(s) {
  const container = $('#detection-engine');
  if (!container) return;

  const confidence = s.detector_confidence != null
    ? Math.round(s.detector_confidence * 100)
    : null;

  const shape = s.shape_score != null
    ? Math.round(s.shape_score * 100)
    : null;

  const area = s.area_score != null
    ? Math.round(s.area_score * 100)
    : null;

  const fallback = s.fallback_used ? 'YES' : 'NO';

  container.innerHTML = `
    <div class="detection-metric">
      <span class="detection-metric-label">DETECTOR STATUS</span>
      <strong>${esc((s.detector_status || 'UNKNOWN').replace(/_/g, ' ').toUpperCase())}</strong>
    </div>

    <div class="detection-metric">
      <span class="detection-metric-label">PROTOTYPE CONFIDENCE</span>
      <strong>${confidence != null ? confidence + '%' : 'N/A'}</strong>
      <div class="detection-mini-track">
        <div style="width:${confidence != null ? confidence : 0}%"></div>
      </div>
    </div>

    <div class="detection-metric">
      <span class="detection-metric-label">DETECTED PIXELS</span>
      <strong>${Number(s.detected_pixels || 0).toLocaleString()}</strong>
    </div>

    <div class="detection-metric">
      <span class="detection-metric-label">SHAPE SCORE</span>
      <strong>${shape != null ? shape + '%' : 'N/A'}</strong>
    </div>

    <div class="detection-metric">
      <span class="detection-metric-label">AREA SCORE</span>
      <strong>${area != null ? area + '%' : 'N/A'}</strong>
    </div>

    <div class="detection-metric">
      <span class="detection-metric-label">SENSITIVITY</span>
      <strong>${s.detection_sensitivity != null ? s.detection_sensitivity.toFixed(2) : 'N/A'}</strong>
    </div>

    <div class="detection-metric">
      <span class="detection-metric-label">FALLBACK MASK</span>
      <strong>${fallback}</strong>
    </div>

    <div class="detection-metric">
      <span class="detection-metric-label">CENTROID</span>
      <strong>${s.centroid_pixel
        ? `[${s.centroid_pixel[0].toFixed(1)}, ${s.centroid_pixel[1].toFixed(1)}]`
        : 'N/A'}</strong>
      <small>Pixel coordinates</small>
    </div>
  `;
}

// --------------------------------------------------------------------------
// 3. Leaflet GIS Map Initialization
// --------------------------------------------------------------------------
function initLeafletMap(s, c, t) {
  if (typeof L === 'undefined') {
    console.error('Leaflet library is not loaded');
    return;
  }

  // Initialize Map Instance centered on investigation area
  map = L.map('gis-map-viewport', {
    center: [s.latitude, s.longitude],
    zoom: 11,
    minZoom: 2,
    maxZoom: 18,
    zoomControl: true,
    attributionControl: true
  });

  // Define Legitimate Basemap Providers
  basemaps = {
    light: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19
    }),
    sat: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      attribution: 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, GIS Community',
      maxZoom: 18
    })
  };

  // Add Default Basemap (Map)
  currentBasemap = basemaps.light.addTo(map);

  // Initialize Layer Groups
  layerGroups.radius = L.layerGroup().addTo(map);
  layerGroups.spill = L.layerGroup().addTo(map);
  layerGroups.tracks = L.layerGroup().addTo(map);
  layerGroups.replay = L.layerGroup().addTo(map);

  // Draw 15 km Search Radius Circle
  const searchRadiusMeters = 15000;
  L.circle([s.latitude, s.longitude], {
    radius: searchRadiusMeters,
    color: '#0284c7',
    weight: 1.5,
    dashArray: '6, 6',
    fillColor: '#38bdf8',
    fillOpacity: 0.08
  }).bindTooltip('15 km Investigation Perimeter', { direction: 'top' }).addTo(layerGroups.radius);

  // Draw Spill Polygon if available
  if (s.polygon && s.polygon.length > 2) {
    L.polygon(s.polygon, {
      color: '#dc2626',
      weight: 2,
      dashArray: '4, 4',
      fillColor: '#ef4444',
      fillOpacity: 0.25
    }).bindPopup(`<b>Estimated Slick Extent</b><br>Area: ${s.area} ${s.area_unit}<br>Confidence: ${Math.round(s.confidence * 100)}%`).addTo(layerGroups.spill);
  }

  // Draw Spill Origin Custom Marker
  const spillIcon = L.divIcon({
    className: 'custom-spill-div-icon',
    html: '<div class="spill-origin-pulse"></div>',
    iconSize: [24, 24],
    iconAnchor: [12, 12]
  });

  L.marker([s.latitude, s.longitude], { icon: spillIcon })
    .bindPopup(`<b>🛢️ Estimated Spill Origin</b><br>Lat: ${s.latitude.toFixed(4)}°, Lon: ${s.longitude.toFixed(4)}°<br>Acquisition: ${s.timestamp.replace('T', ' ').replace('Z', ' UTC')}`)
    .addTo(layerGroups.spill);

  // Draw Vessel Tracks on Map
  drawVesselTracks(c, t);

  // Draw Initial Replay Position
  updateReplayPosition();
}

// --------------------------------------------------------------------------
// 4. Vessel Tracks Drawing on Leaflet Map
// --------------------------------------------------------------------------
function drawVesselTracks(candidatesList, tracksDict) {
  if (!layerGroups.tracks) return;
  layerGroups.tracks.clearLayers();
  trackLayers = {};
  vesselMarkers = {};

  const showLabels = $('#layer-labels') ? $('#layer-labels').checked : true;

  candidatesList.forEach(c => {
    const p = tracksDict[c.vessel_id];
    if (!p || !p.length) return;

    const isSelected = (c.vessel_id === selected);
    const color = c.risk === 'HIGH' ? '#dc2626' : c.risk === 'MEDIUM' ? '#d97706' : '#16a34a';
    const latLngs = p.map(pt => [pt.latitude, pt.longitude]);

    // Polyline Track
    const polyline = L.polyline(latLngs, {
      color: color,
      weight: isSelected ? 4.5 : 2,
      opacity: isSelected ? 1.0 : 0.45,
      lineCap: 'round',
      lineJoin: 'round'
    });

    polyline.on('click', () => pick(c.vessel_id));
    polyline.addTo(layerGroups.tracks);
    trackLayers[c.vessel_id] = polyline;

    // Track Waypoint Dots for Selected Vessel
    if (isSelected) {
      p.forEach((pt, idx) => {
        const dot = L.circleMarker([pt.latitude, pt.longitude], {
          radius: 3.5,
          color: '#0284c7',
          fillColor: '#ffffff',
          fillOpacity: 1,
          weight: 1.5
        }).bindTooltip(`<b>${esc(c.vessel_name)}</b><br>Passage: ${pt.timestamp.replace('T', ' ').replace('Z', ' UTC')}<br>Speed: ${pt.speed.toFixed(1)} kn · Heading: ${pt.heading.toFixed(0)}°`);
        dot.addTo(layerGroups.tracks);
      });
    }

    // Endpoint Marker
    const last = p[p.length - 1];
    const marker = L.circleMarker([last.latitude, last.longitude], {
      radius: isSelected ? 6.5 : 4.5,
      color: '#061325',
      weight: 1.5,
      fillColor: color,
      fillOpacity: 1
    });

    if (showLabels || isSelected) {
      marker.bindTooltip(`<b>${esc(c.vessel_name)}</b> (${c.risk})`, {
        permanent: isSelected || showLabels,
        direction: 'top',
        className: `gis-tooltip-${c.risk.toLowerCase()}`
      });
    }

    marker.on('click', () => pick(c.vessel_id));
    marker.addTo(layerGroups.tracks);
    vesselMarkers[c.vessel_id] = marker;
  });
}

// --------------------------------------------------------------------------
// 5. Update Replay Position on Map
// --------------------------------------------------------------------------
function updateReplayPosition() {
  if (!layerGroups.replay || !tracks || !selected || !tracks[selected]) return;
  layerGroups.replay.clearLayers();

  const stepIdx = +$('#time').value;
  const p = tracks[selected][stepIdx] || tracks[selected][0];

  const replayIcon = L.divIcon({
    className: 'custom-replay-marker',
    html: '<div class="replay-marker-icon" style="width: 14px; height: 14px;"></div>',
    iconSize: [14, 14],
    iconAnchor: [7, 7]
  });

  const replayMarker = L.marker([p.latitude, p.longitude], { icon: replayIcon, zIndexOffset: 1000 })
    .bindTooltip(`<b>REPLAY: ${esc(p.vessel_name)}</b><br>${p.speed.toFixed(1)} kn · ${p.heading.toFixed(0)}°<br>${p.timestamp.replace('T', ' ').replace('Z', ' UTC')}`, {
      permanent: false,
      direction: 'right'
    })
    .addTo(layerGroups.replay);

  // Update Replay Telemetry Bar
  if ($('#stamp')) {
    $('#stamp').textContent = p.timestamp.replace('T', ' ').replace('Z', ' UTC');
  }
  if ($('#current-step')) {
    $('#current-step').textContent = stepIdx + 1;
  }
  if ($('#total-steps')) {
    $('#total-steps').textContent = tracks[selected].length;
  }
}

// --------------------------------------------------------------------------
// 6. Main UI Render (Table & Evidence Breakdown)
// --------------------------------------------------------------------------
function render() {
  const tbody = $('#rows');
  const evidenceContainer = $('#evidence');

  if (!candidates || !candidates.length) {
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 32px 16px; font-size: 13px;">Awaiting Attribution Rank. Click <b>"⚡ Run Investigation"</b> or Step 4 above.</td></tr>`;
    }
    if (evidenceContainer) {
      evidenceContainer.innerHTML = `<div style="text-align: center; color: var(--text-muted); padding: 40px 16px; font-size: 13px;">Forensic evidence decomposition will appear once Attribution Rank executes.</div>`;
    }
    return;
  }

  // Update Column Header Sort Indicators
  document.querySelectorAll('th[data-k]').forEach(th => {
    const arrow = th.querySelector('.sort-arrow');
    if (arrow) {
      arrow.textContent = (th.dataset.k === sortKey) ? (asc ? '▲' : '▼') : '';
    }
  });

  // Sort candidate list
  const ordered = [...candidates].sort((a, b) => {
    let v = a[sortKey], w = b[sortKey];
    return (v > w ? 1 : v < w ? -1 : 0) * (asc ? 1 : -1);
  });

  // Render Table Rows
  tbody.innerHTML = ordered.map(c => {
    const originalRank = c.rank || (candidates.indexOf(c) + 1);
    const isSelected = c.vessel_id === selected;
    const isTop = originalRank === 1;

    return `
      <tr class="${isSelected ? 'selected-vessel' : ''} ${isTop ? 'top-ranked' : ''}" onclick="pick('${c.vessel_id}')">
        <td><span class="rank-badge ${isTop ? 'gold' : ''}">#${originalRank}</span></td>
        <td>
          <span class="vessel-cell-title">${esc(c.vessel_name)}</span>
          <span class="vessel-cell-id">${c.vessel_id}</span>
        </td>
        <td><b style="color: ${c.risk === 'HIGH' ? 'var(--risk-high)' : c.risk === 'MEDIUM' ? 'var(--risk-med)' : 'var(--risk-low)'}; font-size: 13.5px;">${c.final_score}</b><span style="color: var(--text-muted); font-size: 10px;">/100</span></td>
        <td><span class="risk-tag ${c.risk}">${c.risk}</span></td>
        <td>${c.closest_distance_km.toFixed(1)} km</td>
        <td>${c.time_gap_minutes.toFixed(0)} min</td>
        <td>${c.track_alignment.toFixed(0)}%</td>
      </tr>
    `;
  }).join('');

  // Render Evidence & Score Decomposition Panel
  const c = candidates.find(x => x.vessel_id === selected) || candidates[0];
  const b = c.score_breakdown;
  const rankNum = c.rank || (candidates.indexOf(c) + 1);
  const isTopCandidate = (c.is_top_candidate || rankNum === 1);

  const distPts = (b.distance * 0.30).toFixed(1);
  const timePts = (b.time * 0.25).toFixed(1);
  const trackPts = (b.track_alignment * 0.20).toFixed(1);
  const speedPts = (b.speed * 0.10).toFixed(1);
  const aisPts = (b.ais_behavior * 0.15).toFixed(1);

  $('#evidence').innerHTML = `
    <div class="evidence-hero-box">
      <div class="vessel-hero-summary">
        ${isTopCandidate ? '<div class="top-candidate-badge">★ TOP CANDIDATE (INVESTIGATIVE PRIORITIZATION ONLY)</div>' : ''}
        <h3>${esc(c.vessel_name)} <span class="risk-tag ${c.risk}">${c.risk} RISK</span></h3>
        <div class="vessel-telemetry">Rank #${rankNum} · IMO: ${c.vessel_id} · Speed: ${c.speed.toFixed(1)} kn · Heading: ${c.heading.toFixed(0)}°</div>
      </div>
      <div class="score-hero-block">
        <div class="score-hero-digits">${c.final_score}<span class="score-hero-max">/100</span></div>
        <div class="score-hero-caption">Attribution Score</div>
      </div>
    </div>

    <div class="findings-box">
      <div class="findings-box-heading">📌 Key Attribution Findings</div>
      <ul class="findings-list">
        ${c.reasons.map(r => `
          <li class="finding-row">
            <span class="finding-bullet">▸</span>
            <span>${esc(r)}</span>
          </li>
        `).join('')}
      </ul>
      ${c.ais_flags && c.ais_flags.length ? `
        <div class="ais-tags-row">
          ${c.ais_flags.map(f => `<span class="ais-anomaly-tag">⚠️ ${esc(f)}</span>`).join('')}
        </div>
      ` : ''}
    </div>

    <div class="score-meters-box">
      <div class="meters-title">📊 Multi-Factor Score Decomposition</div>
      <div class="meter-list">
        
        <div class="meter-row">
          <div class="meter-meta">
            <span class="meter-name">Distance Proximity <span class="meter-weight-tag">(30% max)</span></span>
            <span class="meter-score-val">${distPts} / 30.0</span>
          </div>
          <div class="meter-base-bar">
            <div class="meter-bar-progress" style="width: ${(distPts / 30.0 * 100).toFixed(1)}%;"></div>
          </div>
        </div>

        <div class="meter-row">
          <div class="meter-meta">
            <span class="meter-name">Temporal Proximity <span class="meter-weight-tag">(25% max)</span></span>
            <span class="meter-score-val">${timePts} / 25.0</span>
          </div>
          <div class="meter-base-bar">
            <div class="meter-bar-progress" style="width: ${(timePts / 25.0 * 100).toFixed(1)}%;"></div>
          </div>
        </div>

        <div class="meter-row">
          <div class="meter-meta">
            <span class="meter-name">Track Alignment <span class="meter-weight-tag">(20% max)</span></span>
            <span class="meter-score-val">${trackPts} / 20.0</span>
          </div>
          <div class="meter-base-bar">
            <div class="meter-bar-progress" style="width: ${(trackPts / 20.0 * 100).toFixed(1)}%;"></div>
          </div>
        </div>

        <div class="meter-row">
          <div class="meter-meta">
            <span class="meter-name">Speed Consistency <span class="meter-weight-tag">(10% max)</span></span>
            <span class="meter-score-val">${speedPts} / 10.0</span>
          </div>
          <div class="meter-base-bar">
            <div class="meter-bar-progress" style="width: ${(speedPts / 10.0 * 100).toFixed(1)}%;"></div>
          </div>
        </div>

        <div class="meter-row">
          <div class="meter-meta">
            <span class="meter-name">AIS Behavioral Anomaly <span class="meter-weight-tag">(15% max)</span></span>
            <span class="meter-score-val">${aisPts} / 15.0</span>
          </div>
          <div class="meter-base-bar">
            <div class="meter-bar-progress anomaly-bar" style="width: ${(aisPts / 15.0 * 100).toFixed(1)}%;"></div>
          </div>
        </div>

      </div>
    </div>
  `;

  // Synchronize Map Tracks Highlighting
  if (map && layerGroups.tracks) {
    drawVesselTracks(candidates, tracks);
    updateReplayPosition();
  }
}

// --------------------------------------------------------------------------
// 7. Vessel Selection Function (pick)
// --------------------------------------------------------------------------
function pick(id) {
  if (!tracks[id]) return;
  selected = id;

  if ($('#vessel')) {
    $('#vessel').value = id;
  }
  if ($('#time')) {
    $('#time').max = tracks[id].length - 1;
    $('#time').value = 0;
  }

  pauseReplay();
  render();
}
window.pick = pick;

// --------------------------------------------------------------------------
// 8. Event Listeners Initialization
// --------------------------------------------------------------------------
function initEventListeners() {
  // Workflow Control Actions
  if ($('#btn-run-workflow')) {
    $('#btn-run-workflow').onclick = () => runFullInvestigation();
  }

  if ($('#btn-reset-workflow')) {
    $('#btn-reset-workflow').onclick = () => resetInvestigation();
  }

  // Workflow Step Pills
  for (let i = 1; i <= 4; i++) {
    const pill = $(`#wf-step-${i}`);
    if (pill) {
      pill.onclick = () => runWorkflowStep(i);
    }
  }
}
