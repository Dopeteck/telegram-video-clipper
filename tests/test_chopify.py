"""Chopify test suite - covers all pure (non-ffmpeg) logic."""
import json
import os
import subprocess
import sys
from types import SimpleNamespace
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

import score_clips          # noqa: E402
import download_and_transcribe  # noqa: E402
import tighten              # noqa: E402
import render_clips         # noqa: E402
import chopify              # noqa: E402
import projects             # noqa: E402


# ----------------------------------------------------------------- fixtures

def make_word(w, start, dur=0.35):
    return {"word": w, "start": round(start, 3), "end": round(start + dur, 3)}


def sentence(text, start):
    words = [make_word(w, start + i * 0.4) for i, w in enumerate(text.split())]
    return words


@pytest.fixture
def sample_words():
    words = []
    words += sentence("Here is the thing nobody tells you about growing an audience.", 0.0)
    words += sentence("The secret is consistency not talent, and that is the truth.", 5.0)
    words += sentence("Um, most creators quit after three months of posting.", 10.0)
    words += sentence("The biggest mistake is copying viral videos instead of building a system.", 15.0)
    words += sentence("So here is how you fix it, first pick one format and publish weekly.", 20.0)
    words += sentence("Anyway, thanks for watching the whole video today.", 25.0)
    t = 0.0
    return words


@pytest.fixture
def workdir(tmp_path, sample_words):
    wd = tmp_path / "work"
    wd.mkdir()
    data = {"video": "fake.mp4", "language": "en", "duration": 50.0,
            "model": "test", "segments": [], "words": sample_words}
    (wd / "transcript.json").write_text(
        json.dumps(data), encoding="utf-8")
    return wd


# ------------------------------------------------------------- score_clips

class TestSentenceize:
    def test_splits_on_punctuation(self, sample_words):
        sents = score_clips.sentenceize(sample_words)
        assert len(sents) >= 4
        assert sents[0]["start"] == pytest.approx(sample_words[0]["start"])
        assert sents[0]["text"].endswith("audience.")

    def test_words_preserved(self, sample_words):
        sents = score_clips.sentenceize(sample_words)
        total = sum(len(s["words"]) for s in sents)
        assert total == len(sample_words)

    def test_whisper_boundaries_split_unpunctuated_conversation(self):
        words = [make_word(word, i * 0.4) for i, word in enumerate(
            "the main reason we made this change is because the results improved".split())]
        segments = [{"start": 0, "end": 2.35}, {"start": 2.4, "end": 4.0}]
        groups = score_clips.sentenceize(words, segments=segments)
        assert len(groups) == 2
        assert groups[0]["boundary"] == "whisper_segment"
        assert not groups[0]["complete"]  # boundary follows "because" mid-thought
        assert not groups[-1]["complete"]  # recording end is not a completion signal
        assert sum(len(group["words"]) for group in groups) == len(words)

    def test_pause_inside_sentence_is_only_a_grouping_boundary(self):
        words = [make_word(word, i * 0.4) for i, word in enumerate(
            "I thought the whole thing might work because then customers would come".split())]
        pause_after = 6
        for word in words[pause_after + 1:]:
            word["start"] += 1.5
            word["end"] += 1.5
        groups = score_clips.sentenceize(words)
        assert groups[0]["boundary"] == "pause"
        assert not groups[0]["complete"]

    def test_punctuation_remains_a_complete_thought_signal(self):
        words = [make_word(word, i * 0.4) for i, word in enumerate(
            "that is why this works.".split())]
        group = score_clips.sentenceize(words)[0]
        assert group["complete"]
        assert group["boundary"] == "punctuation"

    def test_final_unpunctuated_whisper_segment_is_not_complete(self):
        words = [make_word(word, i * 0.4) for i, word in enumerate(
            "and then we started to realize".split())]
        segment = {"start": 0, "end": words[-1]["end"] + 0.05, "text": "and then we started to realize"}
        group = score_clips.sentenceize(words, segments=[segment])[-1]
        assert group["boundary"] == "end_of_transcript"
        assert not group["complete"]

    def test_final_whisper_punctuation_is_a_defensible_completion_signal(self):
        words = [make_word(word, i * 0.4) for i, word in enumerate("we finished the work".split())]
        segment = {"start": 0, "end": words[-1]["end"] + 0.05, "text": "We finished the work."}
        group = score_clips.sentenceize(words, segments=[segment])[-1]
        assert group["boundary"] == "whisper_segment"
        assert group["complete"]

    def test_long_unpunctuated_text_is_bounded_without_claiming_completeness(self):
        words = [make_word("conversation", i * 0.4) for i in range(100)]
        groups = score_clips.sentenceize(words, max_group_duration=8)
        assert max(group["end"] - group["start"] for group in groups) <= 8.5
        assert any(not group["complete"] for group in groups)


