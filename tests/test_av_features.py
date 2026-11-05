import sys
from pathlib import Path

# Ensure top-level pipeline modules are importable when pytest collects tests
# from the tests/ directory in GitHub Actions.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import av_features
import score_clips


def test_score_interval_rewards_audio_and_scene_activity():
    features = {
        "audio": [(0.0, 0.1), (0.5, 0.9), (1.0, 0.8), (1.5, 0.2)],
        "scene_changes": [0.5, 1.0],
    }
    audio, visual, cuts = av_features.score_interval(features, 0.0, 2.0)
    assert 0.0 < audio < 1.0
    assert visual > 0.0
    assert cuts == 2


def test_score_interval_handles_no_media_features():
    audio, visual, cuts = av_features.score_interval(
        {"audio": [], "scene_changes": []}, 10.0, 30.0
    )
    assert (audio, visual, cuts) == (0.0, 0.0, 0)


def test_audio_visual_segment_score_records_reasons():
    sentences = [{
        "start": 0.0, "end": 4.0,
        "text": "That was an amazing moment.",
        "words": [
            {"word": "That", "start": 0.0, "end": 0.4},
            {"word": "was", "start": 0.4, "end": 0.8},
            {"word": "an", "start": 0.8, "end": 1.0},
            {"word": "amazing", "start": 1.0, "end": 2.0},
            {"word": "moment.", "start": 2.0, "end": 3.0},
        ],
    }]
    features = {
        "audio": [(0.5, 0.9), (1.0, 0.9), (1.5, 0.9)],
        "scene_changes": [1.0, 2.0],
    }
    segment = score_clips._make_segment(sentences, 0, 0, features)
    assert "audio_energy" in segment["signals"]
    assert segment["signals"]["scene_changes"] == 2
    assert segment["selection_reasons"]



def test_dramatic_dialogue_can_clear_gate_without_canned_viral_keywords():
    lines = [
        "Listen to him.",
        "Silence!",
        "When you first came here, you asked for judgment.",
        "And I pass it now!",
        "We don't want judgment!",
        "He's here!",
        "We don't want judgment!",
        "Exile!",
        "No!",
    ]
    sentences = []
    for index, text in enumerate(lines):
        start = float(index * 2)
        tokens = text.split()
        words = []
        for token_index, token in enumerate(tokens):
            word_start = start + token_index * 0.12
            words.append({
                "word": token,
                "start": word_start,
                "end": word_start + 0.1,
            })
        sentences.append({
            "start": start,
            "end": start + 1.2,
            "text": text,
            "words": words,
        })

    features = {
        "audio": [(float(t), 0.52) for t in range(18)],
        "scene_changes": [float(t) for t in range(1, 18)],
    }
    segment = score_clips._make_segment(sentences, 0, len(sentences) - 1, features)

    assert segment["signals"]["dialogue_dynamics"] >= 6.5
    assert segment["overall"] >= 5.5
    assert "sustained dramatic dialogue" in segment["selection_reasons"]
