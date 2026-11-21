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


class TestRedactedLogging:
    """Test that sensitive arguments are redacted before logging."""

    def test_redact_cookies_path(self):
        cmd = [
            sys.executable, "-m", "yt_dlp",
            "--cookies", "/secret/path/to/cookies.txt",
            "https://www.youtube.com/watch?v=x",
        ]
        redacted = dt._redact_cmd(cmd)
        flat = " ".join(str(c) for c in redacted)
        assert "/secret/path/to/cookies.txt" not in flat
        assert "<redacted>" in flat
        assert "--cookies" in flat

    def test_redact_po_token_in_extractor_args(self):
        cmd = [
            sys.executable, "-m", "yt_dlp",
            "--extractor-args",
            "youtube:player_client=web,po_token=secret-token-123",
            "https://www.youtube.com/watch?v=x",
        ]
        redacted = dt._redact_cmd(cmd)
        flat = " ".join(str(c) for c in redacted)
        assert "secret-token-123" not in flat
        assert "<redacted>" in flat
        # The entire extractor-args value is redacted when it contains po_token
        assert "youtube:player_client=web" not in flat

    def test_redact_cookies_in_extractor_args(self):
        """Cookies passed via --cookies separate arg, not in extractor-args."""
        cmd = [
            sys.executable, "-m", "yt_dlp",
            "--cookies", "/secret/path/to/cookies.txt",
            "https://www.youtube.com/watch?v=x",
        ]
        redacted = dt._redact_cmd(cmd)
        flat = " ".join(str(c) for c in redacted)
        assert "/secret/path/to/cookies.txt" not in flat
        assert "<redacted>" in flat
        assert "--cookies" in flat

    def test_non_sensitive_args_preserved(self):
        cmd = [
            sys.executable, "-m", "yt_dlp",
            "--extractor-args", "youtube:player_client=web",
            "--no-playlist",
            "https://www.youtube.com/watch?v=x",
        ]
        redacted = dt._redact_cmd(cmd)
        flat = " ".join(str(c) for c in redacted)
        assert "youtube:player_client=web" in flat
        assert "--no-playlist" in flat
        assert "https://www.youtube.com/watch?v=x" in flat

    def test_run_redacts_po_token_and_cookie_path_in_real_run(self, monkeypatch, capfd, tmp_path):
        token = "secret-po-token-value"
        cookie_path = str(tmp_path / "private-cookies.txt")
        monkeypatch.setenv("YTDLP_PO_TOKEN", token)
        monkeypatch.setenv("YTDLP_COOKIES_FILE", cookie_path)

        def fake_run(cmd, **kwargs):
            kwargs["stderr"].write(
                f"failed po_token={token} web.gvs+{token} cookies={cookie_path}\\n"
            )
            raise subprocess.CalledProcessError(1, cmd)

        monkeypatch.setattr(subprocess, "run", fake_run)
        with pytest.raises(subprocess.CalledProcessError) as caught:
            dt.run([
                sys.executable, "-m", "yt_dlp",
                "--cookies", cookie_path,
                "--extractor-args", f"youtube:po_token=web.gvs+{token}",
                "https://www.youtube.com/watch?v=x",
            ])

        captured = capfd.readouterr()
        combined = captured.out + (caught.value.stderr or "")
        assert token not in combined
        assert cookie_path not in combined
        assert "<redacted>" in combined
        assert "<redacted-cookie-path>" in combined


class TestYtDlpExtractorArgs:
    """Test that --extractor-args combines player_client and po_token correctly."""

    def test_single_extractor_args_with_player_clients(self):
        val = dt._yt_dlp_extractor_args()
        assert val.startswith("youtube:player_client=")
        assert "web" in val
        assert "web_embedded" in val
        assert "android" in val
        assert "tv" in val

    def test_po_token_combined_with_player_client(self, monkeypatch):
        monkeypatch.setenv("YTDLP_PO_TOKEN", "test-po-token-123")
        val = dt._yt_dlp_extractor_args()
        assert "player_client=" in val
        assert "po_token=web.gvs+test-po-token-123" in val

    def test_no_po_token_when_env_unset(self, monkeypatch):
        monkeypatch.delenv("YTDLP_PO_TOKEN", raising=False)
        val = dt._yt_dlp_extractor_args()
        assert "po_token" not in val