class TestPauseCompletion:
    @pytest.mark.parametrize(("pause", "expected"), [(3.4, False), (3.5, True)])
    def test_long_pause_threshold_after_clause_like_phrase(self, pause, expected):
        words = sentence("we learned an important lesson from that experience", 0)
        assert score_clips._pause_suggests_completion(words, pause) is expected

    @pytest.mark.parametrize("tail", ["dey", "wey", "make", "because"])
    def test_long_pause_after_open_pidgin_or_conversational_tail_is_incomplete(self, tail):
        words = sentence(f"we dey try understand wetin happen {tail}", 0)
        next_word = make_word("then", words[-1]["end"] + 4.0)
        groups = score_clips.sentenceize(words + [next_word])
        assert groups[0]["boundary"] == "pause"
        assert not groups[0]["complete"]


class TestScoring:
    def test_hook_sentence_scores_higher(self, sample_words):
        sents = score_clips.sentenceize(sample_words)
        hook = next(s for s in sents if "nobody tells" in s["text"])
        flat = next(s for s in sents if "thanks for watching" in s["text"])
        _, h_score = score_clips.score_sentence(hook)
        _, f_score = score_clips.score_sentence(flat)
        assert h_score > f_score

    def test_score_in_range(self, sample_words):
        sents = score_clips.sentenceize(sample_words)
        for s in sents:
            _, sc = score_clips.score_sentence(s)
            assert 0.0 <= sc <= 10.0

    def test_complete_arc_bonus(self):
        done = score_clips.score_sentence(
            {"text": "That is the whole story.", "start": 0, "end": 3, "words": []})
        mid = score_clips.score_sentence(
            {"text": "and then we were walking to the", "start": 0, "end": 3, "words": []})
        assert done[1] > mid[1]


class TestHooks:
    def test_make_hook_strips_fillers(self):
        assert "um" not in score_clips.make_hook("um basically the secret sauce")

    def test_make_hook_length(self):
        assert len(score_clips.make_hook("a b c d e f g h i j").split()) <= 7

    def test_make_hook_never_empty(self):
        assert score_clips.make_hook("!!!") == "clip"


class TestCandidates:
    def test_build_candidates_shape(self, sample_words):
        sents = score_clips.sentenceize(sample_words)
        segs = score_clips.build_candidates(sents, min_len=5, max_len=30, max_clips=3)
        assert 0 < len(segs) <= 3
        for s in segs:
            assert s["end"] > s["start"]
            assert 0 <= s["start"] and s["end"] <= 50.0
            assert s["hook"]
            assert 0 <= s["overall"] <= 10

    def test_candidate_shortlist_keeps_distinct_alternatives(self, sample_words):
        # Candidate windows may overlap: this is a ranking shortlist, not the
        # final rendered selection. The run-level selector enforces spacing.
        sents = score_clips.sentenceize(sample_words)
        segs = score_clips.build_candidates(sents, min_len=5, max_len=30, max_clips=10)
        keys = {(round(s["start"], 1), round(s["end"], 1)) for s in segs}
        assert len(keys) == len(segs)
        assert len(segs) > 1
        assert all(s["end"] > s["start"] for s in segs)


class TestNearest:
    def test_exact_and_between(self):
        assert score_clips._nearest([1, 5, 9], 5) == 1
        assert score_clips._nearest([1, 5, 9], 6) == 1
        assert score_clips._nearest([1, 5, 9], 8) == 2
        assert score_clips._nearest([4], 100) == 0


