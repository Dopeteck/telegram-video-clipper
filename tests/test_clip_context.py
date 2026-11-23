"""Regression tests for context-aware, complete clip windows."""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import score_clips


def group(text, start, end, complete=None):
    item = {
        "start": float(start),
        "end": float(end),
        "text": text,
        "words": [{"word": word, "start": start, "end": end}
                  for word in text.split()],
    }
    if complete is not None:
        item["complete"] = complete
    return item


def grow(items, seed, min_len=3.0, max_len=12.0):
    return score_clips._grow_window(items, seed, [False] * len(items),
                                    min_len, max_len)


def test_dependent_opener_borrows_previous_context():
    items = [
        group("They had no idea what was coming.", 0, 3),
        group("And that changed everything.", 3.3, 6.3),
        group("The team never recovered.", 6.6, 9.6),
    ]
    assert grow(items, 1, min_len=5) == (0, 1)


def test_answer_keeps_its_preceding_question():
    items = [
        group("Why did the company fail?", 0, 2),
        group("Because nobody checked the numbers.", 2.3, 5.3),
    ]
    assert grow(items, 1, min_len=4) == (0, 1)


def test_dangling_clause_extends_into_its_completion():
    items = [
        group("The reason this failed was because", 0, 2, complete=False),
        group("we never checked the source.", 2.2, 5.2, complete=True),
    ]
    assert grow(items, 0, min_len=4) == (0, 1)


def test_unanswered_question_is_not_a_complete_clip():
    items = [group("What happened after that?", 0, 3)]
    assert grow(items, 0, min_len=2) is None


def test_clip_never_exceeds_hard_maximum_to_finish_a_thought():
    items = [
        group("We thought it was over.", 0, 3),
        group("And then the entire room started cheering.", 3.2, 7.2),
        group("Nobody expected that reaction.", 7.4, 10.4),
    ]
    window = grow(items, 0, min_len=2, max_len=6)
    assert window is not None
    a, b = window
    assert items[b]["end"] - items[a]["start"] <= 6


def test_context_is_not_borrowed_across_a_real_pause():
    items = [
        group("The first team had already left.", 0, 3),
        group("But the second team stayed.", 9, 12),
    ]
    assert grow(items, 1, min_len=2) is None


def test_tight_continuation_with_and_is_kept():
    items = [
        group("We thought it was over.", 0, 2),
        group("And then the whole room erupted.", 2.2, 5.2),
    ]
    assert grow(items, 0, min_len=2.5) == (0, 1)


def test_context_first_window_can_grow_to_a_two_minute_thought():
    items = [
        group("The point started with an important detail and", 0, 20, complete=False),
        group("then the speaker explained why it mattered and", 20.2, 40.2, complete=False),
        group("gave the example that made the situation clear and", 40.4, 60.4, complete=False),
        group("continued with the consequence nobody had considered and", 60.6, 80.6, complete=False),
        group("explained how the decision affected everyone and", 80.8, 100.8, complete=False),
        group("finally showed why the whole story mattered.", 101.0, 121.0, complete=True),
    ]
    window = grow(items, 0, min_len=60, max_len=180)
    assert window == (0, 5)
    assert items[window[1]]["end"] - items[window[0]]["start"] >= 120


def test_context_growth_respects_three_minute_hard_ceiling():
    items = [
        group(f"Part {i} continues the explanation and", i * 20, i * 20 + 19, complete=False)
        for i in range(8)
    ]
    items.append(group("That is the complete conclusion.", 160, 179, complete=True))
    items.append(group("A separate point begins here.", 180, 199, complete=True))
    window = grow(items, 0, min_len=60, max_len=180)
    assert window is not None
    a, b = window
    assert items[b]["end"] - items[a]["start"] <= 180
    assert b == 8


def test_adjacent_complete_sentences_stay_together_until_story_payoff():
    items = [
        group("The company had one problem with its payment system.", 0, 20, complete=True),
        group("And then customers started reporting the same failure.", 20.2, 40.2, complete=True),
        group("Because the payment system kept rejecting valid cards.", 40.4, 60.4, complete=True),
        group("And the support team could not explain what was happening.", 60.6, 80.6, complete=True),
        group("So the founder finally traced it to one small configuration.", 80.8, 100.8, complete=True),
        group("And that was the change that fixed the entire problem.", 101.0, 121.0, complete=True),
    ]
    window = grow(items, 0, min_len=60, max_len=180)
    assert window == (0, 5)
    assert items[window[1]]["end"] - items[window[0]]["start"] >= 120
