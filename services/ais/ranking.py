"""Transparent prioritization score; not evidence of liability."""
from __future__ import annotations
from statistics import median
from .config import SEARCH_RADIUS_KM, TIME_WINDOW_MINUTES, WEIGHTS
from .correlation import angular_difference, correlate_track

def behavior_score(track: list[dict], closest_index: int) -> tuple[float, list[str]]:
    score, flags = 0.0, []
    for before, after in zip(track, track[1:]):
        gap = (after["timestamp"]-before["timestamp"]).total_seconds()/60
        if gap > 30: score, flags = max(score, 55), flags+["AIS position gap"]
        if abs(after["speed"]-before["speed"]) >= 5: score, flags = max(score, 65), flags+["Sudden speed change"]
        if angular_difference(after["heading"],before["heading"]) >= 55: score, flags = max(score, 70), flags+["Sudden heading change"]
    if track[closest_index]["speed"] < 1: score, flags = max(score, 60), flags+["Unusual stop"]
    return score, list(dict.fromkeys(flags))

def rank_vessels(tracks: dict, spill: dict, radius_km: float=SEARCH_RADIUS_KM, time_window_minutes: float=TIME_WINDOW_MINUTES, weights: dict=WEIGHTS) -> list[dict]:
    from datetime import datetime
    detection = datetime.fromisoformat(spill["timestamp"].replace("Z","+00:00"))
    results=[]
    for vessel_id, track in tracks.items():
        c=correlate_track(track,spill,radius_km,detection); closest=c["closest"]; index=track.index(closest)
        behaviour, flags=behavior_score(track,index)
        scores={"distance":max(0,100*(1-c["closest_distance_km"]/radius_km)),"time":max(0,100*(1-c["time_gap_minutes"]/time_window_minutes)),"track_alignment":c["track_alignment"],"speed":max(0,100-abs(closest["speed"]-10)*8),"ais_behavior":behaviour}
        final=round(sum(scores[k]*weights[k] for k in weights),1)
        reasons=[f"{c['closest_distance_km']:.1f} km from estimated origin",f"Closest pass {c['time_gap_minutes']:.0f} minutes from detection",f"Track alignment {c['track_alignment']:.0f}%"]
        if flags: reasons.append("Unusual AIS behaviour detected: "+", ".join(flags))
        results.append({"vessel_id":vessel_id,"vessel_name":closest["vessel_name"],"final_score":final,"risk":"HIGH" if final>=80 else "MEDIUM" if final>=60 else "LOW","speed":closest["speed"],"heading":closest["heading"],"score_breakdown":scores,"reasons":reasons,"ais_flags":flags,**c})
    return sorted(results,key=lambda x:x["final_score"],reverse=True)