class TestRun:
    def test_run_writes_segments(self, workdir):
        segs, mode = score_clips.run(workdir, min_len=20, max_len=40, min_score=0)
        assert mode == "heuristic"
        assert (workdir / "segments.json").exists()
        on_disk = json.loads((workdir / "segments.json").read_text())
        assert len(on_disk) == len(segs) >= 1

    def test_ollama_fallback_on_dead_server(self, workdir):
        segs, mode = score_clips.run(workdir, llm="qwen2.5:7b",
                                     host="http://127.0.0.1:1", max_clips=3, min_len=20, max_len=40, min_score=0)
        assert mode == "heuristic"       # graceful fallback, no crash
        assert len(segs) >= 1

    def test_missing_transcript_exits(self, tmp_path):
        with pytest.raises(SystemExit):
            score_clips.run(tmp_path)

    def test_bom_transcript_accepted(self, workdir):
        raw = (workdir / "transcript.json").read_bytes()
        (workdir / "transcript.json").write_bytes(b"\xef\xbb\xbf" + raw)
        segs, _ = score_clips.run(workdir, min_score=0, min_len=20, max_len=50)
        assert len(segs) >= 1

    def test_sparse_asr_fails_gracefully_with_compact_diagnostics(self, workdir, capsys):
        data = json.loads((workdir / "transcript.json").read_text())
        data.update(words=[], segments=[], duration=54.4, language="en", language_probability=0.54)
        (workdir / "transcript.json").write_text(json.dumps(data))
        with pytest.raises(SystemExit, match="no word timestamps"):
            score_clips.run(workdir)
        output = capsys.readouterr().out
        assert "duration=54.4s" in output
        assert "language=en (confidence=0.54)" in output
        assert "ASR segments=0" in output
        assert "sparse or ASR may have missed" in output

    def test_language_and_script_mismatch_are_reported(self, capsys):
        words = [make_word("తెలుగు", i * 0.4) for i in range(8)]
        data = {"duration": 12, "language": "yo", "language_probability": 0.98,
                "expected_language": "en", "segments": [{"quality": {
                    "avg_logprob": -0.4, "no_speech_prob": 0.1, "compression_ratio": 1.2}}],
                "words": words}
        result = score_clips.print_transcript_diagnostics(data, 1)
        output = capsys.readouterr().out
        assert "ASR language warning: requested en but detected yo" in output
        assert "mostly TELUGU" in output
        assert "avg_logprob=-0.40" in output
        assert result["script_mismatch"]

    def test_small_telugu_prefix_in_latin_pidgin_is_reported_without_transcript(self, capsys):
        telugu = [make_word("తెలుగు", i * 0.3) for i in range(12)]
        pidgin_words = "na wetin we dey talk about because plenty people no get the chance to learn this early".split()
        latin = [make_word(word, 5 + i * 0.3) for i, word in enumerate(pidgin_words * 8)]
        words = telugu + latin
        data = {"duration": 80, "language": "yo", "language_probability": 0.98,
                "segments": [{"quality": {}}] * 5, "words": words}
        result = score_clips.print_transcript_diagnostics(data, 20)
        output = capsys.readouterr().out
        assert "ASR script anomaly: mixed scripts" in output
        assert "TELUGU=" in output and "LATIN=" in output
        assert "na wetin we dey talk" not in output
        assert result["script_mismatch"]

    def test_weak_candidates_still_fail_the_quality_gate(self, workdir, monkeypatch):
        weak = {"start": 0.0, "end": 25.0, "hook": "ordinary conversation", "overall": 5.4,
                "signals": {"transcript": 5.4}}
        monkeypatch.setattr(score_clips, "build_candidates", lambda *a, **k: [weak])
        with pytest.raises(SystemExit, match="5.5/10 quality gate"):
            score_clips.run(workdir, min_len=20, max_len=30, min_score=5.5)

    def test_unpunctuated_conversation_finds_distinct_windows_across_long_source(self):
        words = []
        segments = []
        phrases = [
            "the reason this matters is because your first idea is rarely your best idea.",
            "And I learned the hard way that customers teach you what to build next.",
            "And if you listen carefully you can turn every complaint into a useful lesson.",
        ]
        for group_index in range(72):
            start = group_index * 5.6
            phrase = phrases[group_index % len(phrases)].split()
            local_words = [make_word(word, start + i * 0.34) for i, word in enumerate(phrase)]
            words.extend(local_words)
            segments.append({"start": start, "end": local_words[-1]["end"] + 0.1, "text": " ".join(phrase)})
        groups = score_clips.sentenceize(words, segments=segments)
        candidates = score_clips.build_candidates(groups, min_len=20, max_len=50, max_clips=24)
        assert len(candidates) >= 6
        starts = sorted({candidate["start"] for candidate in candidates})
        assert starts[-1] - starts[0] > 300
        assert all(candidate["end"] - candidate["start"] <= 50 for candidate in candidates)
        for candidate in candidates:
            final_group = next(group for group in groups
                               if group["end"] == pytest.approx(candidate["end"]))
            assert score_clips._group_complete(final_group)