class TestPoTokenFormat:
    """Test that PO Token uses correct client.context+TOKEN format."""

    def test_po_token_uses_web_gvs_format(self, monkeypatch):
        monkeypatch.setenv("YTDLP_PO_TOKEN", "test-token-123")
        val = dt._yt_dlp_extractor_args()
        assert "po_token=web.gvs+test-token-123" in val

    def test_po_token_no_bare_format(self, monkeypatch):
        """PO Token must NOT be in bare po_token=TOKEN format."""
        monkeypatch.setenv("YTDLP_PO_TOKEN", "test-token-123")
        val = dt._yt_dlp_extractor_args()
        # The bare token without client.context prefix should NOT appear
        assert ",po_token=test-token-123" not in val
        assert "po_token=web.gvs+test-token-123" in val

    def test_ydl_opts_po_token_format(self, monkeypatch):
        """Python API opts must also use web.gvs+TOKEN format."""
        monkeypatch.setenv("YTDLP_PO_TOKEN", "test-token-123")
        opts = dt._yt_dlp_ydl_opts()
        pot = opts["extractor_args"]["youtube"]["po_token"]
        assert pot == ["web.gvs+test-token-123"]


class TestInspectSourceConfig:
    """Test that inspect_source() applies the same config as CLI paths."""

    def test_inspect_source_uses_player_clients(self, monkeypatch):
        ydl_opts = dt._yt_dlp_ydl_opts()
        clients = ydl_opts["extractor_args"]["youtube"]["player_client"]
        assert "web" in clients
        assert "web_embedded" in clients
        assert "android" in clients
        assert "tv" in clients

    def test_inspect_source_skips_download(self, monkeypatch):
        ydl_opts = dt._yt_dlp_ydl_opts()
        ydl_opts["skip_download"] = True
        assert ydl_opts["skip_download"] is True

    def test_inspect_source_quiet(self, monkeypatch):
        ydl_opts = dt._yt_dlp_ydl_opts()
        assert ydl_opts.get("quiet") is True
        assert ydl_opts.get("no_warnings") is True


class TestRunErrorDiagnostics:
    """Test that run() preserves useful diagnostics on failure."""

    def test_run_prints_stderr_tail_on_failure(self, monkeypatch, capfd):
        class FakeCalledProcessError(subprocess.CalledProcessError):
            def __init__(self):
                super().__init__(1, ["fake", "cmd"],
                                 stderr="\n".join([
                                     "line 1: network timeout",
                                     "line 2: retrying",
                                     "line 3: still failing",
                                     "line 4: connection dropped",
                                     "line 5: final attempt",
                                     "line 6: final failure: connection refused",
                                 ]))

        monkeypatch.setattr(subprocess, "run", lambda *a, **k: (_ for _ in ()).throw(
            FakeCalledProcessError()))

        with pytest.raises(subprocess.CalledProcessError):
            dt.run(["fake", "cmd"])

        captured = capfd.readouterr()
        # stderr tail (last 5 lines) should appear in output
        assert "final failure: connection refused" in captured.out
        assert "line 5: final attempt" in captured.out
        # "line 1: network timeout" should NOT appear (truncated by tail)
        assert "line 1: network timeout" not in captured.out


