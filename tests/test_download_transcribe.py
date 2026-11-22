"""
Tests for the YouTube / subtitles / section-download stage.

Network calls and subprocesses are mocked; no downloads happen here.
"""
import json
import subprocess
import sys
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

    def test_inspect_source_applies_pot_config(self, monkeypatch, yt_info):
        """inspect_source() must pass PO provider config via yt-dlp Python API."""
        captured_opts = {}

        class FakeYDL:
            def __init__(self, opts):
                self.info = yt_info
                captured_opts.clear()
                captured_opts.update(opts)

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def extract_info(self, url, download=False):
                return self.info

        monkeypatch.setattr(dt.yt_dlp, "YoutubeDL", FakeYDL)
        monkeypatch.setenv("YTDLP_POT_PROVIDER_URL", "http://127.0.0.1:9999")
        monkeypatch.setenv("YTDLP_COOKIES_FILE", "")
        dt.inspect_source("https://www.youtube.com/watch?v=6uSskUaDL90")

        ea = captured_opts.get("extractor_args", {})
        yt = ea.get("youtube", {})
        assert yt.get("fetch_pot") == ["always"]
        pot_http = ea.get("youtubepot-bgutilhttp", {})
        assert pot_http.get("base_url") == ["http://127.0.0.1:9999"]

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

    def test_section_download_includes_pot_args(self, tmp_path, monkeypatch):
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
        assert "fetch_pot=always" in flat

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

    def test_http_403_error_is_surfaced(self, tmp_path, monkeypatch):
        def fake_run(cmd):
            raise subprocess.CalledProcessError(
                1, cmd,
                stderr="ERROR: [youtube] 6uSskUaDL90: HTTP Error 403: Forbidden")

        monkeypatch.setattr(dt, "run", fake_run)
        monkeypatch.setattr(dt.time, "sleep", lambda *args: None)
        with pytest.raises(RuntimeError, match="HTTP 403"):
            dt.download_section("https://www.youtube.com/watch?v=x", 0.0, 5.0,
                                tmp_path / "sections", retries=1)


class TestDownloadProgressiveFallback:
    """Test that _download retries with progressive format on HTTP 403."""

    def test_download_retries_with_progressive_on_403(self, tmp_path, monkeypatch):
        calls = []

        def fake_run(cmd):
            calls.append(cmd)
            # Find the -o output template argument
            out_tmpl = None
            for i, c in enumerate(cmd):
                if c == "-o" and i + 1 < len(cmd):
                    out_tmpl = cmd[i + 1]
                    break
            if out_tmpl is None:
                return
            # First attempt (separate formats) fails with 403
            fmt_idx = None
            for i, c in enumerate(cmd):
                if c == "-f" and i + 1 < len(cmd):
                    fmt_idx = i + 1
                    break
            if fmt_idx is not None and "bestvideo" in cmd[fmt_idx] and len(calls) == 1:
                raise subprocess.CalledProcessError(
                    1, cmd, stderr="HTTP Error 403: Forbidden")
            # Second attempt (progressive) succeeds - create the output file
            out_path = Path(out_tmpl.replace("%(ext)s", "mp4"))
            out_path.parent.mkdir(parents=True, exist_ok=True)
            out_path.write_bytes(b"fake-video")

        monkeypatch.setattr(dt, "run", fake_run)
        result = dt._download("https://www.youtube.com/watch?v=x", tmp_path,
                              fmt="bestvideo*+bestaudio/best")
        assert result.exists()
        assert len(calls) == 2  # first attempt + progressive retry
        assert "best[height<=720]" in " ".join(str(c) for c in calls[1])

    def test_download_non_youtube_no_progressive(self, tmp_path, monkeypatch):
        """Non-YouTube URLs should not get progressive fallback."""
        calls = []

        def fake_run(cmd):
            calls.append(cmd)
            # Find the -o output template argument
            out_tmpl = None
            for i, c in enumerate(cmd):
                if c == "-o" and i + 1 < len(cmd):
                    out_tmpl = cmd[i + 1]
                    break
            if out_tmpl is None:
                return
            out_path = Path(out_tmpl.replace("%(ext)s", "mp4"))
            out_path.parent.mkdir(parents=True, exist_ok=True)
            out_path.write_bytes(b"fake-video")

        monkeypatch.setattr(dt, "run", fake_run)
        result = dt._download("https://example.com/video.mp4", tmp_path,
                              fmt="bestvideo*+bestaudio/best")
        assert result.exists()
        assert len(calls) == 1  # no retry


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
        assert "youtube:player_client=web" in flat
        assert "po_token=<redacted>" in flat

    def test_redact_web_gvs_token_preserves_other_args(self):
        cmd = [
            sys.executable, "-m", "yt_dlp",
            "--extractor-args",
            "youtube:player_client=web,fetch_pot=always,po_token=web.gvs+secret-token-value,youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416",
            "https://www.youtube.com/watch?v=x",
        ]
        redacted = dt._redact_cmd(cmd)
        flat = " ".join(str(c) for c in redacted)
        assert "youtube:player_client=web" in flat
        assert "fetch_pot=always" in flat
        assert "youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416" in flat
        assert "secret-token-value" not in flat
        assert "po_token=<redacted>" in flat


