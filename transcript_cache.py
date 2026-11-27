"""Private, content-addressed R2 cache for reusable Whisper transcripts."""
import hashlib
import io
import json
import math
import re
from pathlib import Path


CACHE_PREFIX = "transcript-cache/v1"


def source_sha256(video_path, chunk_size=8 * 1024 * 1024):
    """Hash the actual source bytes so cache reuse is independent of temp paths."""
    digest = hashlib.sha256()
    with Path(video_path).open("rb") as source:
        for chunk in iter(lambda: source.read(chunk_size), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _safe_key_part(value, default):
    value = str(value or default).strip().lower()
    cleaned = re.sub(r"[^a-z0-9_-]+", "-", value).strip("-")
    return cleaned or default


def transcript_cache_key(source_hash, model_size="medium", device="cpu", language=None):
    if not re.fullmatch(r"[a-f0-9]{64}", str(source_hash or "")):
        raise ValueError("source_hash must be a SHA-256 hex digest")
    model = _safe_key_part(model_size, "medium")
    runtime = _safe_key_part(device, "cpu")
    lang = _safe_key_part(language, "auto")
    return f"{CACHE_PREFIX}/{model}/{runtime}/{lang}/{source_hash}.json"


def _decode_transcript(raw):
    try:
        data = json.loads(raw.decode("utf-8-sig") if isinstance(raw, bytes) else raw)
    except (UnicodeDecodeError, json.JSONDecodeError, TypeError) as error:
        raise ValueError(f"cached transcript is not valid UTF-8 JSON: {error}") from error
    if not isinstance(data, dict):
        raise ValueError("cached transcript must be a JSON object")
    if not isinstance(data.get("words"), list) or not isinstance(data.get("segments"), list):
        raise ValueError("cached transcript is missing word or segment arrays")
    try:
        duration = float(data.get("duration"))
    except (TypeError, ValueError) as error:
        raise ValueError("cached transcript has no valid duration") from error
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError("cached transcript duration must be positive and finite")
    return data


def create_r2_client(account_id, access_key_id, secret_access_key):
    """Create the private Cloudflare R2 S3-compatible client."""
    import boto3
    from botocore.config import Config

    return boto3.client(
        "s3",
        endpoint_url=f"https://{account_id}.r2.cloudflarestorage.com",
        aws_access_key_id=access_key_id,
        aws_secret_access_key=secret_access_key,
        config=Config(
            signature_version="s3v4",
            connect_timeout=20,
            read_timeout=120,
            retries={"mode": "standard", "total_max_attempts": 5},
        ),
        region_name="auto",
    )


def restore_transcript(video_path, work_dir, s3_client, bucket, options,
                       model_size="medium", device="cpu", language=None):
    """Restore a matching transcript and seed project resume metadata.

    A cache hit is accepted only when the source bytes and transcription
    settings match. The project cache keys are recalculated for this runner's
    local path/mtime so projects.run_project safely skips only the Whisper stage.
    """
    from projects import (
        DEFAULT_OPTIONS, atomic_json, digest, file_identity,
        init_project, read_project, save_project, validate_options,
    )

    video_path = Path(video_path).resolve()
    work_dir = Path(work_dir).resolve()
    if not video_path.is_file():
        raise FileNotFoundError(f"video source does not exist: {video_path}")

    source_hash = source_sha256(video_path)
    key = transcript_cache_key(source_hash, model_size, device, language)
    try:
        response = s3_client.get_object(Bucket=bucket, Key=key)
    except Exception as error:  # boto3 is optional outside the processing workflow
        response_data = getattr(error, "response", {}) or {}
        code = str((response_data.get("Error") or {}).get("Code", ""))
        if code in {"NoSuchKey", "NotFound", "404"}:
            return {"hit": False, "source_sha256": source_hash, "key": key,
                    "reason": "no cached transcript for this source"}
        raise

    raw = response["Body"].read()
    try:
        transcript = _decode_transcript(raw)
    except ValueError as error:
        return {"hit": False, "source_sha256": source_hash, "key": key,
                "reason": str(error)}

    options = validate_options({**DEFAULT_OPTIONS, **(options or {})})
    identity = file_identity(video_path)
    work_dir.mkdir(parents=True, exist_ok=True)
    transcript["video"] = str(video_path)
    atomic_json(work_dir / "transcript.json", transcript)

    project_file = work_dir / "project.json"
    if project_file.exists():
        state = read_project(work_dir)
    else:
        state = init_project(work_dir, str(video_path), options)
    state["source"] = str(video_path)
    state["options"] = options
    state["video"] = str(video_path)
    state.setdefault("cache", {})
    state["cache"]["source"] = digest(identity)
    state["cache"]["transcript"] = digest([
        identity, options["whisper_model"], options["device"], options.get("language")
    ])
    state["source_identity"] = identity
    state["sub_path"] = None
    save_project(work_dir, state)

    return {"hit": True, "source_sha256": source_hash, "key": key,
            "bytes": len(raw), "reason": "source and Whisper settings matched"}


def store_transcript(video_path, work_dir, s3_client, bucket, source_hash=None,
                     model_size="medium", device="cpu", language=None):
    """Store a valid transcript privately in R2 after transcription completes."""
    transcript_path = Path(work_dir) / "transcript.json"
    video_path = Path(video_path)
    if not video_path.is_file():
        return {"stored": False, "reason": "source video is unavailable"}
    if not transcript_path.is_file():
        return {"stored": False, "reason": "no transcript was produced"}

    raw = transcript_path.read_bytes()
    _decode_transcript(raw)
    source_hash = source_hash or source_sha256(video_path)
    key = transcript_cache_key(source_hash, model_size, device, language)
    s3_client.put_object(
        Bucket=bucket,
        Key=key,
        Body=raw,
        ContentType="application/json",
        Metadata={
            "source-sha256": source_hash,
            "cache-version": "1",
            "whisper-model": _safe_key_part(model_size, "medium"),
            "device": _safe_key_part(device, "cpu"),
            "language": _safe_key_part(language, "auto"),
        },
    )
    return {"stored": True, "key": key, "bytes": len(raw),
            "source_sha256": source_hash}
