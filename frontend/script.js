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
// 1. Data Ingestion from Backend Endpoints
// --------------------------------------------------------------------------
Promise.all([
  fetch(apiUrl('/api/context')).then(r => r.json()),
  fetch(apiUrl('/api/candidates')).then(r => r.json()),
  fetch(apiUrl('/api/tracks')).then(r => r.json()),
  fetch(apiUrl('/api/config')).then(r => r.json())
]).then(([s, c, t, cfg]) => {
  spill = s;
  candidates = c;
  tracks = t;
  selected = c[0] ? c[0].vessel_id : Object.keys(t)[0];

  // Populate Investigation Metadata
  if ($('#meta-detect-status') && s.detector_status) {
    $('#meta-detect-status').textContent = s.detector_status.replace(/_/g, ' ').toUpperCase();
  }
  if ($('#meta-ais-count')) {
    $('#meta-ais-count').textContent = `${c.length} VESSELS CORRELATED`;
  }

  // Populate KPI Summary Cards
  renderKPICards(s);
  renderDetectionEngine(s);

  // Populate Replay Vessel Dropdown
  const vesselSelect = $('#vessel');
  vesselSelect.innerHTML = c.map(x => `<option value="${x.vessel_id}">${esc(x.vessel_name)} (${x.vessel_id})</option>`).join('');
  if (selected && tracks[selected]) {
    $('#time').max = tracks[selected].length - 1;
  }

  // Initialize Leaflet Interactive GIS Map
  initLeafletMap(s, c, t);

  // Setup Event Listeners
  initEventListeners();

  // Render Table & Evidence
  render();
}).catch(err => {
  console.error('Error loading investigation data:', err);
});

// --------------------------------------------------------------------------
// 2. KPI Cards Rendering
// --------------------------------------------------------------------------
function renderKPICards(s) {
  const infoContainer = $('#info');
  if (!infoContainer) return;

  const kpis = [
    {
      title: 'Spill Location',
      val: `${s.latitude.toFixed(4)}° N, ${s.longitude.toFixed(4)}° E`,
      sub: 'Geographic Origin Anchor',
      symbol: '🎯'
    },
    {
      title: 'Spill Area',
      val: `${s.area} ${s.area_unit}`,
      sub: 'Cleaned Spatial Mask Extent',
      symbol: '📐'
    },
    {
      title: 'Detection Confidence',
      val: `${Math.round(s.confidence * 100)}%`,
      sub: 'SAR Multi-Feature Composite',
      symbol: '🛡️',
      hasBar: true,
      pct: Math.round(s.confidence * 100)
    },
    {
      title: 'Detection Time',
      val: s.timestamp.replace('T', ' ').replace('Z', ' UTC'),
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
    light: L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
      subdomains: 'abcd',
      maxZoom: 19
    }),
    sat: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      attribution: 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, GIS Community',
      maxZoom: 18
    }),
    dark: L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
      subdomains: 'abcd',
      maxZoom: 19
    })
  };

  // Add Default Light Basemap
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
  if (!spill || !candidates || !candidates.length) return;

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
  const tbody = $('#rows');
  tbody.innerHTML = ordered.map(c => {
    const originalRank = candidates.indexOf(c) + 1;
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
  const rankNum = candidates.indexOf(c) + 1;

  const distPts = (b.distance * 0.30).toFixed(1);
  const timePts = (b.time * 0.25).toFixed(1);
  const trackPts = (b.track_alignment * 0.20).toFixed(1);
  const speedPts = (b.speed * 0.10).toFixed(1);
  const aisPts = (b.ais_behavior * 0.15).toFixed(1);

  $('#evidence').innerHTML = `
    <div class="evidence-hero-box">
      <div class="vessel-hero-summary">
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
