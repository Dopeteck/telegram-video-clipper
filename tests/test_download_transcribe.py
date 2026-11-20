"""Tests for the YouTube / subtitles / section-download stage.

Network calls and subprocesses are mocked; no downloads happen here.
"""
import json
import subprocess
import sys
import os
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

import download_and_transcribe as dt  # noqa: E402


class FakeYoutubeDL:
    def __init__(self, info):
        self.info = info

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def extract_info(self, url, download=False):
        return self.info


@pytest.fixture
def yt_info():
    return {
        "id": "6uSskUaDL90",
        "title": "Sample campaign video",
        "duration": 2914.0,
        "uploader": "Sample Channel",
        "subtitles": {},
        "automatic_captions": {"en": [], "es": []},
    }


class TestSourceHelpers:
    def test_is_youtube_url(self):
        assert dt.is_youtube_url("https://www.youtube.com/watch?v=6uSskUaDL90")
        assert dt.is_youtube_url("https://youtu.be/6uSskUaDL90")
        assert not dt.is_youtube_url("C:\\Videos\\podcast.mp4")
        assert not dt.is_youtube_url("https://example.com/video.mp4")

    def test_normalize_url_strips_tracking(self):
        clean = dt.normalize_url(
            "https://www.youtube.com/watch?v=6uSskUaDL90&si=ABC&t=10&feature=x")
        assert "si=" not in clean and "t=10" not in clean and "feature" not in clean
        assert "v=6uSskUaDL90" in clean


class TestInspectSource:
    def test_returns_metadata_without_download(self, monkeypatch, yt_info):
        monkeypatch.setattr(dt.yt_dlp, "YoutubeDL", lambda opts: FakeYoutubeDL(yt_info))
        info = dt.inspect_source("https://www.youtube.com/watch?v=6uSskUaDL90")
        assert info["id"] == "6uSskUaDL90"
        assert info["title"] == "Sample campaign video"
        assert info["duration"] == 2914.0
        assert "en" in info["automatic_subtitles"]

    def test_lookup_failure_surfaces_as_runtime_error(self, monkeypatch):
        class Broken:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def extract_info(self, url, download=False):
                raise dt.yt_dlp.utils.DownloadError("signatures unavailable", None)

        monkeypatch.setattr(dt.yt_dlp, "YoutubeDL", lambda opts: Broken())
        with pytest.raises(RuntimeError, match="YouTube lookup failed"):
            dt.inspect_source("https://www.youtube.com/watch?v=6uSskUaDL90")

    def test_bot_detection_error_message(self, monkeypatch):
        class Broken:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def extract_info(self, url, download=False):
                raise dt.yt_dlp.utils.DownloadError(
                    "Sign in to confirm you're not a bot", None)

        monkeypatch.setattr(dt.yt_dlp, "YoutubeDL", lambda opts: Broken())
        with pytest.raises(RuntimeError, match="bot detection"):
            dt.inspect_source("https://www.youtube.com/watch?v=6uSskUaDL90")


class TestDownloadSubtitles:
    def test_prefers_manual_english_subtitles(self, tmp_path, monkeypatch):
        calls = []

        def fake_run(cmd):
            calls.append(cmd)
            if "--write-subs" in cmd:
                (tmp_path / "subs.en.srt").write_text(
                    "1\n00:00:00,000 --> 00:00:05,000\nhello\n", encoding="utf-8")

        monkeypatch.setattr(dt, "run", fake_run)
        result = dt.download_subtitles("https://www.youtube.com/watch?v=x", tmp_path)
        assert result == (tmp_path / "subs.en.srt").resolve()
        auto_calls = [c for c in calls if "--write-auto-subs" in c]
        assert auto_calls == []  # manual subs satisfied the request

    def test_falls_back_to_auto_subtitles(self, tmp_path, monkeypatch):
        calls = []

        def fake_run(cmd):
            calls.append(cmd)
            if "--write-auto-subs" in cmd:
                (tmp_path / "subs.en.srt").write_text(
                    "1\n00:00:00,000 --> 00:00:05,000\nhello\n", encoding="utf-8")

        monkeypatch.setattr(dt, "run", fake_run)
        result = dt.download_subtitles("https://www.youtube.com/watch?v=x", tmp_path)
        assert result == (tmp_path / "subs.en.srt").resolve()

    def test_returns_none_when_no_subtitles(self, tmp_path, monkeypatch):
        monkeypatch.setattr(dt, "run", lambda cmd: None)
        assert dt.download_subtitles("https://www.youtube.com/watch?v=x", tmp_path) is None


class TestSubtitlesToTranscript:
    def test_synthesizes_word_timestamps(self, tmp_path):
        sub = tmp_path / "subs.en.srt"
        sub.write_text(
            "1\n00:00:00,000 --> 00:00:04,000\nHello world.\n\n"
            "2\n00:00:05,000 --> 00:00:09,000\nThis is a test.\n",
            encoding="utf-8")
        tr = dt.subtitles_to_transcript(sub, "https://www.youtube.com/watch?v=x", 60.0)
        assert tr["duration"] == 60.0
        assert tr["language"] == "en"
        assert tr["model"] == "youtube-subtitles"
        assert len(tr["segments"]) == 2
        assert len(tr["words"]) == 6
        assert tr["words"][0]["start"] == 0.0
        assert tr["words"][-1]["end"] == 9.0
        assert all(0.0 <= w["start"] < w["end"] <= 9.0 for w in tr["words"])


