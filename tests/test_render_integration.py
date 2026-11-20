"""Actual ffmpeg renders catch filtergraph, codec, path and subtitle regressions."""
import json
import shutil
import subprocess
from pathlib import Path

import pytest
import render_clips
import branding

pytestmark = pytest.mark.skipif(not shutil.which("ffmpeg"), reason="ffmpeg not installed")


@pytest.fixture
def source(tmp_path):
    path = tmp_path / "source with spaces.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i",
                    "testsrc2=size=640x360:rate=12:duration=3", "-f", "lavfi", "-i",
                    "sine=frequency=440:duration=3", "-c:v", "libx264", "-pix_fmt", "yuv420p",
                    "-c:a", "aac", "-shortest", str(path)], check=True)
    return path


@pytest.mark.parametrize("layout,preview", [("single", True), ("split", True), ("split", False)])
def test_render_playable_with_subtitles_and_brand(source, tmp_path, layout, preview):
    logo = tmp_path / "logo.png"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i",
                    "color=c=lime:s=80x40", "-frames:v", "1", str(logo)], check=True)
    preset = tmp_path / "brand.json"
    preset.write_text(json.dumps({"font": "Arial", "color": "#FF00FF", "logo": str(logo)}))
    out_dir = tmp_path / "render output"
    out_dir.mkdir()
    words = [{"word": "Hello", "start": 0.5, "end": 1.0},
             {"word": "world!", "start": 1.1, "end": 2.4}]
    out = render_clips.render({"id": "001", "start": 0.5, "end": 2.5, "hook": "same hook"},
        words, source, 640, 360, tmp_path, "9:16" if layout == "split" else "16:9",
        out_dir=out_dir, layout=layout, preview=preview, brand=branding.load_brand(preset))
    streams = json.loads(subprocess.run(["ffprobe", "-v", "error", "-show_streams", "-of", "json",
                                        str(out)], capture_output=True, text=True, check=True).stdout)["streams"]
    assert {s["codec_name"] for s in streams} >= {"h264", "aac"}
    assert "00:00:00,000" in out.with_suffix(".srt").read_text()
    if layout == "split":
        video = next(s for s in streams if s["codec_type"] == "video")
        expected = render_clips.PREVIEW["9:16"] if preview else render_clips.ASPECTS["9:16"][:2]
        assert (video["width"], video["height"]) == expected
        assert video["pix_fmt"] == "yuv420p"
    if not preview:
        assert out.with_suffix(".png").is_file()
        assert out.with_suffix(".meta.json").is_file()


def test_cjk_captions_select_unicode_font(tmp_path):
    output = tmp_path / "cjk.ass"
    words = [{"word": "こんにちは", "start": 0.0, "end": 0.8},
             {"word": "世界", "start": 0.9, "end": 1.5}]
    render_clips.build_ass(words, 0, 2, output, 1080, 1920, 96, 300)
    ass = output.read_text(encoding="utf-8")
    assert "Noto Sans CJK JP" in ass
    assert "こんにちは" in ass and "世界" in ass


def test_brand_colors_appear_in_ass(tmp_path):
    output = tmp_path / "cap.ass"
    preset = tmp_path / "brand.json"
    preset.write_text(json.dumps({"font": "Georgia", "color": "#112233", "highlight": "#ABCDEF"}))
    render_clips.build_ass([{"word": "hello", "start": 0, "end": 1}], 0, 1, output,
                          1920, 1080, 72, 95, brand=branding.load_brand(preset))
    ass = output.read_text()
    assert "Georgia" in ass
    assert "&H00332211" in ass
    assert "&H00EFCDAB" in ass


def test_tightened_srt_tracks_actual_shortened_video(source, tmp_path):
    words = [{"word": "Hello", "start": 0.1, "end": 0.5},
             {"word": "um", "start": 0.6, "end": 1.0},
             {"word": "world.", "start": 2.0, "end": 2.5}]
    out = render_clips.render({"start": 0, "end": 3, "hook": "tightened"}, words,
        source, 640, 360, tmp_path, "16:9", out_dir=tmp_path / "tight", do_tighten=True, preview=True)
    import tighten
    keeps = tighten.plan_cuts(words, 0, 3)
    _, expected = tighten.remap_words(words, 0, keeps)
    duration = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", str(out)], capture_output=True, text=True, check=True).stdout)
    assert duration == pytest.approx(expected, abs=0.25)
    srt = out.with_suffix(".srt").read_text()
    assert "world." in srt
    assert " um " not in srt


