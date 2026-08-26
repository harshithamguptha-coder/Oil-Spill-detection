# SlickTrace AI – Vessel Attribution MVP

An offline, explainable AIS correlation demo built alongside the existing oil-spill detector. It does **not** make liability findings: rankings are prioritization cues only.

## Existing detector integration

`services.detector.detect_slick()` returns a cleaned binary `mask`, `contrast_score`, and status. `services.geometry.analyze_geometry()` derives a centroid and polygon in **pixel space**. The supplied `data/case_01/01339.tif` has no geographic CRS/tie points, so its pixel coordinates cannot be validly converted to latitude/longitude. `services/ais/spill_context.py` therefore calls the detector when available but uses prominently labelled `DEMO` geographic metadata for the map, timestamp and AIS correlation.

## Run

Start the backend API:

```powershell
python -m pip install -r requirements.txt
python app.py
```

Start the separate frontend server in another terminal:

```powershell
cd frontend
python -m http.server 5173
```

Open `http://127.0.0.1:5173`. The frontend calls the backend API at `http://127.0.0.1:8000`. The app uses only local `data/ais_demo_tracks.csv`; it works without an external AIS provider.

## What is included

- Ten timestamped demo vessel tracks near the demo spill origin.
- Haversine proximity, closest passage, time gap, heading/track alignment and configurable radius/time window.
- Weighted, explainable 0–100 score: distance 30%, time 25%, track alignment 20%, speed 10%, AIS behaviour 15%.
- Simple non-accusatory anomaly flags: speed/heading changes, AIS gaps, stops.
- Sortable evidence table, selected-vessel evidence panel, and browser replay.

To connect a real AIS provider later, implement its adapter with the same records expected by `services.ais.loader.load_local_tracks()`.
