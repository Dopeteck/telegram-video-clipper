"""Lightweight audiovisual signals for highlight ranking (FFmpeg + OpenCV only).

This is a ranking aid, not a music/ emotion classifier. Audio loudness and
shot-change density can surface energetic passages that transcript-only
scoring misses; they cannot determine artistic quality by themselves.
"""
import math
import shutil
import subprocess
import tempfile
import wave
from pathlib import Path

import cv2
import struct


def _audio_envelope(video_path, window=0.5):
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg is required for audiovisual scoring")
    with tempfile.TemporaryDirectory() as td:
        wav_path = Path(td) / "audio.wav"
        subprocess.run(
            [ffmpeg, "-v", "error", "-y", "-i", str(video_path), "-vn",
             "-ac", "1", "-ar", "8000", "-c:a", "pcm_s16le", str(wav_path)],
            check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
        )
        with wave.open(str(wav_path), "rb") as wav:
            rate, width, frames = wav.getframerate(), wav.getsampwidth(), wav.getnframes()
            raw = wav.readframes(frames)
        if width != 2 or not raw:
            return []
        samples = struct.unpack("<" + "h" * (len(raw) // 2), raw)
    step = max(1, int(rate * window))
    envelope = []
    for offset in range(0, len(samples), step):
        chunk = samples[offset:offset + step]
        if not chunk:
            continue
        rms = math.sqrt(sum(v * v for v in chunk) / len(chunk)) / 32768.0
        envelope.append((offset / rate, rms))
    return envelope


def _scene_changes(video_path, sample_fps=1.0):
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg is required for visual scene analysis")
    # Let FFmpeg decode/sample at 1 fps and downscale before Python sees frames.
    command = [ffmpeg, "-v", "error", "-i", str(video_path), "-vf",
               f"fps={sample_fps},scale=96:54,format=gray", "-f", "rawvideo",
               "-pix_fmt", "gray", "pipe:1"]
    proc = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    frame_size = 96 * 54
    previous = None
    changes = []
    frame_index = 0
    try:
        while True:
            raw = proc.stdout.read(frame_size)
            if len(raw) != frame_size:
                break
            frame = bytearray(raw)
            if previous is not None:
                delta = sum(abs(a - b) for a, b in zip(frame, previous)) / (frame_size * 255.0)
                if delta >= 0.16:
                    changes.append(frame_index / sample_fps)
            previous = frame
            frame_index += 1
        stderr = proc.stderr.read().decode("utf-8", "replace")
        code = proc.wait()
        if code:
            raise RuntimeError(f"FFmpeg scene sampling failed: {stderr[-500:]}")
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
    return changes, frame_index / sample_fps

def _percentile(values, fraction):
    if not values:
        return 0.0
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, max(0, int(round((len(ordered) - 1) * fraction))))]


def extract_features(video_path):
    """Return time-indexed audio RMS and sampled visual cut times."""
    audio = _audio_envelope(video_path)
    cuts, duration = _scene_changes(video_path)
    rms_values = [v for _, v in audio]
    # Robust normalization prevents one explosion/music hit dominating the file.
    floor = _percentile(rms_values, 0.25)
    ceiling = max(floor + 1e-5, _percentile(rms_values, 0.90))
    normalized = [
        (t, min(1.0, max(0.0, (rms - floor) / (ceiling - floor))))
        for t, rms in audio
    ]
    return {"audio": normalized, "scene_changes": cuts, "duration": duration}


def score_interval(features, start, end):
    """Normalized audio intensity and visual cut density for a time window."""
    audio = [(t, v) for t, v in features.get("audio", []) if start <= t < end]
    audio_score = (sum(v for _, v in audio) / len(audio)) if audio else 0.0
    cuts = [t for t in features.get("scene_changes", []) if start <= t < end]
    duration = max(1.0, end - start)
    # A modest number of cuts is evidence of visual activity; cap to avoid rewarding chaos.
    scene_score = min(1.0, (len(cuts) / duration) / 0.35)
    return round(audio_score, 3), round(scene_score, 3), len(cuts)