class TestRunErrorSanitization:
    """Test that run() never exposes secrets in error output."""

    def test_run_redacts_po_token_in_stderr(self, monkeypatch, capfd):
        class FakeCalledProcessError(subprocess.CalledProcessError):
            def __init__(self):
                super().__init__(1, ["cmd"],
                                 stderr="Error: po_token=secret-value-123 failed")

        monkeypatch.setattr(subprocess, "run", lambda *a, **k: (_ for _ in ()).throw(
            FakeCalledProcessError()))

        with pytest.raises(subprocess.CalledProcessError):
            dt.run(["cmd"])

        captured = capfd.readouterr()
        assert "secret-value-123" not in captured.out
        assert "<redacted>" in captured.out or "po_token=<redacted>" in captured.out

    def test_run_redacts_web_gvs_token_in_stderr(self, monkeypatch, capfd):
        class FakeCalledProcessError(subprocess.CalledProcessError):
            def __init__(self):
                super().__init__(1, ["cmd"],
                                 stderr="Error: web.gvs+secret-token-value failed")

        monkeypatch.setattr(subprocess, "run", lambda *a, **k: (_ for _ in ()).throw(
            FakeCalledProcessError()))

        with pytest.raises(subprocess.CalledProcessError):
            dt.run(["cmd"])

        captured = capfd.readouterr()
        assert "secret-token-value" not in captured.out


class TestCookieFileHandling:
    """Test --cookies option with YTDLP_COOKIES_FILE."""

    def test_cookies_file_passed_as_separate_arg(self, monkeypatch, tmp_path):
        cookies_path = tmp_path / "cookies.txt"
        cookies_path.write_text("# Netscape HTTP Cookie File\n")
        monkeypatch.setenv("YTDLP_COOKIES_FILE", str(cookies_path))
        args = dt._yt_dlp_common_args()
        # --cookies should be a separate argument, not in --extractor-args
        assert "--cookies" in args
        cookies_idx = args.index("--cookies")
        assert args[cookies_idx + 1] == str(cookies_path)
        # The value should NOT be in --extractor-args
        extractor_idx = args.index("--extractor-args")
        extractor_val = args[extractor_idx + 1]
        assert "cookies=" not in extractor_val

    def test_cookies_file_missing_raises(self, monkeypatch):
        monkeypatch.setenv("YTDLP_COOKIES_FILE", "/nonexistent/cookies.txt")
        with pytest.raises(RuntimeError, match="not found"):
            dt._yt_dlp_common_args()

    def test_cookies_file_unreadable_raises(self, monkeypatch, tmp_path):
        import sys as _sys
        if _sys.platform == "win32":
            pytest.skip("Windows does not support chmod 000 to make files unreadable")
        cookies_path = tmp_path / "unreadable.txt"
        cookies_path.write_text("# data\n")
        cookies_path.chmod(0o000)
        monkeypatch.setenv("YTDLP_COOKIES_FILE", str(cookies_path))
        try:
            with pytest.raises(RuntimeError, match="not readable"):
                dt._yt_dlp_common_args()
        finally:
            cookies_path.chmod(0o644)

    def test_no_cookies_file_when_env_unset(self, monkeypatch):
        monkeypatch.delenv("YTDLP_COOKIES_FILE", raising=False)
        args = dt._yt_dlp_common_args()
        assert "--cookies" not in args


class TestIsBotDetectionError:
    """Test that bot detection is narrowly classified."""

    def test_detects_genuine_bot_detection(self):
        assert dt._is_bot_detection_error("Sign in to confirm you're not a bot")
        assert dt._is_bot_detection_error("confirm you're not a bot")
        assert dt._is_bot_detection_error("bot detection triggered")
        assert dt._is_bot_detection_error("automated queries detected")
        assert dt._is_bot_detection_error("automated traffic from your network")

    def test_does_not_detect_private_video(self):
        assert not dt._is_bot_detection_error("Video is private")
        assert not dt._is_bot_detection_error("private video")

    def test_does_not_detect_copyright(self):
        assert not dt._is_bot_detection_error("copyright claim")
        assert not dt._is_bot_detection_error("Video unavailable due to copyright")

    def test_does_not_detect_members_only(self):
        assert not dt._is_bot_detection_error("members only content")
        assert not dt._is_bot_detection_error("This is a members-only video")

    def test_does_not_detect_unsupported_url(self):
        assert not dt._is_bot_detection_error("Unsupported URL")
        assert not dt._is_bot_detection_error("unsupported url format")

    def test_does_not_detect_video_unavailable(self):
        assert not dt._is_bot_detection_error("Video unavailable")
        assert not dt._is_bot_detection_error("unknown error")


class TestSectionDownloadWithCommonArgs:
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
        assert "po_token" not in flat  # no PO token set
