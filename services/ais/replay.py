"""Serialization helpers for browser-based historical track replay."""
from __future__ import annotations
def replay_payload(tracks: dict) -> dict:
    return {v:[{**p,"timestamp":p["timestamp"].isoformat().replace("+00:00","Z")} for p in points] for v,points in tracks.items()}