class TestTranscription:
    def test_language_probability_and_quality_are_saved_without_logging_transcript(self, tmp_path, monkeypatch, capsys):
        calls = {}

        class Model:
            def __init__(self, *args, **kwargs):
                pass

            def transcribe(self, video, **kwargs):
                calls.update(kwargs)
                word = SimpleNamespace(word="private words", start=0.2, end=1.0)
                segment = SimpleNamespace(start=0.2, end=1.0, text="PRIVATE TRANSCRIPT",
                    words=[word], avg_logprob=-0.3, no_speech_prob=0.1, compression_ratio=1.1)
                return iter([segment]), SimpleNamespace(language="yo", language_probability=0.98,
                                                         duration=4.0)

        monkeypatch.setitem(sys.modules, "faster_whisper", SimpleNamespace(WhisperModel=Model))
        video = tmp_path / "source.mp4"
        video.write_bytes(b"video")
        download_and_transcribe.transcribe(video, tmp_path, "small", "cpu", "int8", "yo")
        data = json.loads((tmp_path / "transcript.json").read_text())
        output = capsys.readouterr().out
        assert calls["language"] == "yo"
        assert data["language_probability"] == pytest.approx(0.98)
        assert data["expected_language"] == "yo"
        assert data["segments"][0]["quality"] == {
            "avg_logprob": -0.3, "no_speech_prob": 0.1, "compression_ratio": 1.1}
        assert "PRIVATE TRANSCRIPT" not in output


# ----------------------------------------------------------------- tighten

class TestPlanCuts:
    def test_no_words_keeps_everything(self):
        keeps = tighten.plan_cuts([], 10.0, 40.0)
        assert keeps == [(0.0, 30.0)]

    def test_filler_words_dropped(self, sample_words):
        keeps = tighten.plan_cuts(sample_words, 16.5, 25.0, fillers=True, silence=False)
        total = sum(b - a for a, b in keeps)
        assert total < 25.0 - 16.5          # something was cut
        # "um" sits at clip-relative ~0-0.35s and is guarded only by GUARD=0.15
        assert all(a >= 0.0 for a, b in keeps)

    def test_silence_cut_only_when_asked(self, sample_words):
        loose = tighten.plan_cuts(sample_words, 0.0, 48.0, gap=0.6, silence=True)
        strict = tighten.plan_cuts(sample_words, 0.0, 48.0, gap=5.0, silence=True)
        assert sum(b - a for a, b in strict) > sum(b - a for a, b in loose)

    def test_guard_band_never_cut(self, sample_words):
        keeps = tighten.plan_cuts(sample_words, 0.0, 48.0)
        assert keeps[0][0] == 0.0
        assert keeps[-1][1] == pytest.approx(48.0, abs=0.05)

    def test_minimum_keep_respected(self, sample_words):
        keeps = tighten.plan_cuts(sample_words, 0.0, 48.0)
        for a, b in keeps:
            assert b - a >= tighten.MIN_KEEP - 0.01

    def test_filler_seq_you_know(self):
        w = sentence("you know this thing is huge", 0.0)
        keeps = tighten.plan_cuts(w, 0.0, 12.0, fillers=True, silence=False)
        total = sum(b - a for a, b in keeps)
        assert total < 12.0                  # "you know" got dropped


