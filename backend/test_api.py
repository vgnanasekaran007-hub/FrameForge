#!/usr/bin/env python3
"""
FrameForge API Integration Tests
Tests: /health, /upload, /extract (interval/single/all), /frame, /download, /session
"""
import json
import os
import sys
import requests

BASE = "http://localhost:8000"
VIDEO_PATH = "/tmp/test_video.mp4"
PASS = "\033[92m✓\033[0m"
FAIL = "\033[91m✗\033[0m"

results = []

def check(label, condition, detail=""):
    ok = bool(condition)
    results.append(ok)
    icon = PASS if ok else FAIL
    print(f"  {icon}  {label}" + (f" → {detail}" if detail else ""))
    return ok


print("\n═══════════════════════════════════════════")
print("  FrameForge API Integration Tests")
print("═══════════════════════════════════════════\n")

# ── 1. Health ──────────────────────────────────────────────────────────────
print("【1】 GET /health")
try:
    r = requests.get(f"{BASE}/health", timeout=5)
    data = r.json()
    check("status 200", r.status_code == 200, r.status_code)
    check("status=ok", data.get("status") == "ok", data.get("status"))
    check("ffmpeg path", "/ffmpeg" in data.get("ffmpeg", ""), data.get("ffmpeg"))
except Exception as e:
    check("health reachable", False, str(e))

# ── 2. Upload ──────────────────────────────────────────────────────────────
print("\n【2】 POST /upload")
session_id = None
try:
    with open(VIDEO_PATH, "rb") as f:
        r = requests.post(f"{BASE}/upload", files={"file": ("test_video.mp4", f, "video/mp4")}, timeout=30)
    check("status 200", r.status_code == 200, r.status_code)
    data = r.json()
    session_id = data.get("session_id")
    check("session_id present", bool(session_id), session_id)
    check("width > 0", data.get("width", 0) > 0, data.get("width"))
    check("height > 0", data.get("height", 0) > 0, data.get("height"))
    check("duration > 0", data.get("duration", 0) > 0, f"{data.get('duration'):.2f}s")
    check("fps > 0", data.get("fps", 0) > 0, data.get("fps"))
    check("codec reported", bool(data.get("codec")), data.get("codec"))
    print(f"     → session_id: {session_id}")
    print(f"     → {data.get('width')}x{data.get('height')} @ {data.get('fps')}fps  codec={data.get('codec')}")
except Exception as e:
    check("upload succeeded", False, str(e))

if not session_id:
    print("\n[ABORT] Cannot continue without session_id")
    sys.exit(1)

# ── 3. Extract by interval ─────────────────────────────────────────────────
print("\n【3】 POST /extract  mode=interval  interval=2.0s  JPG")
frames_data = []
try:
    r = requests.post(f"{BASE}/extract", data={
        "session_id": session_id,
        "mode": "interval",
        "interval": 2.0,
        "in_point": 0.0,
        "out_point": 8.0,
        "fmt": "jpg",
        "quality": 90,
        "scale": 100,
    }, timeout=60)
    check("status 200", r.status_code == 200, r.status_code)
    data = r.json()
    frames_data = data.get("frames", [])
    check("count ≥ 3", len(frames_data) >= 3, f"{len(frames_data)} frames")
    check("frames have url", all("url" in f for f in frames_data))
    check("frames have size", all(f.get("size", 0) > 0 for f in frames_data))
    print(f"     → Extracted {len(frames_data)} frames")
except Exception as e:
    check("interval extract succeeded", False, str(e))

# ── 4. Serve a frame image ─────────────────────────────────────────────────
print("\n【4】 GET /frame/{session_id}/{filename}")
if frames_data:
    first_frame = frames_data[0]
    try:
        url = f"{BASE}{first_frame['url']}"
        r = requests.get(url, timeout=10)
        check("status 200", r.status_code == 200, r.status_code)
        check("content-type image/jpeg", "image/jpeg" in r.headers.get("content-type", ""), r.headers.get("content-type"))
        check("body size > 0", len(r.content) > 0, f"{len(r.content)} bytes")
        print(f"     → Frame size: {len(r.content):,} bytes")
    except Exception as e:
        check("frame served", False, str(e))
