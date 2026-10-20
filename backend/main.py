"""
FrameForge Backend — FastAPI + FFmpeg
Provides server-side MP4 → image frame extraction.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import subprocess
import tempfile
import uuid
import zipfile
from pathlib import Path
from typing import Optional

import aiofiles
from fastapi import (BackgroundTasks, FastAPI, File, Form, HTTPException,
                     Request, UploadFile)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse

# ──────────────────────────────────────────────────────────────────────────────
# App setup
# ──────────────────────────────────────────────────────────────────────────────
app = FastAPI(title="FrameForge API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

WORK_DIR = Path(tempfile.gettempdir()) / "frameforge"
WORK_DIR.mkdir(parents=True, exist_ok=True)

FFMPEG = shutil.which("ffmpeg") or "ffmpeg"
FFPROBE = shutil.which("ffprobe") or "ffprobe"

MAX_UPLOAD_MB = 500
MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024


# ──────────────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────────────
def _session_dir(session_id: str) -> Path:
    d = WORK_DIR / session_id
    d.mkdir(parents=True, exist_ok=True)
    return d


def _cleanup(session_id: str) -> None:
    d = WORK_DIR / session_id
    if d.exists():
        shutil.rmtree(d, ignore_errors=True)


def _probe_video(path: Path) -> dict:
    cmd = [
        FFPROBE, "-v", "quiet", "-print_format", "json",
        "-show_streams", "-show_format", str(path),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    if result.returncode != 0:
        raise RuntimeError(f"ffprobe failed: {result.stderr}")
    data = json.loads(result.stdout)

    video_stream = next(
        (s for s in data.get("streams", []) if s.get("codec_type") == "video"),
        {},
    )

    fps_raw = video_stream.get("avg_frame_rate", "30/1")
    try:
        num, den = map(int, fps_raw.split("/"))
        fps = round(num / den, 3) if den else 30.0
    except Exception:
        fps = 30.0

    duration = float(data.get("format", {}).get("duration", 0))

    return {
        "width": video_stream.get("width", 0),
        "height": video_stream.get("height", 0),
        "fps": fps,
        "duration": duration,
        "codec": video_stream.get("codec_name", "unknown"),
        "size": int(data.get("format", {}).get("size", 0)),
        "bit_rate": int(data.get("format", {}).get("bit_rate", 0)),
        "nb_frames": video_stream.get("nb_frames", "N/A"),
    }


def _build_vf(scale: int, width: int, height: int) -> str:
    if scale >= 100:
        return ""
    factor = scale / 100.0
    out_w = int(width * factor) & ~1
    out_h = int(height * factor) & ~1
    return f"scale={out_w}:{out_h}:flags=lanczos"


# ──────────────────────────────────────────────────────────────────────────────
# Routes
# ──────────────────────────────────────────────────────────────────────────────
@app.get("/health")
async def health():
    return {"status": "ok", "ffmpeg": FFMPEG, "ffprobe": FFPROBE}


@app.post("/upload")
async def upload_video(file: UploadFile = File(...)):
    if not file.content_type or not file.content_type.startswith("video/"):
        raise HTTPException(400, detail="Only video files are accepted.")

    session_id = str(uuid.uuid4())
    sdir = _session_dir(session_id)

    suffix = Path(file.filename or "upload.mp4").suffix or ".mp4"
    video_path = sdir / f"source{suffix}"
    size_written = 0

    async with aiofiles.open(video_path, "wb") as f:
        while True:
            chunk = await file.read(1024 * 1024)
            if not chunk:
                break
            size_written += len(chunk)
            if size_written > MAX_UPLOAD_BYTES:
                _cleanup(session_id)
                raise HTTPException(413, detail=f"File exceeds {MAX_UPLOAD_MB} MB limit.")
            await f.write(chunk)

    try:
        meta = _probe_video(video_path)
    except Exception as exc:
        _cleanup(session_id)
        raise HTTPException(422, detail=f"Could not read video metadata: {exc}")

    meta_path = sdir / "meta.json"
    with open(meta_path, "w") as mf:
        json.dump({**meta, "video_path": str(video_path), "session_id": session_id}, mf)

    return JSONResponse({
        "session_id": session_id,
        "filename": file.filename,
        **meta,
    })


@app.post("/extract")
async def extract_frames(
    session_id: str = Form(...),
    mode: str = Form("interval"),
    interval: float = Form(5.0),
    in_point: float = Form(0.0),
    out_point: float = Form(0.0),
    fmt: str = Form("jpg"),
    quality: int = Form(92),
    scale: int = Form(100),
    timestamp: Optional[float] = Form(None),
):
    sdir = _session_dir(session_id)
    meta_path = sdir / "meta.json"
    if not meta_path.exists():
        raise HTTPException(404, detail="Session not found. Upload video first.")

    with open(meta_path) as mf:
        meta = json.load(mf)

    video_path = Path(meta["video_path"])
    if not video_path.exists():
        raise HTTPException(404, detail="Source video missing from session.")

    frames_dir = sdir / "frames"
    if frames_dir.exists():
        shutil.rmtree(frames_dir)
    frames_dir.mkdir(parents=True)

    w = meta.get("width", 1920)
    h = meta.get("height", 1080)
    duration = meta.get("duration", 0.0)

    vf = _build_vf(scale, w, h)
    if out_point <= in_point:
        out_point = duration

    ext = "jpg" if fmt == "jpg" else "png"
    # ffmpeg qscale: 2 = best, 31 = worst. Map 100→2, 1→31.
    quality_arg = str(max(2, min(31, int(2 + (100 - quality) * 0.29))))
    frame_pattern = str(frames_dir / f"frame_%04d.{ext}")

    if mode == "single":
        ts = timestamp if timestamp is not None else in_point
        ts = max(in_point, min(out_point, ts))
        cmd = [FFMPEG, "-y", "-ss", str(ts), "-i", str(video_path), "-frames:v", "1"]
        if vf:
            cmd += ["-vf", vf]
        if fmt == "jpg":
            cmd += ["-q:v", quality_arg]
        cmd.append(frame_pattern)

    elif mode == "interval":
        filters = [f"fps=1/{interval}"]
        if vf:
            filters.append(vf)
        cmd = [FFMPEG, "-y", "-ss", str(in_point), "-to", str(out_point),
               "-i", str(video_path), "-vf", ",".join(filters)]
        if fmt == "jpg":
            cmd += ["-q:v", quality_arg]
        cmd.append(frame_pattern)

    else:  # all frames
        cmd = [FFMPEG, "-y", "-ss", str(in_point), "-to", str(out_point),
               "-i", str(video_path)]
        if vf:
            cmd += ["-vf", vf]
        if fmt == "jpg":
            cmd += ["-q:v", quality_arg]
        cmd.append(frame_pattern)

    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        if proc.returncode != 0:
            raise HTTPException(500, detail=f"FFmpeg error: {proc.stderr[-800:]}")
    except subprocess.TimeoutExpired:
        raise HTTPException(504, detail="Frame extraction timed out.")

    frame_files = sorted(frames_dir.glob(f"*.{ext}"))
    if not frame_files:
        raise HTTPException(422, detail="No frames extracted. Check your in/out points.")

    frames_info = [
        {
            "id": fp.stem,
            "index": i + 1,
            "filename": fp.name,
            "size": fp.stat().st_size,
            "url": f"/frame/{session_id}/{fp.name}",
        }
        for i, fp in enumerate(frame_files)
    ]

    return JSONResponse({"session_id": session_id, "frames": frames_info, "count": len(frames_info)})


@app.get("/frame/{session_id}/{filename}")
async def get_frame(session_id: str, filename: str):
    if not re.match(r'^frame_\d+\.(jpg|png)$', filename):
        raise HTTPException(400, detail="Invalid frame filename.")
    frame_path = WORK_DIR / session_id / "frames" / filename
    if not frame_path.exists():
        raise HTTPException(404, detail="Frame not found.")
    media_type = "image/jpeg" if filename.endswith(".jpg") else "image/png"
    return FileResponse(str(frame_path), media_type=media_type,
                        headers={"Cache-Control": "max-age=3600"})


@app.get("/download/{session_id}")
async def download_zip(session_id: str):
    frames_dir = WORK_DIR / session_id / "frames"
    if not frames_dir.exists():
        raise HTTPException(404, detail="No frames found for this session.")

    frame_files = sorted(frames_dir.glob("frame_*.*"))
    if not frame_files:
        raise HTTPException(404, detail="Frames directory is empty.")

    zip_path = WORK_DIR / session_id / "frames_export.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for fp in frame_files:
            zf.write(fp, fp.name)

    def iterfile():
        with open(zip_path, "rb") as f:
            yield from iter(lambda: f.read(65536), b"")

    headers = {
        "Content-Disposition": f'attachment; filename="frameforge_export_{len(frame_files)}_frames.zip"',
    }
    return StreamingResponse(iterfile(), media_type="application/zip", headers=headers)


@app.delete("/session/{session_id}")
async def delete_session(session_id: str, background_tasks: BackgroundTasks):
    if not re.match(r'^[0-9a-f\-]{36}$', session_id):
        raise HTTPException(400, detail="Invalid session ID.")
    background_tasks.add_task(_cleanup, session_id)
    return {"detail": "Session cleanup scheduled."}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