class TestRemap:
    def test_remap_shifts_words_left(self, sample_words):
        keeps = [(0.0, 2.0), (5.0, 8.0)]     # cut 3s in the middle
        out, dur = tighten.remap_words(sample_words, 0.0, keeps)
        assert dur == pytest.approx(5.0)
        assert all(w["end"] <= dur + 0.01 for w in out)

    def test_remap_preserves_word_order(self, sample_words):
        keeps = [(0.0, 2.0), (5.0, 8.0)]     # (5,8) is silence -> no words there
        out, _ = tighten.remap_words(sample_words, 0.0, keeps)
        text = " ".join(w["word"] for w in out)
        assert text.startswith("Here is the")

    def test_remap_dur_matches_keeps_sum(self, sample_words):
        keeps = [(0.0, 3.0), (4.0, 9.0)]
        _, dur = tighten.remap_words(sample_words, 0.0, keeps)
        assert dur == pytest.approx(sum(b - a for a, b in keeps))


# ------------------------------------------------------------- render_clips

class TestRenderHelpers:
    def test_sanitize_filename(self):
        assert render_clips.sanitize("Hello, World! 123") == "hello-world-123"
        assert render_clips.sanitize("") == "clip"
        assert len(render_clips.sanitize("x" * 200)) <= 70

    def test_crop_for_16x9_source(self):
        assert render_clips.crop_for(1920, 1080, 1920, 1080) == (1920, 1080, 0, 0)

    def test_crop_for_vertical(self):
        cw, ch, x0, y0 = render_clips.crop_for(1920, 1080, 1080, 1920)
        assert cw == 608                     # round(1080 * 1080/1920) = round(607.5)
        assert ch == 1080 and x0 == 656 and y0 == 0

    def test_vertical_fit_filter_preserves_source_aspect(self):
        vf = render_clips.build_vertical_fit_filter(1080, 1920)
        assert "split=2[bg][fg]" in vf
        assert "force_original_aspect_ratio=decrease[fgfit]" in vf
        assert "overlay=(W-w)/2:(H-h)/2" in vf
        assert "subtitles=_caption.ass[v]" in vf
        assert "crop=1080:1920" in vf  # only the blurred background is cropped

    def test_caption_groups_fit_narrow_vertical_width(self):
        words = [
            {"word": "This", "start": 0, "end": 0.2},
            {"word": "subtitle", "start": 0.2, "end": 0.4},
            {"word": "should", "start": 0.4, "end": 0.6},
            {"word": "remain", "start": 0.6, "end": 0.8},
            {"word": "inside", "start": 0.8, "end": 1.0},
            {"word": "the", "start": 1.0, "end": 1.2},
            {"word": "frame", "start": 1.2, "end": 1.4},
        ]
        groups = render_clips.group_caption_words(words, max_chars=15)
        assert all(len(" ".join(w["word"] for w in group)) <= 15 for group in groups)
        assert [w["word"] for group in groups for w in group] == [w["word"] for w in words]

    def test_default_out_env_override(self, tmp_path, monkeypatch):
        monkeypatch.setenv("CHOPIFY_OUT", str(tmp_path / "myclips"))
        assert render_clips.default_out() == tmp_path / "myclips"

    def test_default_out_fallback(self, monkeypatch):
        monkeypatch.delenv("CHOPIFY_OUT", raising=False)
        assert render_clips.default_out() == Path("clips")

    def test_get_style_valid_and_invalid(self):
        assert render_clips.get_style("hormozi")["font"] == "Arial Black"
        with pytest.raises(SystemExit):
            render_clips.get_style("nope")


class TestWriteMeta:
    def test_meta_file_written(self, tmp_path):
        seg = {"start": 12.5, "end": 44.0, "hook": "the-biggest-mistake", "overall": 8.2}
        clip = tmp_path / "the-biggest-mistake.mp4"
        p = render_clips.write_meta(seg, clip)
        assert p.exists() and p.name.endswith(".meta.json")
        meta = json.loads(p.read_text(encoding="utf-8"))
        assert meta["score"] == 8.2
        assert "The biggest mistake" in meta["title"]
        assert meta["hashtags"][0] == "#shorts"


