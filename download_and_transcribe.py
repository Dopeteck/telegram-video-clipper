"""
Stage 1 of the viral-clip pipeline.

Local files stay in place. Network URLs go through yt-dlp. YouTube sources are
handled metadata-first: only English subtitles are fetched for transcript
scoring, and selected timestamp ranges are cut out with yt-dlp section
downloading (or an ffmpeg local-cut fallback) so the complete source file is
never transferred unnecessarily.

No external/paid APIs. CPU-friendly (int8). Usage:
    python download_and_transcribe.py <youtube_url> --model small
"""
import hashlib
import json
import argparse
import subprocess
import sys
import tempfile
import time
import shutil
from urllib.parse import urlparse, urlunparse
from pathlib import Path

import yt_dlp
from yt_dlp.utils import DownloadError


def run(cmd):
    print(">", " ".join(str(c) for c in cmd), flush=True)
    subprocess.run(cmd, check=True)


# ------------------------------------------------------------------ sources

YOUTUBE_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com",
                 "youtube-nocookie.com", "youtu.be"}


def is_network_source(source):
    return urlparse(str(source)).scheme in {"http", "https"}


def is_youtube_url(source):
    if not is_network_source(source):
        return False
    host = urlparse(str(source)).hostname or ""
    return host in YOUTUBE_HOSTS or host.endswith("." + "youtube.com")


def normalize_url(url):
    """Drop tracking/query noise so the same video reuses cached work."""
    parts = urlparse(url.strip())
    query = "&".join(
        q for q in (parts.query or "").split("&")
        if not q.split("=", 1)[0] in {"si", "feature", "t", "start_at", "end"})
    return urlunparse((parts.scheme, parts.hostname, parts.path, parts.params,
                       query, parts.fragment))


def _download(url, workdir, fmt="bestvideo*+bestaudio/best"):
    out_tmpl = workdir / "source.%(ext)s"
    cmd = [
        sys.executable, "-m", "yt_dlp",
        "-f", fmt,
        "--merge-output-format", "mp4",
        "--no-playlist",
        "-o", str(out_tmpl),
        url,
    ]
    last_error = None
    for attempt in range(1, 4):
        try:
            run(cmd)
            break
        except subprocess.CalledProcessError as exc:  # rate limits / 4xx blips
            last_error = exc
            if attempt < 3:
                time.sleep(min(2 ** attempt, 20))
    else:
        raise last_error
    vids = [p for p in sorted(workdir.glob("source.*"))
            if p.suffix.lower() in (".mp4", ".mkv", ".webm", ".mov", ".m4v", ".avi")]
    if not vids:
        raise SystemExit("Download failed: no video file produced.")
    return vids[0].resolve()


def download_youtube_source(url, workdir):
    """Download a YouTube source at a modest capped resolution (no 4K/6 GB grabs)."""
    workdir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="download-", dir=workdir) as temp:
        video = _download(url, Path(temp),
                          fmt="bestvideo[height<=1080]*+bestaudio/"
                              "best[height<=1080]/best")
        destination = workdir / video.name
        shutil.move(str(video), str(destination))
        return destination.resolve()


def resolve_source(source, workdir):
    """Keep local files in place; only network URLs go through yt-dlp."""
    path = Path(source).expanduser()
    if path.is_file():
        if path.suffix.lower() not in {".mp4", ".mkv", ".webm", ".mov", ".m4v", ".avi"}:
            raise ValueError("Use a video file: MP4, MKV, WebM, MOV, M4V or AVI.")
        return path.resolve()
    if urlparse(source).scheme not in {"http", "https"}:
        raise ValueError(f"Video file does not exist or URL is invalid: {source}")
    return download(source, Path(workdir))


def download(url, workdir):
    """Full-source download (unchanged behaviour for local/URL workflows)."""
    workdir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="download-", dir=workdir) as temp:
        video = _download(url, Path(temp))
        destination = workdir / video.name
        shutil.move(str(video), str(destination))
        return destination.resolve()


# ---------------------------------------------------------------- metadata

def inspect_source(url):
    """YouTube metadata without downloading video: id, title, duration,
    available subtitle languages. Raises RuntimeError on lookup failure."""
    url = normalize_url(url)
    ydl_opts = {"quiet": True, "no_warnings": True, "skip_download": True}
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
    except DownloadError as exc:
        raise RuntimeError(
            f"YouTube lookup failed for {url}: {exc}") from exc
    except Exception as exc:  # network / rate limit / expired URL
        raise RuntimeError(f"YouTube lookup failed for {url}: {exc}") from exc
    subs = info.get("subtitles") or {}
    auto = info.get("automatic_captions") or {}
    return {
        "id": info.get("id"),
        "title": info.get("title"),
        "duration": float(info.get("duration") or 0.0),
        "uploader": info.get("uploader"),
        "manual_subtitles": sorted(subs.keys()),
        "automatic_subtitles": sorted(auto.keys()),
        "url": url,
    }