def test_cli_render_preserves_project_settings_and_copies_exports(source, tmp_path):
    import os
    import sys
    import projects
    path = tmp_path / "saved project"
    projects.init_project(path, str(source), {"aspect": "9:16", "layout": "split"})
    projects.atomic_json(path / "transcript.json", {"video": str(source), "duration": 3,
        "words": [{"word": "Hello.", "start": 0.5, "end": 1.5}]})
    projects.atomic_json(path / "segments.json", [{"start": 0.5, "end": 2, "hook": "hello", "overall": 6}])
    export = tmp_path / "export folder"
    result = subprocess.run([sys.executable, str(Path(__file__).resolve().parents[1] / "chopify.py"),
        "--project", str(path), "--action", "render", "--preview", "--no-preflight", "--out", str(export)],
        capture_output=True, text=True, env={**os.environ, "PYTHONIOENCODING": "utf-8"})
    assert result.returncode == 0, result.stderr + result.stdout
    assert projects.read_project(path)["options"]["layout"] == "split"
    assert len(list(export.glob("*.mp4"))) == len(list(export.glob("*.srt"))) == 1


def test_blur_fill_render_is_vertical_with_captions(source, tmp_path):
    words = [{"word": "Hello", "start": 0.5, "end": 1.0},
             {"word": "world", "start": 1.1, "end": 2.0}]
    out_dir = tmp_path / "blur output"
    out_dir.mkdir()
    out = render_clips.render({"id": "001", "start": 0.5, "end": 2.5, "hook": "blur test"},
        words, source, 640, 360, tmp_path, "9:16",
        out_dir=out_dir, blur_fill=True)
    streams = json.loads(subprocess.run(["ffprobe", "-v", "error", "-show_streams", "-of", "json",
                                         str(out)], capture_output=True, text=True, check=True).stdout)["streams"]
    video = next(s for s in streams if s["codec_type"] == "video")
    assert (video["width"], video["height"]) == (1080, 1920)
    assert video["pix_fmt"] == "yuv420p"
    assert any(s["codec_name"] == "aac" for s in streams)
    assert out.with_suffix(".srt").is_file()
    assert "Hello" in out.with_suffix(".srt").read_text()


@pytest.fixture
def vertical_source(tmp_path):
    path = tmp_path / "vertical.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i",
                    "testsrc2=size=360x640:rate=12:duration=3", "-f", "lavfi", "-i",
                    "sine=frequency=440:duration=3", "-c:v", "libx264", "-pix_fmt", "yuv420p",
                    "-c:a", "aac", "-shortest", str(path)], check=True)
    return path


def _captured_command(source, tmp_path, words, aspect="9:16", blur_fill=False, layout="single",
                      preview=True, brand=None):
    """Run render and return the ffmpeg command used (without executing it)."""
    out_dir = tmp_path / "out"
    out_dir.mkdir()
    commands = []

    def fake_run(cmd, **kwargs):
        commands.append(cmd)
        out_path = Path(cmd[-1])
        out_path.parent.mkdir(parents=True, exist_ok=True)
        # Write a dummy valid file so ffprobe in post-processing (if any) works
        out_path.write_bytes(b"\x00\x00\x00\x20ftypmp42\x00\x00\x00\x00")
        return subprocess.CompletedProcess(cmd, 0)

    import render_clips as rc
    orig_run = subprocess.run
    try:
        subprocess.run = fake_run
        rc.render({"id": "001", "start": 0.5, "end": 2.5, "hook": "test"},
            words, source, 640, 360 if aspect == "9:16" else 1920,
            tmp_path, aspect,
            out_dir=out_dir, blur_fill=blur_fill, layout=layout,
            preview=preview, brand=brand)
    finally:
        subprocess.run = orig_run
    return commands[0] if commands else None


def test_landscape_9x16_auto_blur_fill_without_setting(source, tmp_path, monkeypatch):
    """Landscape source in 9:16 gets automatic blur-fill even when blur_fill is False."""
    words = [{"word": "Hello", "start": 0.5, "end": 1.0},
             {"word": "world", "start": 1.1, "end": 2.0}]
    out_dir = tmp_path / "out"
    out_dir.mkdir()
    commands = []

    def fake_run(cmd, **kwargs):
        commands.append(cmd)
        out_path = Path(cmd[-1])
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_bytes(b"\x00\x00\x00\x20ftypmp42\x00\x00\x00\x00")
        return subprocess.CompletedProcess(cmd, 0)

    monkeypatch.setattr(subprocess, "run", fake_run)
    render_clips.render({"id": "001", "start": 0.5, "end": 2.5, "hook": "test"},
        words, source, 640, 360, tmp_path, "9:16",
        out_dir=out_dir, blur_fill=False, preview=True)
    filter_str = " ".join(str(c) for c in commands[0])
    assert "gblur" in filter_str, f"Expected gblur for landscape 9:16, got: {filter_str}"


