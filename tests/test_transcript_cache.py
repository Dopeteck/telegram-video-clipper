"""Tests for private, content-addressed transcript caching."""
import io
import json

import pytest
import projects
import transcript_cache


class FakeClientError(Exception):
    def __init__(self, code):
        self.response = {"Error": {"Code": code, "Message": "not found"}}
        super().__init__(code)


class MemoryS3:
    def __init__(self):
        self.objects = {}

    def put_object(self, Bucket, Key, Body, **kwargs):
        self.objects[(Bucket, Key)] = bytes(Body)
        return {"ETag": '"test"'}

    def get_object(self, Bucket, Key):
        try:
            body = self.objects[(Bucket, Key)]
        except KeyError as error:
            raise FakeClientError("NoSuchKey") from error
        return {"Body": io.BytesIO(body)}


def _write_transcript(work_dir, video_path):
    work_dir.mkdir(parents=True, exist_ok=True)
    data = {
        "video": str(video_path),
        "language": "en",
        "language_probability": 0.99,
        "duration": 240.5,
        "model": "medium",
        "segments": [{"start": 0.0, "end": 1.0, "text": "Hello."}],
        "words": [{"word": "Hello.", "start": 0.0, "end": 1.0}],
    }
    (work_dir / "transcript.json").write_text(
        json.dumps(data), encoding="utf-8"
    )


def _options():
    options = dict(projects.DEFAULT_OPTIONS)
    options.update({
        "aspect": "9:16",
        "style": "default",
        "max_clips": 3,
        "min_score": 5.5,
        "min_len": 60,
        "max_len": 180,
        "llm": "qwen3:4b-instruct-2507-q4_K_M",
        "strict_llm": True,
    })
    return options


def test_transcript_cache_round_trip_restores_project_resume_state(tmp_path):
    video = tmp_path / "source.mp4"
    video.write_bytes(b"same source video bytes")
    source_work = tmp_path / "source-work"
    _write_transcript(source_work, video)
    client = MemoryS3()

    stored = transcript_cache.store_transcript(
        video, source_work, client, "private-bucket",
        model_size="medium", device="cpu", language=None,
    )
    assert stored["stored"] is True
    assert stored["source_sha256"] == transcript_cache.source_sha256(video)

    restored_work = tmp_path / "restored-work"
    restored = transcript_cache.restore_transcript(
        video, restored_work, client, "private-bucket", _options(),
        model_size="medium", device="cpu", language=None,
    )
    assert restored["hit"] is True
    assert restored["key"] == stored["key"]
    assert (restored_work / "transcript.json").is_file()

    state = projects.read_project(restored_work)
    identity = projects.file_identity(video)
    assert state["video"] == str(video.resolve())
    assert state["cache"]["source"] == projects.digest(identity)
    assert state["cache"]["transcript"] == projects.digest([
        identity, "medium", "cpu", None
    ])
    assert state["options"]["strict_llm"] is True


def test_transcript_cache_misses_when_source_bytes_change(tmp_path):
    video = tmp_path / "source.mp4"
    video.write_bytes(b"first source")
    work_dir = tmp_path / "work"
    _write_transcript(work_dir, video)
    client = MemoryS3()
    transcript_cache.store_transcript(video, work_dir, client, "private-bucket")

    video.write_bytes(b"different source")
    restored = transcript_cache.restore_transcript(
        video, tmp_path / "restored", client, "private-bucket", _options()
    )

    assert restored["hit"] is False
    assert "no cached transcript" in restored["reason"]
    assert not (tmp_path / "restored" / "transcript.json").exists()


def test_transcript_cache_rejects_invalid_cached_json(tmp_path):
    video = tmp_path / "source.mp4"
    video.write_bytes(b"source")
    source_hash = transcript_cache.source_sha256(video)
    key = transcript_cache.transcript_cache_key(source_hash)
    client = MemoryS3()
    client.put_object(
        Bucket="private-bucket", Key=key, Body=b"{broken json"
    )

    restored = transcript_cache.restore_transcript(
        video, tmp_path / "restored", client, "private-bucket", _options()
    )

    assert restored["hit"] is False
    assert "not valid UTF-8 JSON" in restored["reason"]
    assert not (tmp_path / "restored" / "project.json").exists()
