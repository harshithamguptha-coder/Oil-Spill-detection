"""Tunable, transparent defaults for the offline AIS demo."""

SEARCH_RADIUS_KM = 15.0
TIME_WINDOW_MINUTES = 90.0
WEIGHTS = {"distance": 0.30, "time": 0.25, "track_alignment": 0.20, "speed": 0.10, "ais_behavior": 0.15}

# The supplied TIFF has no geographic CRS/tie points.  These values are explicitly
# demo metadata, used only to make the hackathon replay geographically coherent.
DEMO_SPILL_CONTEXT = {
    "latitude": 18.9524, "longitude": 72.8837,
    "timestamp": "2026-08-25T10:30:00Z", "area": 1.84,
    "confidence": 0.74, "area_unit": "km²", "source": "DEMO location metadata (source TIFF is unreferenced)",
    "polygon": [[18.9580,72.8740],[18.9600,72.8840],[18.9550,72.8930],[18.9470,72.8910],[18.9450,72.8810],[18.9520,72.8730],[18.9580,72.8740]],
}