class TestYtDlpExtractorArgs:
    """Test that --extractor-args combines player_client and po_token correctly."""

    def test_pot_args_includes_fetch_pot(self):
        args = dt._yt_dlp_pot_args()
        assert "--extractor-args" in args
        pot_val_idx = args.index("--extractor-args") + 1
        assert "fetch_pot=always" in args[pot_val_idx]

    def test_pot_args_includes_bgutilhttp_url(self):
        args = dt._yt_dlp_pot_args()
        assert "--extractor-args" in args
        # Find the youtubepot-bgutilhttp extractor-args
        for i, a in enumerate(args):
            if a == "--extractor-args" and i + 1 < len(args):
                if "youtubepot-bgutilhttp:base_url=" in args[i + 1]:
                    assert "http://127.0.0.1:4416" in args[i + 1]
                    break
        else:
            assert False, "youtubepot-bgutilhttp:base_url not found in extractor-args"

    def test_ydl_opts_pot_config(self):
        opts = dt._yt_dlp_ydl_opts()
        ea = opts["extractor_args"]
        yt = ea["youtube"]
        assert yt["fetch_pot"] == ["always"]
        assert yt["player_client"] == ["mweb", "web", "web_embedded", "android", "tv"]
        assert opts["js_runtimes"] == {"deno": {}}
        assert opts["remote_components"] == {"ejs:github"}
        pot_http = ea["youtubepot-bgutilhttp"]
        assert pot_http["base_url"] == ["http://127.0.0.1:4416"]

    def test_ydl_opts_cookie_file(self, monkeypatch, tmp_path):
        cookies = tmp_path / "cookies.txt"
        cookies.write_text("# Netscape HTTP Cookie File\\n")
        monkeypatch.setenv("YTDLP_COOKIES_FILE", str(cookies))
        opts = dt._yt_dlp_ydl_opts()
        assert opts["cookiefile"] == str(cookies)

    def test_ydl_opts_missing_cookie_file_raises(self, monkeypatch):
        monkeypatch.setenv("YTDLP_COOKIES_FILE", "/missing/cookies.txt")
        with pytest.raises(RuntimeError, match="not found"):
            dt._yt_dlp_ydl_opts()

    def test_ydl_opts_custom_pot_url(self, monkeypatch):
        monkeypatch.setenv("YTDLP_POT_PROVIDER_URL", "http://127.0.0.1:9999")
        opts = dt._yt_dlp_ydl_opts()
        pot_http = opts["extractor_args"]["youtubepot-bgutilhttp"]
        assert pot_http["base_url"] == ["http://127.0.0.1:9999"]

    def test_common_args_includes_pot(self):
        args = dt._yt_dlp_common_args()
        assert "--extractor-args" in args
        pot_val = args[args.index("--extractor-args") + 1]
        assert "fetch_pot=always" in pot_val
        assert "player_client=mweb,web,web_embedded,android,tv" in pot_val
        assert args[args.index("--js-runtimes") + 1] == "deno"
        assert args[args.index("--remote-components") + 1] == "ejs:github"

    def test_common_args_includes_verbose(self, monkeypatch):
        monkeypatch.setenv("YTDLP_VERBOSE", "1")
        args = dt._yt_dlp_common_args()
        assert "--verbose" in args

    def test_ydl_opts_includes_verbose(self, monkeypatch):
        monkeypatch.setenv("YTDLP_VERBOSE", "true")
        opts = dt._yt_dlp_ydl_opts()
        assert opts.get("verbose") is True