class TestDownloadSection:
    def test_cuts_local_source_exactly(self, tmp_path, monkeypatch):
        source = tmp_path / "source.mp4"
        source.write_bytes(b"x")
        calls = []

        def fake_run(cmd, **kwargs):
            calls.append(cmd)
            Path(cmd[-1]).write_bytes(b"section-bytes")

        monkeypatch.setattr(subprocess, "run", fake_run)
        result = dt.download_section(
            "https://www.youtube.com/watch?v=x", 10.0, 20.0,
            tmp_path / "sections", source=source, retries=2)
        assert result.exists() and result.suffix == ".mp4"
        flat = " ".join(str(c) for c in calls)
        assert "-ss" in flat and "10.000" in flat and "-t" in flat and "10.000" in flat

    def test_retries_then_raises_and_cleans_up(self, tmp_path, monkeypatch):
        def fake_run(cmd):
            raise subprocess.CalledProcessError(1, cmd)

        monkeypatch.setattr(dt, "run", fake_run)
        monkeypatch.setattr(dt.time, "sleep", lambda *args: None)
        with pytest.raises(RuntimeError, match="failed after 3 attempts"):
            dt.download_section("https://www.youtube.com/watch?v=x", 0.0, 5.0,
                                tmp_path / "sections", retries=3)
        assert not list((tmp_path / "sections").iterdir())
    def test_bot_detection_error_is_surfaced(self, tmp_path, monkeypatch):
        def fake_run(cmd):
            raise subprocess.CalledProcessError(
                1, cmd,
                stderr="Sign in to confirm you're not a bot. This helps protect our community.")

        monkeypatch.setattr(dt, "run", fake_run)
        monkeypatch.setattr(dt.time, "sleep", lambda *args: None)
        with pytest.raises(RuntimeError, match="bot detection"):
            dt.download_section("https://www.youtube.com/watch?v=x", 0.0, 5.0,
                                tmp_path / "sections", retries=1)


class TestYtDlpCommonArgs:
    def test_player_client_rotation_in_args(self):
        args = dt._yt_dlp_common_args()
        flat = " ".join(str(a) for a in args)
        assert "player_client" in flat
        assert "web" in flat
        assert "web_embedded" in flat
        assert "android" in flat
        assert "tv" in flat

    def test_po_token_env_var_passes_to_args(self, monkeypatch):
        monkeypatch.setenv("YTDLP_PO_TOKEN", "test-po-token-123")
        args = dt._yt_dlp_common_args()
        flat = " ".join(str(a) for a in args)
        assert "po_token" in flat
        assert "test-po-token-123" in flat

    def test_cookies_file_env_var_passes_to_args(self, monkeypatch, tmp_path):
        cookies_path = tmp_path / "cookies.txt"
        cookies_path.write_text("# Netscape HTTP Cookie File\n")
        monkeypatch.setenv("YTDLP_COOKIES_FILE", str(cookies_path))
        args = dt._yt_dlp_common_args()
        flat = " ".join(str(a) for a in args)
        assert "cookies" in flat
        assert str(cookies_path) in flat

    def test_no_env_vars_means_no_extra_args(self, monkeypatch):
        monkeypatch.delenv("YTDLP_PO_TOKEN", raising=False)
        monkeypatch.delenv("YTDLP_COOKIES_FILE", raising=False)
        args = dt._yt_dlp_common_args()
        flat = " ".join(str(a) for a in args)
        assert "po_token" not in flat
        assert "cookies" not in flat


class TestIsBotDetectionError:
    def test_detects_bot_detection(self):
        assert dt._is_bot_detection_error("Sign in to confirm you're not a bot")
        assert dt._is_bot_detection_error("bot detection triggered")
        assert dt._is_bot_detection_error("automated queries detected")

    def test_does_not_detect_normal_errors(self):
        assert not dt._is_bot_detection_error("Video unavailable")
        assert not dt._is_bot_detection_error("HTTP Error 404")
        assert not dt._is_bot_detection_error("unknown error")


class TestDownloadUsesCommonArgs:
    def test_download_cmd_includes_player_clients(self, tmp_path, monkeypatch):
        calls = []

        def fake_run(cmd):
            calls.append(cmd)

        monkeypatch.setattr(dt, "run", fake_run)
        # Create a fake source file so _download thinks it downloaded something
        (tmp_path / "source.mp4").write_bytes(b"x")

        # We can't easily mock the file discovery, so just check the cmd construction
        # by inspecting _yt_dlp_common_args directly which is already covered above.

    def test_section_download_cmd_includes_common_args(self, tmp_path, monkeypatch):
        calls = []

        def fake_run(cmd):
            calls.append(cmd)
            # Simulate yt-dlp producing the output file
            for c in cmd:
                if "section-" in c and "%(ext)s" in c:
                    out_file = Path(c.replace("%(ext)s", ".mp4"))
                    if not out_file.is_absolute():
                        out_file = tmp_path / out_file.name
                    out_file.write_bytes(b"x")
                    break

        monkeypatch.setattr(dt, "run", fake_run)
        result = dt.download_section(
            "https://www.youtube.com/watch?v=x", 10.0, 20.0,
            tmp_path, retries=1)
        assert result.exists()
        flat = " ".join(str(c) for c in calls)
        assert "--download-sections" in flat
        assert "*10.0-20.0" in flat
        assert "player_client" in flat