class TestASS:
    def test_ass_contains_events(self, tmp_path, sample_words):
        out = tmp_path / "c.ass"
        render_clips.build_ass(sample_words, 0.0, 48.0, out, 1080, 1920, 96, 300)
        content = out.read_text(encoding="utf-8")
        assert "Dialogue: 0," in content
        assert "PlayResY: 1920" in content

    def test_ass_style_preset_colours(self, tmp_path, sample_words):
        out_y = tmp_path / "y.ass"
        out_r = tmp_path / "r.ass"
        render_clips.build_ass(sample_words, 0.0, 48.0, out_y, 1920, 1080, 72, 95,
                               style_name="default")
        render_clips.build_ass(sample_words, 0.0, 48.0, out_r, 1920, 1080, 72, 95,
                               style_name="hormozi")
        assert "&H00FFFF&" in out_y.read_text(encoding="utf-8")
        assert "&H0000FF&" in out_r.read_text(encoding="utf-8")   # red highlight

    def test_ass_escapes_braces(self, tmp_path):
        w = [{"word": "{weird}", "start": 0.0, "end": 0.3}]
        out = tmp_path / "e.ass"
        render_clips.build_ass(w, 0.0, 1.0, out, 1920, 1080, 72, 95)
        assert "{" not in render_clips.ass_escape("{weird}")


# ------------------------------------------------------- v1.3: complete-thought

class TestArc:
    def test_is_arc_complete(self):
        assert score_clips.is_arc_complete("That is the whole story.")
        assert score_clips.is_arc_complete('He said "no!"')
        assert not score_clips.is_arc_complete("walking to the")
        assert not score_clips.is_arc_complete("")

    def test_candidates_end_on_complete_thought(self, sample_words):
        sents = score_clips.sentenceize(sample_words)
        segs = score_clips.build_candidates(sents, min_len=5, max_len=30, max_clips=5)
        assert segs
        for seg_ in segs:
            last = [s for s in sents
                    if s["end"] <= seg_["end"] + 0.01 and s["end"] > seg_["start"] - 30]
            assert score_clips.is_arc_complete(last[-1]["text"]), seg_

    def test_grow_window_backs_off_mid_sentence_end(self):
        # one complete sentence followed by an incomplete tail with no punctuation
        words = (sentence("Here is the thing nobody tells you about this.", 0.0)
                 + sentence("and then we were walking to the", 8.0))
        sents = score_clips.sentenceize(words)
        taken = [False] * len(sents)
        w = score_clips._grow_window(sents, 0, taken, min_len=5, max_len=30)
        assert w is not None
        a, b = w
        assert score_clips.is_arc_complete(sents[b]["text"])


# ------------------------------------------------------------ v1.3: --search

class TestSearch:
    def test_search_hits_all_tokens(self, sample_words):
        sents = score_clips.sentenceize(sample_words)
        hits = score_clips.search_hits(sents, "biggest mistake")
        assert len(hits) == 1
        assert "biggest mistake" in sents[hits[0]]["text"].lower()

    def test_search_hits_all_tokens_required(self, sample_words):
        sents = score_clips.sentenceize(sample_words)
        # "secret" and "quitting" never co-occur in one sentence -> no hits
        assert score_clips.search_hits(sents, "secret quitting") == []

    def test_search_hits_empty_query(self, sample_words):
        assert score_clips.search_hits(score_clips.sentenceize(sample_words), "") == []
        assert score_clips.search_hits(score_clips.sentenceize(sample_words), "!!!") == []

    def test_search_candidates_shape(self, sample_words):
        sents = score_clips.sentenceize(sample_words)
        segs = score_clips.search_candidates(sents, "biggest mistake",
                                             min_len=5, max_len=30, max_clips=3)
        assert len(segs) == 1
        assert segs[0]["start"] <= sents[3]["start"]

    def test_run_search_writes_segments(self, workdir):
        segs, mode = score_clips.run(workdir, search="biggest mistake",
                                     min_len=4, max_len=20)
        assert mode == "heuristic"
        assert len(segs) == 1
        on_disk = json.loads((workdir / "segments.json").read_text())
        assert len(on_disk) == 1

    def test_run_search_no_match_exits(self, workdir):
        with pytest.raises(SystemExit):
            score_clips.run(workdir, search="zzzqqqxyzzy")



# ------------------------------------------------------------- v1.3: --clips

def seg(start, end, hook, overall=5.0):
    return {"start": start, "end": end, "hook": hook, "overall": overall}