class TestMissingConfiguration:
    """Test behavior when optional configuration is missing."""

    def test_no_pot_url_uses_default(self, monkeypatch):
        monkeypatch.delenv("YTDLP_POT_PROVIDER_URL", raising=False)
        opts = dt._yt_dlp_ydl_opts()
        pot_http = opts["extractor_args"]["youtubepot-bgutilhttp"]
        assert pot_http["base_url"] == ["http://127.0.0.1:4416"]

    def test_no_cookie_file_does_not_add_cookies_arg(self, monkeypatch):
        monkeypatch.delenv("YTDLP_COOKIES_FILE", raising=False)
        args = dt._yt_dlp_common_args()
        assert "--cookies" not in args


class TestCookieFileHandling:
    """Test --cookies option with YTDLP_COOKIES_FILE."""

    def test_cookies_file_passed_as_separate_arg(self, monkeypatch, tmp_path):
        cookies_path = tmp_path / "cookies.txt"
        cookies_path.write_text("# Netscape HTTP Cookie File\n")
        monkeypatch.setenv("YTDLP_COOKIES_FILE", str(cookies_path))
        args = dt._yt_dlp_common_args()
        assert "--cookies" in args
        cookies_idx = args.index("--cookies")
        assert args[cookies_idx + 1] == str(cookies_path)
        # The value should NOT be in --extractor-args
        pot_val = args[1]
        assert "cookies=" not in pot_val

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


class TestIsHttp403:
    """Test HTTP 403 detection."""

    def test_detects_403(self):
        assert dt._is_http_403("HTTP Error 403: Forbidden")
        assert dt._is_http_403("http error 403")

    def test_does_not_detect_other_errors(self):
        assert not dt._is_http_403("HTTP Error 404: Not Found")
        assert not dt._is_http_403("Video unavailable")


class TestIsHttp429:
    """Test HTTP 429 detection."""

    def test_detects_429(self):
        assert dt._is_http_429("HTTP Error 429: Too Many Requests")
        assert dt._is_http_429("http error 429")
        assert dt._is_http_429("429: Too Many Requests")

    def test_does_not_detect_other_errors(self):
        assert not dt._is_http_429("HTTP Error 403: Forbidden")
        assert not dt._is_http_429("HTTP Error 404: Not Found")


class TestLocalFileProcessing:
    """Test that local file uploads remain unaffected."""

    def test_resolve_source_local_file(self, tmp_path):
        source = tmp_path / "video.mp4"
        source.write_bytes(b"fake-video")
        result = dt.resolve_source(str(source), tmp_path)
        assert result == source.resolve()

    def test_download_local_file(self, tmp_path):
        """Local files are not passed through yt-dlp."""
        source = tmp_path / "video.mp4"
        source.write_bytes(b"fake-video")
        result = dt.resolve_source(str(source), tmp_path)
        assert result.exists()