# --------------------------------------------------------------- subtitles

def download_subtitles(url, workdir, langs=("en", "en-orig")):
    """Download only subtitle files (manual first, then auto-generated).
    Returns the .srt path or None when no matching subtitles exist."""
    workdir.mkdir(parents=True, exist_ok=True)
    out_tmpl = str(workdir / "subs.%(lang)s.%(ext)s")
    for flag in ("--write-subs", "--write-auto-subs"):
        cmd = [
            sys.executable, "-m", "yt_dlp",
            "--skip-download", flag, "--convert-subs", "srt",
            "--sub-langs", ",".join(langs),
            "--no-playlist",
            "-o", out_tmpl,
            url,
        ]
        try:
            run(cmd)
        except subprocess.CalledProcessError:
            continue
        candidates = sorted(workdir.glob("subs.*.srt"))
        # Prefer an exact language match, accept any downloaded subtitle.
        for lang in langs:
            exact = workdir / f"subs.{lang}.srt"
            if exact.exists():
                return exact.resolve()
        if candidates:
            # Remove sibling subtitle files we won't use, keep the project tidy.
            for extra in candidates[1:]:
                try:
                    extra.unlink()
                except OSError:
                    pass
            return candidates[0].resolve()
    return None


def _srt_time(text):
    # hh:mm:ss,mmm
    parts = text.replace(",", ".").split(":")
    secs = float(parts[2])
    return int(parts[0]) * 3600 + int(parts[1]) * 60 + secs


def parse_srt(path):
    segments = []
    raw = Path(path).read_text(encoding="utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")
    for block in raw.strip().split("\n\n"):
        lines = block.strip().splitlines()
        if len(lines) < 3:
            continue
        times = lines[1].split("-->")
        if len(times) != 2:
            continue
        text = " ".join(t.strip() for t in lines[2:])
        segments.append({
            "start": round(_srt_time(times[0]), 3),
            "end": round(_srt_time(times[1]), 3),
            "text": text,
        })
    segments.sort(key=lambda s: s["start"])
    return segments


def subtitles_to_transcript(sub_path, source_url, duration, out_path=None):
    """Build a transcript.json-shaped dict from subtitle segments. Word
    timestamps are spread evenly across each subtitle segment (subtitles have
    no word-level resolution; selected sections are re-transcribed later for
    accurate word-level captions)."""
    segments = parse_srt(sub_path)
    words = []
    for seg in segments:
        tokens = seg["text"].split()
        n = len(tokens)
        span = max(0.01, seg["end"] - seg["start"])
        for i, token in enumerate(tokens):
            if n == 1:
                start, end = seg["start"], seg["end"]
            else:
                step = span / n
                start = round(seg["start"] + i * step, 3)
                end = round(seg["start"] + (i + 1) * step, 3)
            words.append({"word": token, "start": start, "end": end})
    transcript = {
        "video": str(source_url),
        "language": "en",
        "duration": float(duration),
        "model": "youtube-subtitles",
        "segments": segments,
        "words": words,
    }
    if out_path is not None:
        Path(out_path).write_text(
            json.dumps(transcript, ensure_ascii=False, indent=2), encoding="utf-8")
    return transcript


# ------------------------------------------------------------- section cuts

def download_section(url, start, end, workdir, source=None, retries=3):
    """Extract one timestamp range [start, end] as an exact mp4 section.

    Prefers yt-dlp section downloading when no local source exists; otherwise
    cuts the local source with ffmpeg (exact re-encoded cut, no keyframe
    drift). Retries per section on failure; partial files are removed.
    """
    workdir.mkdir(parents=True, exist_ok=True)
    key = hashlib.sha256(
        json.dumps([url, start, end], sort_keys=True).encode()).hexdigest()[:12]
    out = workdir / f"section-{key}.mp4"
    if out.exists():
        return out.resolve()

    last_error = None
    for attempt in range(1, retries + 1):
        partial = workdir / f"section-{key}.partial"
        try:
            if source is not None and Path(source).exists():
                _local_cut(Path(source), start, end, out)
                return out.resolve()
            _yt_dlp_section(url, start, end, workdir, key)
            produced = out if out.exists() else next(
                (p for p in workdir.glob(f"section-{key}.*")
                 if p.suffix.lower() in (".mp4", ".mkv", ".webm", ".mov")),
                None)
            if produced is None:
                raise RuntimeError("Section download produced no file.")
            if produced != out:
                shutil.move(str(produced), str(out))
            return out.resolve()
        except Exception as exc:  # noqa: BLE001 - surface last error after retries
            last_error = exc
            for tmpf in (out, partial):
                try:
                    tmpf.unlink()
                except OSError:
                    pass
            if attempt < retries:
                time.sleep(min(2 ** attempt, 15))
    raise RuntimeError(
        f"YouTube section extraction failed after {retries} attempts "
        f"({start}s-{end}s): {last_error}")


