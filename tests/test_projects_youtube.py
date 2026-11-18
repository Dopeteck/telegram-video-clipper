"""Integration tests for the YouTube pipeline through projects.py.

Mocks the network/download layers; no actual YouTube calls or ffmpeg renders.
"""
import json
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

import projects  # noqa: E402
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
        "title": "Social Media Justice campaign",
        "duration": 2914.0,
        "uploader": "Campaign Channel",
        "subtitles": {},
        "automatic_captions": {"en": [], "es": []},
    }


class TestProjectsYouTubePrepare:
    def test_youtube_prepare_downloads_subtitles_only_not_video(
        self, tmp_path, monkeypatch, yt_info
    ):
        # Mock inspect_source -> returns metadata, no download
        monkeypatch.setattr(
            dt.yt_dlp, "YoutubeDL", lambda opts: FakeYoutubeDL(yt_info)
        )
        # Mock download_subtitles -> writes a tiny .srt
        def fake_download_subtitles(url, workdir, langs=("en", "en-orig")):
            p = Path(workdir) / "subs.en.srt"
            p.write_text(
                "1\n00:00:00,000 --> 00:00:05,000\nhello world\n",
                encoding="utf-8",
            )
            return p.resolve()

        monkeypatch.setattr(dt, "download_subtitles", fake_download_subtitles)

        # Mock subtitles_to_transcript to write transcript.json (as real impl does)
        def fake_subtitles_to_transcript(
            sub_path, source_url, duration, out_path=None
        ):
            tr = {
                "video": str(source_url),
                "language": "en",
                "duration": float(duration),
                "model": "youtube-subtitles",
                "segments": [
                    {"start": 0.0, "end": 40.0, "text": "hello world. social media addiction is real."}
                ],
                "words": [
                    {"word": "hello", "start": 0.0, "end": 1.0},
                    {"word": "world", "start": 1.1, "end": 2.0},
                    {"word": "social", "start": 2.1, "end": 4.0},
                    {"word": "media", "start": 4.1, "end": 6.0},
                    {"word": "addiction", "start": 6.1, "end": 9.0},
                    {"word": "is", "start": 9.1, "end": 10.0},
                    {"word": "real.", "start": 10.1, "end": 12.0},
                ],
            }
            if out_path is not None:
                Path(out_path).write_text(
                    json.dumps(tr, ensure_ascii=False, indent=2), encoding="utf-8"
                )
            return tr

        monkeypatch.setattr(dt, "subtitles_to_transcript", fake_subtitles_to_transcript)

        options = projects.validate_options(
            {"aspect": "9:16", "blur_fill": True, "min_len": 5, "max_len": 40, "min_score": 0}
        )
        state = projects.create_project(
            tmp_path, "https://www.youtube.com/watch?v=6uSskUaDL90", options
        )
        path = projects.project_path(tmp_path, state["id"])

        # Run prepare only
        result = projects.run_project(path, action="prepare")
        st = projects.read_project(path)

        assert st["yt_url"] == "https://www.youtube.com/watch?v=6uSskUaDL90"
        assert st["yt_meta"]["id"] == "6uSskUaDL90"
        assert st["video"] is None  # full source NOT downloaded at prepare
        assert st["sub_path"] is not None
        assert st["status"] == "review"

    def test_youtube_prepare_handles_lookup_failure(self, tmp_path, monkeypatch):
        class BrokenYDL:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def extract_info(self, url, download=False):
                raise dt.yt_dlp.utils.DownloadError("rate limited", None)

        monkeypatch.setattr(dt.yt_dlp, "YoutubeDL", lambda opts: BrokenYDL())

        options = projects.validate_options({"aspect": "9:16"})
        state = projects.create_project(
            tmp_path, "https://www.youtube.com/watch?v=6uSskUaDL90", options
        )
        path = projects.project_path(tmp_path, state["id"])

        with pytest.raises(RuntimeError, match="YouTube lookup failed"):
            projects.run_project(path, action="prepare")

    def test_blur_fill_option_persists_through_project(self, tmp_path):
        options = projects.validate_options({"blur_fill": True})
        state = projects.create_project(
            tmp_path, "C:\\Videos\\podcast.mp4", options
        )
        st = projects.read_project(projects.project_path(tmp_path, state["id"]))
        assert st["options"]["blur_fill"] is True
        assert st["options"]["min_len"] == 25
        assert st["options"]["max_len"] == 40

    def test_download_section_yt_dlp_path_calls_correct_args(
        self, tmp_path, monkeypatch
    ):
        calls = []

        def fake_run(cmd):
            calls.append(cmd)
            # Simulate yt-dlp producing the output file. -o is a full path;
            # find the section output template argument.
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
            tmp_path, retries=1,
        )
        assert result.exists()
        flat = " ".join(str(c) for c in calls)
        assert "--download-sections" in flat
        assert "*10.0-20.0" in flat