else:
    check("frames available for test", False, "no frames from previous step")

# ── 5. Extract single frame ────────────────────────────────────────────────
print("\n【5】 POST /extract  mode=single  timestamp=3.5s  PNG")
try:
    r = requests.post(f"{BASE}/extract", data={
        "session_id": session_id,
        "mode": "single",
        "timestamp": 3.5,
        "in_point": 0.0,
        "out_point": 10.0,
        "fmt": "png",
        "quality": 100,
        "scale": 50,
    }, timeout=60)
    check("status 200", r.status_code == 200, r.status_code)
    data = r.json()
    frames_s = data.get("frames", [])
    check("exactly 1 frame", len(frames_s) == 1, len(frames_s))
    if frames_s:
        fu = f"{BASE}{frames_s[0]['url']}"
        r2 = requests.get(fu, timeout=10)
        check("PNG content-type", "image/png" in r2.headers.get("content-type", ""))
        check("PNG not empty", len(r2.content) > 0, f"{len(r2.content)} bytes")
        print(f"     → Single PNG frame: {len(r2.content):,} bytes")
except Exception as e:
    check("single extract succeeded", False, str(e))

# ── 6. Download ZIP ────────────────────────────────────────────────────────
print("\n【6】 GET /download/{session_id}")
try:
    # Restore interval frames first
    requests.post(f"{BASE}/extract", data={
        "session_id": session_id, "mode": "interval", "interval": 2.0,
        "in_point": 0.0, "out_point": 8.0, "fmt": "jpg", "quality": 90, "scale": 100,
    }, timeout=60)
    r = requests.get(f"{BASE}/download/{session_id}", timeout=30)
    check("status 200", r.status_code == 200, r.status_code)
    check("content-type zip", "zip" in r.headers.get("content-type", ""), r.headers.get("content-type"))
    check("zip size > 1KB", len(r.content) > 1024, f"{len(r.content):,} bytes")
    check("starts with PK (zip magic)", r.content[:2] == b"PK", r.content[:2])
    print(f"     → ZIP size: {len(r.content):,} bytes")
except Exception as e:
    check("zip download succeeded", False, str(e))

# ── 7. Upload rejection tests ──────────────────────────────────────────────
print("\n【7】 Error handling")
try:
    # Wrong content type
    r = requests.post(f"{BASE}/upload", files={"file": ("bad.txt", b"not a video", "text/plain")}, timeout=10)
    check("rejects non-video (400)", r.status_code == 400, r.status_code)
    # Invalid frame filename (path traversal)
    r = requests.get(f"{BASE}/frame/{session_id}/../../../etc/passwd", timeout=5)
    check("blocks path traversal (4xx)", r.status_code >= 400, r.status_code)
    # Unknown session
    r = requests.get(f"{BASE}/download/00000000-0000-0000-0000-000000000000", timeout=5)
    check("unknown session 404", r.status_code == 404, r.status_code)
except Exception as e:
    check("error handling tests", False, str(e))

# ── 8. Session cleanup ─────────────────────────────────────────────────────
print("\n【8】 DELETE /session/{session_id}")
try:
    r = requests.delete(f"{BASE}/session/{session_id}", timeout=10)
    check("status 200", r.status_code == 200, r.status_code)
    data = r.json()
    check("cleanup scheduled", "cleanup" in data.get("detail", "").lower(), data.get("detail"))
except Exception as e:
    check("session delete succeeded", False, str(e))

# ── Summary ─────────────────────────────────────────────────────────────────
passed = sum(results)
total = len(results)
print(f"\n{'═'*43}")
print(f"  Tests: {passed}/{total} passed {'✓' if passed == total else '✗'}")
print(f"{'═'*43}\n")
sys.exit(0 if passed == total else 1)