def test_vertical_9x16_normal_framing(tmp_path, vertical_source, monkeypatch):
    """Already-vertical source in 9:16 uses normal framing (crop/track), not blur-fill."""
    words = [{"word": "Hello", "start": 0.5, "end": 1.0},
             {"word": "world", "start": 1.1, "end": 2.0}]
    out_dir = tmp_path / "out"
    out_dir.mkdir()
    commands = []

    def fake_run(cmd, **kwargs):
        commands.append(cmd)
        out_path = Path(cmd[-1])
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_bytes(b"\x00\x00\x00\x20ftypmp42\x00\x00\x00\x00")
        return subprocess.CompletedProcess(cmd, 0)

    monkeypatch.setattr(subprocess, "run", fake_run)
    render_clips.render({"id": "001", "start": 0.5, "end": 2.5, "hook": "test"},
        words, vertical_source, 360, 640, tmp_path, "9:16",
        out_dir=out_dir, blur_fill=False, preview=True)
    filter_str = " ".join(str(c) for c in commands[0])
    assert "gblur" not in filter_str, \
        f"Expected no gblur for vertical 9:16, got: {filter_str}"


def test_landscape_9x16_blur_fill_still_applied_when_disabled(source, tmp_path, monkeypatch):
    """blur_fill=False does NOT disable automatic full-frame protection for landscape."""
    words = [{"word": "Hello", "start": 0.5, "end": 1.0},
             {"word": "world", "start": 1.1, "end": 2.0}]
    out_dir = tmp_path / "out"
    out_dir.mkdir()
    commands = []

    def fake_run(cmd, **kwargs):
        commands.append(cmd)
        out_path = Path(cmd[-1])
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_bytes(b"\x00\x00\x00\x20ftypmp42\x00\x00\x00\x00")
        return subprocess.CompletedProcess(cmd, 0)

    monkeypatch.setattr(subprocess, "run", fake_run)
    render_clips.render({"id": "001", "start": 0.5, "end": 2.5, "hook": "test"},
        words, source, 640, 360, tmp_path, "9:16",
        out_dir=out_dir, blur_fill=False, preview=True)
    filter_str = " ".join(str(c) for c in commands[0])
    assert "gblur" in filter_str, \
        f"blur_fill=False must not disable full-frame protection for landscape: {filter_str}"


def test_vertical_9x16_blur_fill_setting_no_op(tmp_path, vertical_source, monkeypatch):
    """blur_fill=True on already-vertical footage still uses normal framing."""
    words = [{"word": "Hello", "start": 0.5, "end": 1.0},
             {"word": "world", "start": 1.1, "end": 2.0}]
    out_dir = tmp_path / "out"
    out_dir.mkdir()
    commands = []

    def fake_run(cmd, **kwargs):
        commands.append(cmd)
        out_path = Path(cmd[-1])
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_bytes(b"\x00\x00\x00\x20ftypmp42\x00\x00\x00\x00")
        return subprocess.CompletedProcess(cmd, 0)

    monkeypatch.setattr(subprocess, "run", fake_run)
    render_clips.render({"id": "001", "start": 0.5, "end": 2.5, "hook": "test"},
        words, vertical_source, 360, 640, tmp_path, "9:16",
        out_dir=out_dir, blur_fill=True, preview=True)
    filter_str = " ".join(str(c) for c in commands[0])
    assert "gblur" not in filter_str, \
        f"blur_fill=True should not force blur-fill on vertical footage: {filter_str}"


def test_landscape_9x16_blur_fill_explicit(source, tmp_path, monkeypatch):
    """Explicit blur_fill=True on landscape in 9:16 uses blur-fill framing."""
    words = [{"word": "Hello", "start": 0.5, "end": 1.0},
             {"word": "world", "start": 1.1, "end": 2.0}]
    out_dir = tmp_path / "out"
    out_dir.mkdir()
    commands = []

    def fake_run(cmd, **kwargs):
        commands.append(cmd)
        out_path = Path(cmd[-1])
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_bytes(b"\x00\x00\x00\x20ftypmp42\x00\x00\x00\x00")
        return subprocess.CompletedProcess(cmd, 0)

    monkeypatch.setattr(subprocess, "run", fake_run)
    render_clips.render({"id": "001", "start": 0.5, "end": 2.5, "hook": "test"},
        words, source, 640, 360, tmp_path, "9:16",
        out_dir=out_dir, blur_fill=True, preview=True)
    filter_str = " ".join(str(c) for c in commands[0])
    assert "gblur" in filter_str, f"Expected gblur for explicit blur_fill landscape: {filter_str}"