def _yt_dlp_section(url, start, end, workdir, key):
    out_tmpl = workdir / f"section-{key}.%(ext)s"
    # --force-keyframes-at-cuts re-encodes the section so its start is exact.
    # Max 1080p to avoid transferring unnecessary resolution.
    cmd = [
        sys.executable, "-m", "yt_dlp",
        "-f", "bestvideo[height<=1080]*+bestaudio/"
            "best[height<=1080]/best",
        "--merge-output-format", "mp4",
        "--force-keyframes-at-cuts",
        "--no-playlist",
        "--download-sections", f"*{start}-{end}",
        "-o", str(out_tmpl),
        url,
    ]
    run(cmd)


def _local_cut(source, start, end, out):
    dur = end - start
    cmd = [
        "ffmpeg", "-y", "-hide_banner", "-ss", f"{start:.3f}",
        "-i", str(source), "-t", f"{dur:.3f}",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "160k", str(out),
    ]
    subprocess.run(cmd, check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def cleanup_files(*paths):
    for p in paths:
        try:
            Path(p).unlink()
        except OSError:
            pass


# ------------------------------------------------------------------ transcribe

def transcribe_words(video, model_size, device, compute_type, language=None):
    """Word-level transcription of a video file. Returns (words, info)."""
    from faster_whisper import WhisperModel
    print(f"Loading faster-whisper model={model_size} device={device} "
          f"compute={compute_type} (first run downloads the model)...", flush=True)
    model = WhisperModel(model_size, device=device, compute_type=compute_type)
    segments, info = model.transcribe(str(video), word_timestamps=True,
                                      vad_filter=True, language=language)
    print(f"Detected language: {info.language} "
          f"(p={getattr(info, 'language_probability', None) or 0:.2f}), "
          f"audio {info.duration:.1f}s", flush=True)

    words = []
    seg_list = []
    for seg in segments:
        quality = {}
        for name in ("avg_logprob", "no_speech_prob", "compression_ratio"):
            value = getattr(seg, name, None)
            if value is not None:
                quality[name] = float(value)
        seg_list.append({"start": seg.start, "end": seg.end, "text": seg.text,
                         "quality": quality})
        for w in (seg.words or []):
            words.append({"word": w.word, "start": w.start, "end": w.end})
    return words, {
        "language": info.language,
        "language_probability": getattr(info, "language_probability", None),
        "expected_language": language,
        "duration": info.duration,
        "segments": seg_list,
    }


def transcribe(video, workdir, model_size, device, compute_type, language=None):
    words, info = transcribe_words(video, model_size, device, compute_type, language)
    print(f"Detected language: {info['language']}, "
          f"audio {info['duration']:.1f}s", flush=True)
    transcript = {
        "video": str(video),
        "language": info["language"],
        "language_probability": info.get("language_probability"),
        "expected_language": info.get("expected_language"),
        "duration": info["duration"],
        "model": model_size,
        "segments": info["segments"],
        "words": words,
    }
    out = Path(workdir) / "transcript.json"
    out.write_text(json.dumps(transcript, ensure_ascii=False, indent=2),
                   encoding="utf-8")
    print(f"Wrote {out}  ({len(words)} words, {len(info['segments'])} segments)",
          flush=True)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("url")
    ap.add_argument("--workdir", default="work")
    ap.add_argument("--model", default="medium",
                    help="faster-whisper model: tiny/base/small/medium/large-v3")
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--compute-type", default="int8")
    ap.add_argument("--language", default=None,
                    help="expected spoken language code (for example en, yo, or pcm); default auto-detect")
    args = ap.parse_args()

    workdir = Path(args.workdir)
    workdir.mkdir(parents=True, exist_ok=True)

    video = resolve_source(args.url, workdir)
    print("Downloaded:", video, flush=True)
    transcribe(video, workdir, args.model, args.device, args.compute_type, args.language)
    print("STAGE 1 COMPLETE", flush=True)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        raise SystemExit(130)