class TestPick:
    def test_pick_segments_subset(self):
        segs = [seg(0, 5, "a"), seg(6, 9, "b"), seg(10, 15, "c")]
        got = score_clips.pick_segments(segs, "1,3")
        assert [s["hook"] for s in got] == ["a", "c"]

    def test_pick_none_returns_all(self):
        segs = [seg(0, 5, "a")]
        assert score_clips.pick_segments(segs, None) is segs

    def test_pick_tolerates_spaces(self):
        segs = [seg(0, 5, "a"), seg(6, 9, "b")]
        got = score_clips.pick_segments(segs, "2, 1")
        assert [s["hook"] for s in got] == ["a", "b"]

    def test_pick_out_of_range_exits(self):
        with pytest.raises(SystemExit):
            score_clips.pick_segments([seg(0, 5, "a")], "5")

    def test_pick_non_numeric_exits(self):
        with pytest.raises(SystemExit):
            score_clips.pick_segments([seg(0, 5, "a")], "x")

    def test_run_pick_selects_one(self, workdir):
        segs, _ = score_clips.run(workdir, min_len=4, max_len=20, pick="1", min_score=0)
        assert len(segs) == 1

    def test_run_pick_out_of_range_exits(self, workdir):
        with pytest.raises(SystemExit):
            score_clips.run(workdir, min_len=4, max_len=20, pick="99")


class TestPrintTable:
    def test_table_lists_indexes(self, capsys):
        score_clips.print_table([seg(0, 5, "alpha hook", 7.2),
                                 seg(6, 9, "beta hook", 6.1)])
        out = capsys.readouterr().out
        assert "alpha hook" in out and "7.2/10" in out



# --------------------------------------------------------- v1.3: --preview

class TestPreview:
    def test_preview_dims(self):
        assert render_clips.PREVIEW["16:9"] == (854, 480)
        assert render_clips.PREVIEW["9:16"] == (480, 854)
        assert render_clips.PREVIEW["1:1"] == (480, 480)

    def test_preview_dims_match_aspect(self):
        for a, (tw, th) in render_clips.PREVIEW.items():
            fw, fh = render_clips.ASPECTS[a][:2]
            assert abs(tw / th - fw / fh) < 0.02


# ------------------------------------------------------- v1.3: preflight

class TestPreflight:
    def test_missing_ffmpeg_flagged(self, monkeypatch):
        monkeypatch.setattr(chopify.shutil, "which", lambda t: None)
        monkeypatch.setattr(chopify, "_missing_modules", lambda: [])
        problems = chopify.check_environment()
        assert any("ffmpeg" in p for p in problems)
        assert any("ffprobe" in p for p in problems)

    def test_missing_libx264_flagged(self, monkeypatch):
        monkeypatch.setattr(chopify.shutil, "which",
                            lambda t: "C:/bin/ffmpeg.exe" if t == "ffmpeg"
                            else "C:/bin/ffprobe.exe")
        monkeypatch.setattr(chopify, "_missing_modules", lambda: [])
        fake = subprocess.CompletedProcess([], 0, stdout=" V mp4v ... A pcm_s16le")
        problems = chopify.check_environment(runner=lambda cmd, **k: fake)
        assert any("libx264" in p for p in problems)
        assert any("AAC" in p for p in problems)

    def test_clean_environment_passes(self, monkeypatch):
        monkeypatch.setattr(chopify.shutil, "which", lambda t: "C:/bin/" + t)
        monkeypatch.setattr(chopify, "_missing_modules", lambda: [])
        fake = subprocess.CompletedProcess(
            [], 0, stdout=" V libx264 x264 ... A aac AAC (audio)")
        assert chopify.check_environment(runner=lambda cmd, **k: fake) == []

    def test_missing_module_flagged(self, monkeypatch):
        monkeypatch.setattr(chopify.shutil, "which", lambda t: "C:/bin/" + t)
        monkeypatch.setattr(chopify, "_missing_modules",
                            lambda: [("faster_whisper",
                                      "pip install -r requirements.txt")])
        fake = subprocess.CompletedProcess([], 0, stdout=" V libx264 ... A aac AAC")
        problems = chopify.check_environment(runner=lambda cmd, **k: fake)
        assert len(problems) == 1
        assert "faster_whisper" in problems[0]
        assert "pip install" in problems[0]


class TestProjectsOptions:
    def test_blur_fill_accepted(self):
        opts = projects.validate_options({"blur_fill": True})
        assert opts["blur_fill"] is True
        assert opts["min_len"] == 60 and opts["max_len"] == 180

    def test_blur_fill_must_be_bool(self):
        with pytest.raises(ValueError):
            projects.validate_options({"blur_fill": "yes"})