class TestYouTubeRenderArchitecture:
    """Verify the render stage uses remote section extraction, not full-source download."""

    def _make_prepared_yt_project(self, tmp_path, monkeypatch, yt_info):
        """Create a YouTube project that has been prepared (subtitles + transcript)."""
        monkeypatch.setattr(
            dt.yt_dlp, "YoutubeDL", lambda opts: FakeYoutubeDL(yt_info)
        )

        def fake_download_subtitles(url, workdir, langs=("en", "en-orig")):
            p = Path(workdir) / "subs.en.srt"
            p.write_text(
                "1\n00:00:00,000 --> 00:00:05,000\nhello world\n",
                encoding="utf-8",
            )
            return p.resolve()

        monkeypatch.setattr(dt, "download_subtitles", fake_download_subtitles)

        def fake_subtitles_to_transcript(
            sub_path, source_url, duration, out_path=None
        ):
            tr = {
                "video": str(source_url),
                "language": "en",
                "duration": float(duration),
                "model": "youtube-subtitles",
                "segments": [
                    {"start": 0.0, "end": 40.0, "text": "hello world. social media addiction is real."}
                ],
                "words": [
                    {"word": "hello", "start": 0.0, "end": 1.0},
                    {"word": "world", "start": 1.1, "end": 2.0},
                    {"word": "social", "start": 2.1, "end": 4.0},
                    {"word": "media", "start": 4.1, "end": 6.0},
                    {"word": "addiction", "start": 6.1, "end": 9.0},
                    {"word": "is", "start": 9.1, "end": 10.0},
                    {"word": "real.", "start": 10.1, "end": 12.0},
                ],
            }
            if out_path is not None:
                Path(out_path).write_text(
                    json.dumps(tr, ensure_ascii=False, indent=2), encoding="utf-8"
                )
            return tr

        monkeypatch.setattr(dt, "subtitles_to_transcript", fake_subtitles_to_transcript)

        options = projects.validate_options(
            {"aspect": "9:16", "blur_fill": True, "min_len": 5, "max_len": 40, "min_score": 0}
        )
        state = projects.create_project(
            tmp_path, "https://www.youtube.com/watch?v=6uSskUaDL90", options
        )
        path = projects.project_path(tmp_path, state["id"])
        projects.run_project(path, action="prepare")
        return path, state

    def test_youtube_render_does_not_call_download_youtube_source(
        self, tmp_path, monkeypatch, yt_info
    ):
        path, state = self._make_prepared_yt_project(tmp_path, monkeypatch, yt_info)

        # Track whether download_youtube_source is called
        called = {"full_download": False}

        def fake_download_youtube_source(url, workdir):
            called["full_download"] = True
            raise AssertionError("download_youtube_source must NOT be called during YouTube render")

        monkeypatch.setattr(dt, "download_youtube_source", fake_download_youtube_source)

        # Track section extraction calls
        section_calls = []

        def fake_download_section(url, start, end, workdir, source=None, retries=3):
            section_calls.append({"url": url, "start": start, "end": end, "source": source})
            # Create a fake section file
            section_file = workdir / f"section-test.mp4"
            workdir.mkdir(parents=True, exist_ok=True)
            section_file.write_bytes(b"fake-video")
            return section_file.resolve()

        monkeypatch.setattr(dt, "download_section", fake_download_section)

        # Mock ffprobe_dims to return vertical dims
        monkeypatch.setattr(
            projects.render_clips, "ffprobe_dims", lambda p: (1080, 1920)
        )

        # Mock transcribe_words to avoid loading the real model
        monkeypatch.setattr(dt, "transcribe_words", lambda *a, **k: ([], {}))

        # Mock render_clips.render to return a fake output path
        fake_output = path / "clips" / "001-test.mp4"
        fake_output.parent.mkdir(parents=True, exist_ok=True)
        fake_output.write_bytes(b"fake-clip")

        def fake_render(seg, words, source, W, H, workdir, aspect, out_dir=None,
                        style=None, do_tighten=False, loudnorm=False, preview=False,
                        brand=None, layout="single", centers=(0.25, 0.75), blur_fill=False):
            return fake_output

        monkeypatch.setattr(projects.render_clips, "render", fake_render)

        # Add a segment to render
        projects.atomic_json(path / "segments.json", [
            {"start": 10.0, "end": 35.0, "hook": "test moment", "overall": 9.0}
        ])

        result = projects.run_project(path, action="render")

        assert not called["full_download"], "download_youtube_source must not be called"
        assert len(section_calls) == 1, f"Expected 1 section extraction call, got {len(section_calls)}"
        assert section_calls[0]["source"] is None, "Remote extraction must not pass a local source argument"
        assert result["status"] == "complete"

    def test_youtube_render_section_respects_1080p_limit(
        self, tmp_path, monkeypatch, yt_info
    ):
        path, state = self._make_prepared_yt_project(tmp_path, monkeypatch, yt_info)

        # Mock download_section to avoid actual yt-dlp call
        section_file = tmp_path / "_sections" / "section-test.mp4"
        section_file.parent.mkdir(parents=True, exist_ok=True)
        section_file.write_bytes(b"fake-video")

        def fake_download_section(url, start, end, workdir, source=None, retries=3):
            return section_file.resolve()

        monkeypatch.setattr(dt, "download_section", fake_download_section)
        monkeypatch.setattr(
            projects.render_clips, "ffprobe_dims", lambda p: (1080, 1920)
        )

        fake_output = path / "clips" / "001-test.mp4"
        fake_output.parent.mkdir(parents=True, exist_ok=True)
        fake_output.write_bytes(b"fake-clip")

        def fake_render(seg, words, source, W, H, workdir, aspect, out_dir=None,
                        style=None, do_tighten=False, loudnorm=False, preview=False,
                        brand=None, layout="single", centers=(0.25, 0.75), blur_fill=False):
            return fake_output

        monkeypatch.setattr(projects.render_clips, "render", fake_render)
        monkeypatch.setattr(dt, "transcribe_words", lambda *a, **k: ([], {}))

        projects.atomic_json(path / "segments.json", [
            {"start": 10.0, "end": 35.0, "hook": "test moment", "overall": 9.0}
        ])

        projects.run_project(path, action="render")

        # Verify _yt_dlp_section uses 1080p format by checking download_and_transcribe source
        import inspect
        source = inspect.getsource(dt._yt_dlp_section)
        assert "height<=1080" in source, "Remote section extraction must cap at 1080p"

    def test_youtube_render_cleanup_on_failure(
        self, tmp_path, monkeypatch, yt_info
    ):
        path, state = self._make_prepared_yt_project(tmp_path, monkeypatch, yt_info)

        sections_dir = path / "_sections"
        sections_dir.mkdir(parents=True, exist_ok=True)

        def fake_download_section(url, start, end, workdir, source=None, retries=3):
            # Simulate failure - no file produced
            raise RuntimeError("YouTube section extraction failed")

        monkeypatch.setattr(dt, "download_section", fake_download_section)

        projects.atomic_json(path / "segments.json", [
            {"start": 10.0, "end": 35.0, "hook": "test moment", "overall": 9.0}
        ])

        with pytest.raises(RuntimeError, match="YouTube section extraction failed"):
            projects.run_project(path, action="render")

        # No temporary section files should be left behind
        leftover = list(sections_dir.iterdir())
        assert not leftover, f"Leftover section files after failed extraction: {[p.name for p in leftover]}"

    def test_local_file_render_unchanged(
        self, tmp_path, monkeypatch
    ):
        """Local-file rendering must still download the full source and use it directly."""
        # Create a fake local source file
        source = tmp_path / "source.mp4"
        source.write_bytes(b"fake-video")

        # Create project with local source
        options = projects.validate_options(
            {"aspect": "9:16", "blur_fill": True, "min_len": 5, "max_len": 40, "min_score": 0}
        )
        state = projects.create_project(
            tmp_path, str(source), options
        )
        path = projects.project_path(tmp_path, state["id"])

        # Set up transcript and segments manually
        tr = {
            "video": str(source),
            "language": "en",
            "duration": 60.0,
            "model": "tiny",
            "segments": [{"start": 0.0, "end": 40.0, "text": "hello world. test."}],
            "words": [
                {"word": "hello", "start": 0.0, "end": 1.0},
                {"word": "world", "start": 1.1, "end": 2.0},
                {"word": "test.", "start": 2.1, "end": 4.0},
            ],
        }
        (path / "transcript.json").write_text(
            json.dumps(tr, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        projects.atomic_json(path / "segments.json", [
            {"start": 10.0, "end": 35.0, "hook": "local clip", "overall": 9.0}
        ])

        # Mark source as already resolved
        state["video"] = str(source)
        state["source_identity"] = projects.file_identity(source)
        projects.save_project(path, state)

        # Mock render_clips.render
        fake_output = path / "clips" / "001-test.mp4"
        fake_output.parent.mkdir(parents=True, exist_ok=True)
        fake_output.write_bytes(b"fake-clip")

        def fake_render(seg, words, source, W, H, workdir, aspect, out_dir=None,
                        style=None, do_tighten=False, loudnorm=False, preview=False,
                        brand=None, layout="single", centers=(0.25, 0.75), blur_fill=False):
            return fake_output

        monkeypatch.setattr(projects.render_clips, "render", fake_render)
        monkeypatch.setattr(
            projects.render_clips, "ffprobe_dims", lambda p: (1080, 1920)
        )

        result = projects.run_project(path, action="render")

        assert result["status"] == "complete"
        assert len(result.get("last_outputs", [])) == 1


class TestStudioBlurFillControls:
    """Static validation of Studio HTML and JavaScript blur_fill controls."""

    @staticmethod
    def _read_html():
        return Path(REPO, "assets/studio/index.html").read_text(encoding="utf-8")

    @staticmethod
    def _read_js():
        return Path(REPO, "assets/studio/app.js").read_text(encoding="utf-8")

    def test_create_form_has_exactly_one_blur_fill_checkbox(self):
        html = self._read_html()
        # Extract the create form section
        create_start = html.index('<form id="create-form"')
        create_end = html.index('</form>', create_start)
        create_form = html[create_start:create_end]
        blur_count = create_form.count('name="blur_fill"')
        assert blur_count == 1, f"Create form should have exactly 1 blur_fill control, found {blur_count}"

    def test_settings_form_has_exactly_one_blur_fill_checkbox(self):
        html = self._read_html()
        # Extract the settings form section
        settings_start = html.index('<form id="settings-form"')
        settings_end = html.index('</form>', settings_start)
        settings_form = html[settings_start:settings_end]
        blur_count = settings_form.count('name="blur_fill"')
        assert blur_count == 1, f"Settings form should have exactly 1 blur_fill control, found {blur_count}"

    def test_create_form_js_reads_blur_fill(self):
        js = self._read_js()
        assert "$(\"#create-form\").elements.blur_fill.checked" in js, \
            "Create form JS must read blur_fill.checked"

    def test_settings_form_js_reads_blur_fill(self):
        js = self._read_js()
        assert 'form.elements.blur_fill.checked' in js, \
            "Settings form JS must read blur_fill.checked"

    def test_create_form_blur_fill_defaults_unchecked(self):
        html = self._read_html()
        create_start = html.index('<form id="create-form"')
        create_end = html.index('</form>', create_start)
        create_form = html[create_start:create_end]
        # Find the blur_fill input tag
        import re
        match = re.search(r'<input[^>]*name="blur_fill"[^>]*>', create_form)
        assert match is not None, "Create form must have a blur_fill input"
        input_tag = match.group(0)
        assert "checked" not in input_tag, \
            "Create form blur_fill should default to unchecked"

