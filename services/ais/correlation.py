"""Explainable geographic and temporal correlation helpers."""
from __future__ import annotations
from datetime import datetime
from math import asin, cos, radians, sin, sqrt

def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    dlat, dlon = radians(lat2-lat1), radians(lon2-lon1)
    a = sin(dlat/2)**2 + cos(radians(lat1))*cos(radians(lat2))*sin(dlon/2)**2
    return 6371.0088 * 2 * asin(sqrt(a))

def bearing_to(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    a, b = radians(lat1), radians(lat2); dl = radians(lon2-lon1)
    return (radians(0) + __import__('math').degrees(__import__('math').atan2(sin(dl)*cos(b), cos(a)*sin(b)-sin(a)*cos(b)*cos(dl))) + 360) % 360

def angular_difference(a: float, b: float) -> float: return abs((a-b+180) % 360-180)

def correlate_track(track: list[dict], spill: dict, radius_km: float, detection_time: datetime) -> dict:
    closest = min(track, key=lambda p: haversine_km(p["latitude"],p["longitude"],spill["latitude"],spill["longitude"]))
    distance = haversine_km(closest["latitude"],closest["longitude"],spill["latitude"],spill["longitude"])
    minutes = abs((closest["timestamp"]-detection_time).total_seconds())/60
    target_bearing = bearing_to(closest["latitude"],closest["longitude"],spill["latitude"],spill["longitude"])
    alignment = max(0.0, 100.0 * (1 - angular_difference(closest["heading"], target_bearing)/180))
    return {"closest":closest,"closest_distance_km":distance,"time_gap_minutes":minutes,"inside_search_radius":distance<=radius_km,"track_alignment":alignment}
