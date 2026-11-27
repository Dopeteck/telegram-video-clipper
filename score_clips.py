"""
Stage 2 of the chopify pipeline - the built-in "brain".

Reads work/transcript.json, picks the most viral self-contained moments and
writes work/segments.json (a bare JSON array render_clips.py consumes):

    [{"start": 134.2, "end": 187.6, "hook": "short title", "overall": 8.4}]

Two scoring modes, both free:

  1. heuristic (default) - pure-Python scoring over the transcript: words per
     second (energy), lexical cue detection (hook / shock / humour /
     controversy / insight / emotion) and arc completion. Deterministic,
     zero dependency.
  2. --llm MODEL - asks a LOCAL Ollama server (http://localhost:11434) in JSON
     mode to pick the moments. Falls back to the heuristic automatically if
     Ollama is unreachable or returns junk.

No paid APIs, no API keys. Usage:
    python score_clips.py work
    python score_clips.py work --llm qwen2.5:7b
    python score_clips.py work --min-score 6.0 --max-clips 12
"""
import re
import json
import argparse
import urllib.request
import urllib.error
import unicodedata
from pathlib import Path

OLLAMA_HOST = "http://localhost:11434"

FILLER_TOKENS = {"um", "uh", "uhh", "umm", "erm", "er", "hmm", "mmm", "mm", "ah", "eh"}
FILLER_SEQS = {("you", "know"), ("i", "mean"), ("kind", "of"), ("sort", "of")}

HOOK_CUES = ("the secret", "nobody tells you", "here's the thing", "here is the thing",
             "what most people", "the truth is", "here's why", "here is why", "imagine",
             "the problem is", "the biggest mistake", "let me tell you", "you need to",
             "here's how", "here is how", "the trick", "the key", "listen", "story")
SHOCK_CUES = ("insane", "crazy", "shocking", "unbelievable", "never", "nobody", "everyone",
              "banned", "illegal", "mistake", "wrong", "destroyed", "worst", "best",
              "huge", "million", "billion", "dead", "killed")
HUMOUR_CUES = ("haha", "lol", "laugh", "joke", "funny", "hilarious", "kidding", "ridiculous")
CONTROVERSY_CUES = ("i disagree", "unpopular opinion", "hot take", "controversial",
                    "stop doing", "don't do", "do not do", "overrated", "underrated",
                    "everyone is wrong", "myth", "lie", "scam")
INSIGHT_CUES = ("because", "the reason", "how it works", "step one", "first", "second",
                "third", "the way", "what happens", "if you", "the difference",
                "framework", "system", "lesson", "learned", "the point")
EMOTION_CUES = ("love", "hate", "afraid", "scared", "amazing", "terrible", "proud",
                "embarrassed", "angry", "excited", "grateful", "hurts", "cried",
                "dream", "hope", "believe")


# ---------------------------------------------------------------- transcript

def load_transcript(workdir):
    path = Path(workdir) / "transcript.json"
    if not path.exists():
        raise SystemExit(f"No transcript at {path} - run download_and_transcribe.py first")
    # utf-8-sig transparently handles BOM'd files from Windows editors too
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except json.JSONDecodeError as e:
        raise SystemExit(f"transcript.json is not valid JSON: {e}")
    data.setdefault("words", [])
    data.setdefault("segments", [])
    return data


ARC_RE = re.compile(r"[.!?\u2026][\"')\]]?$")


def is_arc_complete(text):
    """True when a sentence ends with terminal punctuation (a complete thought)."""
    return bool(ARC_RE.search((text or "").strip()))


INCOMPLETE_TAILS = {
    "a", "an", "the", "and", "but", "or", "because", "if", "when", "while",
    "although", "that", "which", "who", "whom", "whose", "to", "for", "of",
    "with", "from", "at", "in", "on", "by", "as", "than", "so", "my",
    "your", "our", "their", "his", "her", "its", "this", "these", "those",
    "is", "are", "was", "were", "am", "be", "been", "being", "have", "has",
    "had", "do", "does", "did", "can", "could", "will", "would", "should",
    "might", "must", "learned", "think", "thought", "know", "feel", "believe",
    "want", "need", "trying", "going", "dey", "wey", "make",
}


def _pause_suggests_completion(words, pause):
    """Treat only a pronounced pause after a clause-like tail as weak evidence."""
    if pause < 3.5 or len(words) < 6:
        return False
    tail = re.sub(r"[^\w']", "", words[-1]["word"].lower())
    return bool(tail) and tail not in INCOMPLETE_TAILS


def sentenceize(words, gap=1.2, segments=None, max_group_duration=18.0):
    """Group words using punctuation, pauses and Whisper chunk boundaries.

    Whisper boundaries are soft complete-thought hints, not fixed-length clip
    cuts. Long punctuation-free chunks are capped so they cannot swallow a
    whole recording; those emergency splits remain marked incomplete.
    """
    if not words:
        return []
    segments = segments or []
    bounds = [(float(s["start"]), float(s["end"]), is_arc_complete(s.get("text", "")))
              for s in segments if isinstance(s, dict) and "start" in s and "end" in s]
    groups, cur = [], []
    current_segment = None

    def flush(complete, reason):
        nonlocal cur
        if not cur:
            return
        text = " ".join(w["word"] for w in cur).strip()
        groups.append({"start": cur[0]["start"], "end": cur[-1]["end"],
                       "text": text, "words": cur,
                       "complete": complete or is_arc_complete(text),
                       "boundary": reason})
        cur = []

    segment_pointer = 0
    for word in words:
        seg_index = None
        if bounds:
            while (segment_pointer + 1 < len(bounds) and
                   word["start"] >= bounds[segment_pointer + 1][0] - 0.05):
                segment_pointer += 1
            seg_index = segment_pointer
        if cur:
            pause = word["start"] - cur[-1]["end"]
            new_segment = seg_index is not None and current_segment is not None and seg_index != current_segment
            at_limit = word["end"] - cur[0]["start"] > max_group_duration
            previous_segment_complete = (new_segment and bounds[current_segment][2])
            if pause > gap:
                flush(previous_segment_complete or _pause_suggests_completion(cur, pause), "pause")
            elif new_segment:
                flush(previous_segment_complete, "whisper_segment")
            elif at_limit:
                flush(False, "duration_limit")
        cur.append(word)
        current_segment = seg_index
        if is_arc_complete(word["word"]):
            flush(True, "punctuation")
            current_segment = seg_index
    final_segment_complete = bool(cur) and current_segment is not None and bounds and bounds[current_segment][2]
    flush(final_segment_complete, "whisper_segment" if final_segment_complete else "end_of_transcript")
    return groups


def _group_complete(group):
    return bool(group.get("complete", is_arc_complete(group["text"])))


_LATIN_LANGUAGES = {"en", "yo", "ig", "ha", "pcm", "sw", "fr", "es", "pt", "de", "it"}


def _script_counts(words):
    counts = {}
    for item in words:
        for char in item.get("word", ""):
            if not unicodedata.category(char).startswith("L"):
                continue
            name = unicodedata.name(char, "UNKNOWN")
            script = name.split(" ", 1)[0] if name != "UNKNOWN" else "UNKNOWN"
            counts[script] = counts.get(script, 0) + 1
    return counts


def speech_coverage(words, duration):
    """Fraction of the source covered by the union of recognized word times."""
    intervals = sorted((max(0.0, float(w["start"])), min(float(duration), float(w["end"])))
                       for w in words if w.get("end", 0) > w.get("start", 0))
    total = 0.0
    if intervals:
        start, end = intervals[0]
        for a, b in intervals[1:]:
            if a <= end:
                end = max(end, b)
            else:
                total += end - start
                start, end = a, b
        total += end - start
    return total / max(1.0, float(duration))


def print_transcript_diagnostics(data, sentence_count):
    """Log compact ASR health and coverage signals without transcript text."""
    words = data.get("words", [])
    segments = data.get("segments", [])
    duration = float(data.get("duration") or 0)
    language = data.get("language") or "unknown"
    probability = data.get("language_probability")
    confidence = f"{float(probability):.2f}" if isinstance(probability, (float, int)) else "n/a"
    coverage = speech_coverage(words, duration)
    rate = len(words) * 60.0 / max(1.0, duration)
    print(f"Transcript diagnostics: duration={duration:.1f}s, language={language} "
          f"(confidence={confidence}), words={len(words)}, ASR segments={len(segments)}, "
          f"speech coverage={coverage:.1%}, sentence groups={sentence_count}.", flush=True)

    metrics = {}
    for key in ("avg_logprob", "no_speech_prob", "compression_ratio"):
        values = [s.get("quality", {}).get(key) for s in segments
                  if isinstance(s.get("quality", {}).get(key), (int, float))]
        if values:
            metrics[key] = sum(values) / len(values)
    if metrics:
        print("ASR quality averages: " + ", ".join(f"{k}={v:.2f}" for k, v in metrics.items()), flush=True)

    scripts = _script_counts(words)
    letters = sum(scripts.values())
    non_latin = sum(count for script, count in scripts.items() if script != "LATIN")
    script_anomaly = (non_latin >= 5 and letters and non_latin / letters >= 0.005 and
                      "LATIN" in scripts)
    if letters and len(scripts) > 1:
        print("ASR script mix: " + ", ".join(f"{k}={v / letters:.0%}" for k, v in
              sorted(scripts.items(), key=lambda item: item[1], reverse=True)), flush=True)
    if data.get("expected_language") and language != data["expected_language"]:
        print(f"ASR language warning: requested {data['expected_language']} but detected {language}.", flush=True)
    dominant_script = max(scripts, key=scripts.get) if scripts else None
    if language in _LATIN_LANGUAGES and dominant_script and dominant_script != "LATIN":
        print(f"ASR language/script warning: {language} speech is usually written in Latin script, "
              f"but transcript text is mostly {dominant_script}; transcription may be unreliable.", flush=True)
    if script_anomaly:
        mix = ", ".join(f"{name}={count / letters:.0%}" for name, count in
                         sorted(scripts.items(), key=lambda item: item[1], reverse=True))
        print(f"ASR script anomaly: mixed scripts in detected {language} transcript ({mix}); "
              "an early language/transcription mismatch is possible.", flush=True)
    poor_quality = (metrics.get("avg_logprob", 0) < -1.0 or
                    metrics.get("no_speech_prob", 0) > 0.6 or
                    metrics.get("compression_ratio", 0) > 2.4)
    if probability is not None and probability < 0.6:
        print("ASR warning: language confidence is low; verify the transcript before trusting clip scores.", flush=True)
    if poor_quality:
        print("ASR warning: segment quality metrics indicate an unreliable transcript.", flush=True)
    if not words or (len(words) < 20 and rate < 30):
        print("Speech diagnostic: little speech was detected; the source may be sparse or ASR may have missed speech.", flush=True)
    return {"coverage": coverage, "word_rate": rate, "poor_quality": poor_quality,
            "script_mismatch": bool(script_anomaly or
                                    (language in _LATIN_LANGUAGES and dominant_script and dominant_script != "LATIN"))}


# ------------------------------------------------------------- heuristic core

# criterion -> weight (hook/energy/arc dominate; matches the README's 8 criteria)
WEIGHTS = {"hook": 0.20, "shock": 0.10, "humour": 0.05, "controversy": 0.10,
           "insight": 0.15, "emotion": 0.10, "energy": 0.15, "arc": 0.15}

def _cues(low, group):
    return min(1.0, sum(c in low for c in group) / 2.0)


def score_sentence(sent):
    text = sent["text"]
    low = " " + text.lower() + " "
    dur = max(0.1, sent["end"] - sent["start"])
    wps = len(sent["words"]) / dur
    arc = 1.0 if sent.get("complete", is_arc_complete(text)) else 0.55
    scores = {
        "hook": _cues(low, HOOK_CUES),
        "shock": _cues(low, SHOCK_CUES),
        "humour": _cues(low, HUMOUR_CUES),
        "controversy": _cues(low, CONTROVERSY_CUES),
        "insight": _sm_cues(low),
        "emotion": _cues(low, EMOTION_CUES),
        "energy": min(1.0, wps / 3.0),
        "arc": arc,
    }
    overall = sum(WEIGHTS[k] * v for k, v in scores.items()) * 10.0
    return scores, round(overall, 2)


def _sm_cues(low):
    return _cues(low, INSIGHT_CUES)


# Contextual conflict/turning-point language that fixed "viral" keywords miss.
# These are broad narrative signals, not references to any particular title.
DRAMA_CUES = (
    "silence", "judgment", "exile", "forgive", "forgiveness", "betray",
    "betrayed", "blame", "fault", "belong here", "get out", "go away",
    "leave", "stop", "don't", "do not", "can't", "cannot", "won't",
    "never", "no more", "because of you", "what have you done",
    "what happened", "i saw", "i know", "i had nothing", "you will",
    "must", "order", "attack", "fight", "kill", "dead", "threat",
    "promise", "refuse", "deny", "confess", "truth", "secret",
    "choose", "decide", "it's time", "this is", "let him", "listen",
)


def _dialogue_dynamics(sentences):
    """Estimate dramatic exchange structure from pace, reactions and conflict.

    This complements lexical virality cues: a tense exchange can be compelling
    even when nobody says a canned word such as 'shocking' or 'amazing'.
    """
    if not sentences:
        return 0.0
    start = sentences[0]["start"]
    end = sentences[-1]["end"]
    duration = max(1.0, end - start)
    count = len(sentences)
    pace = min(1.0, count / max(1.0, duration / 2.2))
    texts = [s["text"].strip() for s in sentences]
    reactions = sum(text.endswith(("?", "!")) for text in texts)
    reaction_rate = min(1.0, (reactions / max(1, count)) * 2.5)
    low = " " + " ".join(texts).lower() + " "
    conflict = _cues(low, DRAMA_CUES)
    return round(10.0 * (0.45 * pace + 0.25 * reaction_rate + 0.30 * conflict), 2)


def make_hook(text, max_words=7):
    words = [_norm_token(w) for w in text.split()]
    words = [w for w in words if w and w not in FILLER_TOKENS]
    return " ".join(words[:max_words]) or "clip"


def _norm_token(w):
    return re.sub(r"[^\w']", "", w.lower())


def _boundary_signals(left, right, av_features=None):
    """Measure whether a transcript gap looks like a true break in the content.

    A long gap alone is not enough to split a musical/performance passage:
    nearby audio energy and visual changes can indicate that the moment is
    continuing even when there are few recognized words.
    """
    gap = max(0.0, right["start"] - left["end"])
    if av_features is None:
        return gap, 0.0, 0
    audio = [(t, value) for t, value in av_features.get("audio", [])
             if left["end"] - 1.0 <= t <= right["start"] + 1.0]
    energy = sum(value for _, value in audio) / len(audio) if audio else 0.0
    cuts = sum(left["end"] - 1.0 <= t <= right["start"] + 1.0
               for t in av_features.get("scene_changes", []))
    return gap, energy, cuts


def _is_natural_break(left, right, av_features=None):
    """Avoid growing across silence or a long pause into another creator moment.

    Short pauses can be natural conversational rhythm. Longer transcript gaps
    need stronger evidence of continuous non-speech content (e.g. music or
    action) before we bridge them.
    """
    gap, energy, cuts = _boundary_signals(left, right, av_features)
    if gap < 4.5:
        return False
    if av_features is None:
        return True
    if gap >= 10.0:
        # Ambient noise alone should not glue separate creator thoughts
        # together. Bridge a long gap only when the audio remains strongly
        # active or the visuals show sustained cut activity.
        cut_rate = cuts / max(1.0, gap)
        return not (energy >= 0.70 or cut_rate >= 0.25)
    return energy < 0.20 and cuts == 0


def _creator_value_score(text):
    """Estimate creator-friendly value from natural speech structure.

    This intentionally avoids requiring viral catchphrases. Personal examples,
    direct audience relevance, concrete details, contrasts, and explanations
    are common in podcasts, interviews, commentary, and creator tutorials.
    """
    low = " " + (text or "").lower() + " "
    tokens = re.findall(r"\b[\w']+\b", low)
    if not tokens:
        return 0.0
    signals = 0.0
    # Natural audience-facing phrasing, not a mandatory hook template.
    if any(p in low for p in (" you ", " your ", " you’re ", " you're ", " imagine ")):
        signals += 0.22
    if any(p in low for p in (" i ", " my ", " me ", " we ", " our ")):
        signals += 0.18
    if any(p in low for p in (" because ", " the reason ", " that means ", " so that ")):
        signals += 0.22
    if any(p in low for p in (" but ", " however ", " instead ", " whereas ", " compared to ")):
        signals += 0.18
    # Specificity can make a useful story or takeaway more clip-worthy.
    if any(re.search(r"\d", token) for token in tokens):
        signals += 0.15
    if len(tokens) >= 24:
        signals += 0.10
    if "?" in text or "!" in text:
        signals += 0.08
    return min(1.0, signals)


DEPENDENT_OPENERS = {
    "and", "but", "because", "so", "although", "though", "while",
}
MAX_CONTEXT_GROUPS = 2
MAX_CONTEXT_SECONDS = 12.0
MAX_ANSWER_GAP = 3.0
MAX_CONTINUATION_GAP = 0.8


def _first_word(text):
    words = re.findall(r"[\w']+", (text or "").lower())
    return words[0] if words else ""


def _last_word(text):
    words = re.findall(r"[\w']+", (text or "").lower())
    return words[-1] if words else ""


def _opens_dependent(text):
    return _first_word(text) in DEPENDENT_OPENERS


def _ends_dangling(text):
    # Explicit terminal punctuation wins over the lexical tail heuristic.
    # Words such as "this", "that", or "to" can be legitimate sentence-final
    # words; treating them as dangling after a full stop rejects good clips.
    if is_arc_complete(text):
        return False
    return _last_word(text) in INCOMPLETE_TAILS


def _ends_question(text):
    return (text or "").strip().rstrip("\"'”’)]}").endswith("?")


def _group_gap(left, right):
    return max(0.0, float(right["start"]) - float(left["end"]))


_CONTINUATION_STARTERS = (
    "and then", "because", "however", "therefore", "for example",
    "for instance", "which", "that means", "this means", "as a result",
    "on top of that", "in other words",
)
_CONTINUATION_STOPWORDS = {
    "about", "after", "again", "also", "because", "before", "being", "could",
    "does", "doing", "from", "have", "here", "into", "just", "more", "most",
    "only", "other", "over", "same", "some", "such", "than", "that", "their",
    "them", "there", "these", "they", "this", "those", "through", "very",
    "what", "when", "where", "which", "while", "with", "would", "your",
}


def _is_arc_continuation(left, right):
    """Recognize adjacent sentences that are still developing the same point."""
    if _group_gap(left, right) > 1.8:
        return False
    following = re.sub(r"^[\W_]+", "", str(right.get("text", "")).lower())
    if any(re.match(r"^" + re.escape(phrase) + r"\b", following)
           for phrase in _CONTINUATION_STARTERS):
        return True
    def content_words(text):
        return {token for token in re.findall(r"[a-z0-9']+", str(text).lower())
                if len(token) >= 5 and token not in _CONTINUATION_STOPWORDS}
    left_words = content_words(left.get("text", ""))
    right_words = content_words(right.get("text", ""))
    if not left_words or not right_words:
        return False
    overlap = len(left_words & right_words) / max(1, min(len(left_words), len(right_words)))
    return overlap >= 0.20


def _is_contextual_continuation(sentences, left_index, right_index):
    """Allow a sentence to reconnect to the recent topic, not only its neighbour.

    Podcast answers and explanations often change vocabulary from one sentence
    to the next. A recent topic reference can still establish continuity across
    a short conversational exchange. We only look back three groups and never
    bridge a natural pause or a long gap.
    """
    if left_index < 0 or right_index >= len(sentences) or right_index != left_index + 1:
        return False
    left, right = sentences[left_index], sentences[right_index]
    if _is_arc_continuation(left, right):
        return True
    if _group_gap(left, right) > 1.8:
        return False

    # Preserve a short answer to a question even when the answer uses different
    # words (e.g. "Why?" -> "Because ...", "Did you?" -> "Yes, I ...").
    if _ends_question(left.get("text", "")):
        first = _first_word(right.get("text", ""))
        if first in {"yes", "yeah", "no", "well", "because", "actually", "i", "we", "it", "they"}:
            return True

    right_words = {
        token for token in re.findall(r"[a-z0-9']+", str(right.get("text", "")).lower())
        if len(token) >= 5 and token not in _CONTINUATION_STOPWORDS
    }
    if not right_words:
        return False

    # Reconnect to the topic established in the previous few adjacent groups.
    for prior_index in range(max(0, left_index - 2), left_index):
        prior = sentences[prior_index]
        if _group_gap(prior, sentences[prior_index + 1]) > 3.5:
            continue
        prior_words = {
            token for token in re.findall(r"[a-z0-9']+", str(prior.get("text", "")).lower())
            if len(token) >= 5 and token not in _CONTINUATION_STOPWORDS
        }
        if prior_words and len(prior_words & right_words) / max(1, min(len(prior_words), len(right_words))) >= 0.20:
            return True

    return False


def _grow_window(sentences, seed, taken, min_len, max_len, av_features=None):
    """Build a self-contained clip window without crossing a real scene break.

    Adds a small amount of preceding context for dependent openers or answers,
    includes a nearby answer to a question, and rejects dangling endings. The
    requested max_len is a hard ceiling; context never silently extends it.
    """
    n = len(sentences)
    if not n or seed < 0 or seed >= n or max_len <= 0:
        return None

    def span(a, b):
        return float(sentences[b]["end"]) - float(sentences[a]["start"])

    a = seed

    # Back up from emergency ASR splits until the clip begins at a complete
    # thought. Never cross a natural pause merely to manufacture context.
    while a > 0 and not _group_complete(sentences[a]):
        prev = a - 1
        if taken[prev] or _is_natural_break(sentences[prev], sentences[a], av_features):
            return None
        if span(prev, seed) > min(max_len, MAX_CONTEXT_SECONDS):
            return None
        a = prev

    # A sentence beginning with "And", "But", "Because", "This", etc. often
    # depends on the line before it. Likewise, an answer should retain its
    # preceding question. Borrow at most two nearby groups.
    context_count = 0
    while a > 0 and context_count < MAX_CONTEXT_GROUPS:
        current = sentences[a]
        previous = sentences[a - 1]
        needs_context = (_opens_dependent(current.get("text", "")) or
                         _ends_question(previous.get("text", "")) or
                         _is_arc_continuation(previous, current))
        if not needs_context or taken[a - 1]:
            break
        # Do not pull an already-complete window backward into a fragment.
        # Broad lexical overlap can connect neighbouring thoughts, but a
        # dependent opener ("And ...", "Because ...") is not safe as the
        # beginning of the borrowed context.
        if _opens_dependent(previous.get("text", "")):
            break
        if _is_natural_break(previous, current, av_features):
            break
        if _group_gap(previous, current) > MAX_ANSWER_GAP:
            break
        if span(a - 1, seed) > min(max_len, MAX_CONTEXT_SECONDS):
            break
        a -= 1
        context_count += 1

    # Do not begin on a dependent fragment if no safe context was available.
    # An unpunctuated opening clause may still be completed by the next group.
    if _opens_dependent(sentences[a].get("text", "")):
        return None
    if span(a, seed) > max_len:
        a = seed
        if _opens_dependent(sentences[a].get("text", "")):
            return None

    j = seed
    # Grow toward the target only while the next sentence belongs to the
    # same narrative. Never pad a coherent short moment with unrelated speech.
    while span(a, j) < min_len and j + 1 < n and not taken[j + 1]:
        current = sentences[j]
        following = sentences[j + 1]
        if _is_natural_break(current, following, av_features):
            break
        if span(a, j + 1) > max_len:
            break
        if not _is_contextual_continuation(sentences, j, j + 1):
            break
        j += 1

    # Once the minimum context is present, keep following the same narrative
    # across adjacent, semantically linked sentences. This lets a story or
    # explanation run 1-3 minutes instead of stopping at an arbitrary sentence.
    while j + 1 < n and not taken[j + 1]:
        current = sentences[j]
        following = sentences[j + 1]
        if _is_natural_break(current, following, av_features):
            break
        if span(a, j + 1) > max_len:
            break
        if not _is_contextual_continuation(sentences, j, j + 1):
            break
        j += 1

    # Extend incomplete clauses, dangling prepositions/conjunctions, and
    # questions through their nearby continuation/answer when possible.
    while j + 1 < n and not taken[j + 1]:
        current = sentences[j]
        following = sentences[j + 1]
        text = current.get("text", "")
        gap = _group_gap(current, following)
        needs_answer = _ends_question(text)
        needs_continuation = (
            not _group_complete(current)
            or _ends_dangling(text)
            or (_opens_dependent(following.get("text", ""))
                and gap <= MAX_CONTINUATION_GAP
                and _is_arc_continuation(current, following))
        )
        if not (needs_answer or needs_continuation):
            break
        if gap > (MAX_ANSWER_GAP if needs_answer else MAX_CONTINUATION_GAP):
            break
        if _is_natural_break(current, following, av_features):
            break
        if span(a, j + 1) > max_len:
            break
        j += 1
        # A single answer can complete a question; avoid swallowing a whole
        # subsequent conversation just because the answer itself is a question.
        if needs_answer and _group_complete(sentences[j]) and not _ends_question(
                sentences[j].get("text", "")):
            break

    # Back off to the last genuinely complete group. A question without an
    # answer is not a complete clip ending.
    while j >= a and (
        not _group_complete(sentences[j])
        or _ends_dangling(sentences[j].get("text", ""))
        or _ends_question(sentences[j].get("text", ""))
    ):
        j -= 1
    if j < a:
        return None

    # A clip that opens on a dependent sentence is still incomplete.
    if _opens_dependent(sentences[a].get("text", "")):
        return None
    duration = span(a, j)
    if duration < min_len * 0.6 or duration > max_len:
        return None
    return a, j


def _make_segment(sentences, a, b, av_features=None):
    """Score a transcript window and attach explainable audiovisual signals."""
    win = sentences[a:b + 1]
    words = [w for s in win for w in s["words"]]
    text = " ".join(w["word"] for w in words)
    scores, _ = score_sentence({"start": win[0]["start"], "end": win[-1]["end"],
                                "text": text, "words": words,
                                "complete": _group_complete(win[-1])})
    # Preserve sharp moments inside a longer window. The whole-window average
    # can dilute a standout lyric, punchline, or emotional line; blend it with
    # the strongest sentence-level score rather than treating every second equally.
    sentence_scores = [score_sentence(s)[1] for s in win]
    transcript_average = sum(WEIGHTS[k] * v for k, v in scores.items()) * 10.0
    sentence_peak = max(sentence_scores, default=transcript_average)
    dialogue_dynamics = _dialogue_dynamics(win)
    creator_value = 10.0 * _creator_value_score(text)
    # Balance standalone transcript quality with conversational dynamics and
    # creator-friendly value. This helps useful explanations and personal
    # stories compete without depending on canned "viral" phrases.
    transcript_score = (0.42 * transcript_average +
                        0.18 * sentence_peak +
                        0.22 * dialogue_dynamics +
                        0.18 * creator_value)
    result = {
        "start": round(win[0]["start"], 2),
        "end": round(win[-1]["end"], 2),
        "hook": make_hook(win[0]["text"]),
        "overall": round(transcript_score, 1),
        "signals": {"transcript": round(transcript_score, 2),
                    "dialogue_dynamics": dialogue_dynamics,
                    "creator_value": round(creator_value, 2)},
    }
    if av_features is not None:
        from av_features import score_interval
        audio, visual, cuts = score_interval(av_features, result["start"], result["end"])
        # Transcript quality is the baseline. Audio and visual activity are
        # optional positive evidence, never penalties: talking-head creators,
        # podcasts and interviews should not lose points for a static camera,
        # clean speech or quiet delivery.
        result["overall"] = round(min(10.0, transcript_score + 0.5 * audio + 0.25 * visual), 1)
        result["signals"].update({"audio_energy": audio, "scene_activity": visual,
                                  "scene_changes": cuts})
        reasons = []
        if audio >= 0.55:
            reasons.append("elevated audio energy")
        if visual >= 0.35:
            reasons.append("active visual cuts")
        if transcript_score >= 5.0:
            reasons.append("strong transcript cues")
        if dialogue_dynamics >= 6.5:
            reasons.append("sustained dramatic dialogue")
        result["selection_reasons"] = reasons or ["balanced transcript/audio/visual signals"]
    return result


def build_candidates(sentences, min_len, max_len, max_clips, av_features=None, pool_size=None):
    """Seed windows at the highest-scoring sentences, grow to min_len, dedup, sort.
    Windows always end on a complete sentence (complete-thought rule)."""
    scored = {i: score_sentence(s)[1] for i, s in enumerate(sentences)}
    ranked_seeds = sorted(range(len(sentences)), key=lambda i: scored[i], reverse=True)
    # Keep strong dialogue seeds, but also sample the full timeline so quiet
    # lyrics or visually driven sequences can enter the AV shortlist.
    # Build a real alternative pool before applying the quality/spacing gates.
    # A shortlist capped at max_clips can leave only one result after scoring,
    # even when other strong moments exist elsewhere in a long recording.
    requested_pool = max_clips if pool_size is None else max(max_clips, int(pool_size))
    pool_limit = min(len(sentences), requested_pool)
    # Reserve broad timeline coverage before spending the pool on high-scoring
    # seeds. Otherwise many similar early sentences can fill the shortlist
    # before later sections are ever examined.
    temporal_count = min(
        len(sentences),
        max(1, min(pool_limit, max(20, max_clips * 4))),
    )
    temporal_seeds = sorted({round(i * (len(sentences) - 1) / max(1, temporal_count - 1))
                             for i in range(temporal_count)})
    priority_seeds = ranked_seeds[:pool_limit]
    # Process evenly spaced seeds first; use score-led seeds only to fill the
    # remaining capacity. Final ranking still happens after every candidate
    # has been scored, so coverage does not dictate which clips are selected.
    order = list(dict.fromkeys(temporal_seeds + priority_seeds))
    # Build overlapping alternatives: greedy "taken" suppression previously
    # removed nearby candidate moments before audiovisual ranking could compare
    # them. Deduplicate near-identical windows only, then let the caller rank
    # and enforce spacing across the final selections.
    accepted = []
    seen = set()
    taken = [False] * len(sentences)  # window growth itself remains unconstrained
    for seed in order:
        if len(accepted) >= pool_limit:
            break
        w = _grow_window(sentences, seed, taken, min_len, max_len, av_features)
        if w is None:
            continue
        a, b = w
        duration = float(sentences[b]["end"]) - float(sentences[a]["start"])
        # Production-length clips must meet the requested minimum exactly;
        # retain the historical short-fixture tolerance for unit tests/tools.
        if min_len >= 30 and duration < min_len:
            continue
        key = (round(sentences[a]["start"], 1), round(sentences[b]["end"], 1))
        if key in seen:
            continue
        seen.add(key)
        accepted.append(_make_segment(sentences, a, b, av_features))
    accepted.sort(key=lambda s: s["start"])
    return accepted


# ----------------------------------------------------------------- search/pick

def search_hits(sentences, query):
    """Indexes of sentences containing ALL whitespace-separated query tokens
    (case-insensitive). Empty-token queries match nothing."""
    tokens = [_norm_token(t) for t in (query or "").split()]
    tokens = [t for t in tokens if t]
    if not tokens:
        return []
    hits = []
    for i, s in enumerate(sentences):
        low = " " + s["text"].lower() + " "
        if all(t in low for t in tokens):
            hits.append(i)
    return hits


def search_candidates(sentences, query, min_len, max_len, max_clips):
    """Build scored clips around every sentence matching `query` (keyword search
    over the transcript - the feature users call a dealbreaker when missing)."""
    taken = [False] * len(sentences)
    accepted = []
    for seed in search_hits(sentences, query):
        if taken[seed] or len(accepted) >= max_clips:
            continue
        w = _grow_window(sentences, seed, taken, min_len, max_len)
        if w is None:
            continue
        a, b = w
        accepted.append(_make_segment(sentences, a, b))
        for k in range(a, b + 1):
            taken[k] = True
    accepted.sort(key=lambda s: s["start"])
    return accepted


def pick_segments(segments, spec):
    """Keep only the given 1-based indexes ('1,3,5') of the start-sorted list -
    the review workflow: look at the printed table, render just the winners."""
    if not spec:
        return segments
    want = set()
    for tok in spec.replace(" ", "").split(","):
        if not tok:
            continue
        if not tok.isdigit():
            raise SystemExit(f"--clips: '{tok}' is not a number (use e.g. --clips 1,3,5)")
        want.add(int(tok))
    n = len(segments)
    bad = sorted(i for i in want if i < 1 or i > n)
    if bad:
        raise SystemExit(
            f"--clips: index(es) {bad} out of range 1..{n} "
            f"(see the numbered table above)")
    return [s for i, s in enumerate(segments, 1) if i in want]


def print_table(segments):
    """Numbered candidate table - pairs with --clips for the review workflow."""
    print("\n  #    start ->      end  score  transcript  audio  visual  cuts  hook", flush=True)
    for i, s in enumerate(segments, 1):
        signals = s.get("signals", {})
        print(f"  {i:>2}  {s['start']:8.2f} -> {s['end']:8.2f}  {s['overall']:4.1f}/10"
              f"  {signals.get('transcript', 0):>10.2f}"
              f"  {signals.get('audio_energy', 0):.2f}"
              f"  {signals.get('scene_activity', 0):.2f}"
              f"  {signals.get('scene_changes', 0):>4}  {s['hook']}", flush=True)
        if s.get("selection_reasons"):
            print("      Why: " + ", ".join(s["selection_reasons"]), flush=True)
    print("  render a subset with --clips 1,3,5", flush=True)


def print_candidate_diagnostics(candidates, selected, min_score, separation, limit=8):
    """Always explain the leading candidates, including gate and spacing rejects."""
    selected_ids = {(s["start"], s["end"]) for s in selected}
    print("\nCandidate diagnostics (highest-ranked alternatives):", flush=True)
    for candidate in sorted(candidates, key=lambda s: s["overall"], reverse=True)[:limit]:
        signals = candidate.get("signals", {})
        identity = (candidate["start"], candidate["end"])
        if identity in selected_ids:
            status = "SELECTED"
        elif candidate["overall"] < min_score:
            status = f"REJECTED: below score gate {min_score:.1f}"
        elif any(not (candidate["end"] <= item["start"] - separation or
                      candidate["start"] >= item["end"] + separation)
                 for item in selected):
            status = "REJECTED: overlaps/is too close to a stronger selection"
        else:
            status = "NOT SELECTED: max-clips limit"
        print(f"  {candidate['start']:.1f}-{candidate['end']:.1f}s "
              f"{candidate['overall']:.1f}/10 | transcript "
              f"{signals.get('transcript', 0):.2f} | audio "
              f"{signals.get('audio_energy', 0):.2f} | visual "
              f"{signals.get('scene_activity', 0):.2f} | {status} | "
              f"{candidate.get('hook', 'clip')}", flush=True)

# ------------------------------------------------------------------- ollama

AI_ANSWER_OPENERS = {"yes", "yeah", "yep", "no", "nope", "well", "actually", "because"}
AI_DISCOVERY_POOL_SIZE = 48
AI_REVIEW_POOL_SIZE = 12
AI_REVIEW_MIN_SEPARATION = 10.0
AI_REVIEW_SYSTEM = """You are an experienced short-form video editor making the final editorial selection.

Compare only the supplied candidate moments. Each candidate is already a complete, bounded clip with a natural start and ending. Its timestamp boundaries are fixed: never invent, adjust, combine, or split candidates.

Choose the strongest self-contained stories, surprising revelations, useful explanations, strong opinions, disagreements, emotional turns, funny exchanges, or practical lessons. Follow the actual setup, cause and effect, callbacks, and payoff in the transcript. A moment does not need a viral catchphrase to be compelling.

Prefer distinct moments from different parts of the recording. Reject introductions, housekeeping, repeated points, generic conversation, and moments that lack a clear payoff. Do not choose a candidate merely because its rule-based score is high.

Only select moments whose standalone editorial value is at least {min_score}/10. Return fewer than {max_clips} when the remaining candidates are weak. Do not invent facts or words.

Return valid JSON only, with this exact shape:
{{"selected":[{{"id":"C2","overall":8.2,"hook":"A concise natural title","reason":"Why this complete moment is valuable"}}]}}
Use only the candidate IDs supplied. Return at most {max_clips} selections. No Markdown and no text outside the JSON object."""

class OllamaHTTPError(RuntimeError):
    """An Ollama HTTP response with its short, safe-to-log error body."""

    def __init__(self, status, body):
        self.status = int(status)
        self.body = re.sub(r"\s+", " ", str(body or "")).strip()[:800]
        detail = self.body or "empty response body"
        super().__init__(f"Ollama HTTP {self.status}: {detail}")


def _is_ollama_context_error(error):
    """Identify request-size/context failures that can be retried with smaller chunks."""
    if not isinstance(error, OllamaHTTPError) or error.status != 400:
        return False
    detail = error.body.lower()
    return any(marker in detail for marker in (
        "context length", "context window", "input length",
        "too many tokens", "prompt is too long", "exceeds the available context",
    ))


def _parse_ollama_json(content):
    """Decode a JSON object/array even if a model adds harmless surrounding text."""
    cleaned = re.sub(r"<think>.*?</think>", "", str(content or ""), flags=re.S).strip()
    decoder = json.JSONDecoder()
    for index, char in enumerate(cleaned):
        if char not in "{[":
            continue
        try:
            value, _ = decoder.raw_decode(cleaned[index:])
            if isinstance(value, list):
                return {"clips": value}
            if isinstance(value, dict):
                return value
        except json.JSONDecodeError:
            continue
    raise ValueError("Ollama returned no valid JSON object or array")


def _normalize_ai_window(sentences, start_index, end_index, min_len, max_len):
    """Validate model-selected sentence boundaries without heuristic window growth.

    The language model chooses the moment. This function only repairs a nearby
    dependent opener/answer and enforces complete, bounded render boundaries.
    """
    if (isinstance(start_index, bool) or isinstance(end_index, bool)
            or not isinstance(start_index, int) or not isinstance(end_index, int)
            or start_index < 0 or end_index < start_index or end_index >= len(sentences)):
        return None

    a, b = start_index, end_index
    # Bring in the question/setup when the model starts on an answer or dependent clause.
    for _ in range(MAX_CONTEXT_GROUPS):
        first_text = sentences[a].get("text", "")
        first = _first_word(first_text)
        needs_previous = _opens_dependent(first_text) or not _group_complete(sentences[a])
        if a > 0 and _ends_question(sentences[a - 1].get("text", "")):
            needs_previous = needs_previous or first in (AI_ANSWER_OPENERS | {"i", "we", "it", "they"})
        if not needs_previous:
            break
        if a == 0:
            return None
        previous = sentences[a - 1]
        if (_group_gap(previous, sentences[a]) > MAX_ANSWER_GAP
                or _is_natural_break(previous, sentences[a])):
            return None
        a -= 1

    if _opens_dependent(sentences[a].get("text", "")) or not _group_complete(sentences[a]):
        return None

    # A complete ending must include the answer/continuation if the selected
    # last row is a question or an unfinished ASR clause.
    for _ in range(4):
        tail = sentences[b].get("text", "")
        incomplete = (not _group_complete(sentences[b])
                      or _ends_dangling(tail) or _ends_question(tail))
        if not incomplete:
            break
        if b + 1 >= len(sentences):
            return None
        following = sentences[b + 1]
        gap = _group_gap(sentences[b], following)
        allowed_gap = MAX_ANSWER_GAP if _ends_question(tail) else MAX_CONTINUATION_GAP
        if gap > allowed_gap or _is_natural_break(sentences[b], following):
            return None
        if float(following["end"]) - float(sentences[a]["start"]) > max_len:
            return None
        b += 1
    tail = sentences[b].get("text", "")
    if (not _group_complete(sentences[b]) or _ends_dangling(tail)
            or _ends_question(tail)):
        return None

    start = float(sentences[a]["start"])
    end = float(sentences[b]["end"])
    duration = end - start
    if duration < min_len or duration > max_len:
        return None
    return a, b


def _candidate_overlaps(candidate, chosen, separation=AI_REVIEW_MIN_SEPARATION):
    """Return True when a candidate repeats or overlaps an already shortlisted moment."""
    return any(
        not (float(candidate["end"]) <= float(item["start"]) - separation
             or float(candidate["start"]) >= float(item["end"]) + separation)
        for item in chosen
    )


def _balanced_ai_review_pool(candidates, duration, limit):
    """Keep the strongest non-overlapping candidates while covering the full timeline.

    Discovery is deliberately broad and inexpensive. This second local pass
    reduces the text sent to the CPU-only language model without allowing one
    high-scoring part of a long recording to crowd out the rest.
    """
    if not candidates or limit <= 0:
        return []

    ranked = sorted(
        candidates,
        key=lambda item: float(item.get("overall", 0)),
        reverse=True,
    )
    source_duration = max(
        1.0,
        float(duration or 0),
        max(float(item["end"]) for item in ranked),
    )
    bucket_count = min(4, max(1, limit))
    buckets = [[] for _ in range(bucket_count)]
    for candidate in ranked:
        midpoint = (float(candidate["start"]) + float(candidate["end"])) / 2.0
        bucket = min(
            bucket_count - 1,
            max(0, int(midpoint / source_duration * bucket_count)),
        )
        buckets[bucket].append(candidate)

    for bucket in buckets:
        bucket.sort(key=lambda item: float(item.get("overall", 0)), reverse=True)

    chosen = []
    seen = set()
    # Round-robin the timeline buckets so every part of the recording gets a
    # chance before a second alternative from any one part is considered.
    depth = 0
    while len(chosen) < limit and any(depth < len(bucket) for bucket in buckets):
        for bucket in buckets:
            if len(chosen) >= limit:
                break
            if depth >= len(bucket):
                continue
            candidate = bucket[depth]
            identity = (round(float(candidate["start"]), 1),
                        round(float(candidate["end"]), 1))
            if identity not in seen and not _candidate_overlaps(candidate, chosen):
                chosen.append(candidate)
                seen.add(identity)
        depth += 1

    # If empty timeline buckets or overlaps left room, fill by score while
    # retaining the same duplicate/spacing protection.
    for candidate in ranked:
        if len(chosen) >= limit:
            break
        identity = (round(float(candidate["start"]), 1),
                    round(float(candidate["end"]), 1))
        if identity in seen or _candidate_overlaps(candidate, chosen):
            continue
        chosen.append(candidate)
        seen.add(identity)

    return sorted(chosen, key=lambda item: float(item["start"]))


def _candidate_transcript(sentences, candidate):
    """Return all sentence text inside a prevalidated candidate's boundaries."""
    start = float(candidate["start"]) - 0.05
    end = float(candidate["end"]) + 0.05
    return " ".join(
        str(group.get("text", "")).strip()
        for group in sentences
        if float(group["start"]) >= start and float(group["end"]) <= end
    ).strip()


def ollama_select(data, model, host, min_score, max_clips, min_len, max_len, timeout=1800):
    """Use one global AI editorial pass over a broad, timeline-balanced shortlist.

    Candidate discovery is deterministic and local. The language model compares
    complete 60-180 second candidate moments rather than repeatedly reading the
    entire transcript in many overlapping requests. Candidate timestamps are
    fixed before the AI pass, and the AI still decides which moments are strong
    enough to publish.
    """
    sentences = sentenceize(data["words"], segments=data.get("segments"))
    if not sentences:
        return None

    discovery_limit = max(AI_DISCOVERY_POOL_SIZE, min(72, max_clips * 16))
    review_limit = min(16, max(8, max_clips * 4))
    # build_candidates samples four timeline positions per discovery slot.
    # Use at least 12 slots so the 48-window discovery pool spans the full
    # recording before rule-based ranking chooses the AI review shortlist.
    discovery_seed_slots = max(12, max_clips)
    candidates = build_candidates(
        sentences,
        min_len,
        max_len,
        discovery_seed_slots,
        pool_size=discovery_limit,
    )
    print(
        f"AI candidate discovery: {len(candidates)} complete windows from "
        f"{len(sentences)} sentence groups across "
        f"{float(data.get('duration') or 0):.1f}s.",
        flush=True,
    )
    if not candidates:
        print("AI selector: no complete candidate windows met the duration/context rules.", flush=True)
        return []

    review_pool = _balanced_ai_review_pool(
        candidates, data.get("duration"), review_limit
    )
    if not review_pool:
        return []

    def call(messages, num_predict):
        payload = {
            "model": model,
            "stream": False,
            "format": "json",
            "keep_alive": "10m",
            "options": {
                "temperature": 0.15,
                "num_ctx": 8192,
                "num_predict": num_predict,
            },
            "messages": messages,
        }
        req = urllib.request.Request(
            host.rstrip("/") + "/api/chat",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as response:
                result = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            # Ollama's useful explanation is in the HTTP response body; urllib's
            # default exception string hides it. Never log the request transcript.
            detail = error.read(2048).decode("utf-8", errors="replace")
            raise OllamaHTTPError(error.code, detail) from error
        if result.get("error"):
            raise RuntimeError(str(result["error"]))
        return _parse_ollama_json(result.get("message", {}).get("content", ""))

    review = None
    try:
        while review_pool:
            review_rows = []
            for index, candidate in enumerate(review_pool, 1):
                candidate_id = f"C{index}"
                excerpt = _candidate_transcript(sentences, candidate)
                review_rows.append(
                    f"{candidate_id} | {float(candidate['start']):.1f}-"
                    f"{float(candidate['end']):.1f}s | "
                    f"{float(candidate['end']) - float(candidate['start']):.1f}s | "
                    f"local support={float(candidate.get('overall', 0)):.1f}/10\n"
                    f"TRANSCRIPT: {excerpt}"
                )

            review_prompt = (
                f"Full source duration: {float(data.get('duration') or 0):.1f} seconds.\n"
                f"Required clip duration: {min_len}-{max_len} seconds.\n"
                f"Minimum blended quality threshold: {min_score:.1f}/10.\n"
                f"Choose up to {max_clips} distinct candidates from the {len(review_pool)} below. "
                "Each transcript is the complete text inside its fixed candidate boundaries. "
                "Judge the actual setup, development and payoff; do not reward a candidate "
                "for a dramatic opening if the rest does not deliver.\n\n"
                + "\n\n".join(review_rows)
            )
            print(
                f"AI editorial comparison: reviewing {len(review_pool)} "
                f"timeline-spread candidate(s) in one request.",
                flush=True,
            )
            try:
                review = call([
                    {"role": "system", "content": AI_REVIEW_SYSTEM.format(
                        min_score=min_score, max_clips=max_clips)},
                    {"role": "user", "content": review_prompt},
                ], num_predict=max(256, min(384, max_clips * 128)))
                break
            except OllamaHTTPError as error:
                # A very talk-heavy source can still exceed the model's context.
                # Retry with fewer whole candidates, never chopped transcript text.
                if _is_ollama_context_error(error) and len(review_pool) > 4:
                    smaller_limit = max(4, len(review_pool) // 2)
                    smaller_pool = _balanced_ai_review_pool(
                        candidates, data.get("duration"), smaller_limit
                    )
                    if len(smaller_pool) < len(review_pool):
                        print(
                            f"  Ollama context limit; reducing the editorial shortlist "
                            f"from {len(review_pool)} to {len(smaller_pool)} whole candidates.",
                            flush=True,
                        )
                        review_pool = smaller_pool
                        continue
                raise
    except Exception as error:  # noqa: BLE001
        print(f"  Ollama AI selection failed ({error}); heuristic fallback is available.", flush=True)
        return None
    try:
        selected_items = review.get("selected", []) if isinstance(review, dict) else None
        if not isinstance(selected_items, list):
            raise ValueError("Ollama 'selected' field was not a list")
        if len(selected_items) > max_clips:
            selected_items = selected_items[:max_clips]

        selected_pool = []
        used_ids = set()
        # Recreate the ID map for the final request size. Candidate IDs always
        # refer to the exact fixed windows sent in that request.
        by_id = {}
        for index, candidate in enumerate(review_pool, 1):
            by_id[f"C{index}"] = candidate

        for item in selected_items:
            if not isinstance(item, dict):
                continue
            candidate_id = item.get("id") or item.get("candidate_id")
            if not isinstance(candidate_id, str) or candidate_id not in by_id:
                continue
            if candidate_id in used_ids:
                continue
            used_ids.add(candidate_id)
            candidate = by_id[candidate_id]
            try:
                model_score = float(item.get("overall", item.get("score", 0)))
            except (TypeError, ValueError):
                continue
            if not 0.0 <= model_score <= 10.0:
                continue

            segment = dict(candidate)
            segment["signals"] = dict(candidate.get("signals") or {})
            local_score = float(candidate.get("overall", 0))
            segment["overall"] = round(0.82 * model_score + 0.18 * local_score, 1)
            segment["hook"] = make_hook(
                str(item.get("hook") or candidate.get("hook") or "clip"), 8
            )
            reason = str(
                item.get("reason") or "Selected by contextual AI editorial review"
            ).strip()
            segment["selection_reasons"] = [
                ("AI editorial assessment: " + reason)[:240]
            ]
            segment["signals"]["ai_score"] = round(model_score, 2)
            segment["signals"]["rule_based_support"] = round(local_score, 2)
            if segment["overall"] >= min_score:
                selected_pool.append(segment)
    except Exception as error:  # noqa: BLE001
        print(f"  Ollama AI selection failed ({error}); heuristic fallback is available.", flush=True)
        return None

    # The AI ranks a fixed shortlist globally. Keep its strongest distinct
    # choices and preserve the existing no-overlap spacing before rendering.
    selected_pool.sort(key=lambda item: item["overall"], reverse=True)
    selected = []
    for candidate in selected_pool:
        if _candidate_overlaps(candidate, selected):
            continue
        selected.append(candidate)
        if len(selected) >= max_clips:
            break
    selected.sort(key=lambda item: item["start"])
    print(
        f"AI quality gate: selected {len(selected)}/{max_clips} clip(s) "
        f"at or above {min_score:.1f}/10 from {len(review_pool)} reviewed candidates.",
        flush=True,
    )
    return selected

def _nearest(values, t):
    lo, hi = 0, len(values) - 1
    best = 0
    best_d = float("inf")
    while lo <= hi:
        mid = (lo + hi) // 2
        d = abs(values[mid] - t)
        if d < best_d:
            best_d, best = d, mid
        if values[mid] < t:
            lo = mid + 1
        else:
            hi = mid - 1
    return best

# ----------------------------------------------------------------- run / cli

def run(workdir, llm=None, host=OLLAMA_HOST, min_score=None, max_clips=10,
        min_len=60, max_len=180, search=None, pick=None, semantic=None,
        embed_model="nomic-embed-text", video_path=None, strict_llm=False):
    """Score the transcript in workdir and write workdir/segments.json.

    Returns (segments, mode): 'ollama', 'heuristic', or 'semantic'.
    search='keywords' overrides scoring with keyword-search clip finding;
    pick='1,3,5' keeps only the numbered candidates (review workflow).
    """
    workdir = Path(workdir)
    data = load_transcript(workdir)
    sentences = sentenceize(data["words"], segments=data.get("segments"))
    diagnostics = print_transcript_diagnostics(data, len(sentences))
    if not sentences:
        raise SystemExit("No clip candidates: ASR returned no word timestamps. "
                         "The source may be silent/sparse or transcription may have failed.")

    mode = "heuristic"
    segments = None
    if semantic:
        from semantic import candidates
        segments = candidates(sentences, semantic, embed_model, workdir, min_len, max_len, max_clips)
        mode = "semantic"
        if not segments:
            raise ValueError("No complete clip windows found for semantic search.")
    elif search:
        segments = search_candidates(sentences, search, min_len, max_len, max_clips)
        if not segments:
            raise SystemExit(
                f"--search '{search}': no transcript sentence matched. "
                "Try fewer or different keywords.")
        print(f"Keyword search '{search}': {len(segments)} match(es)", flush=True)
    elif llm:
        ms = min_score if min_score is not None else 8.0
        segments = ollama_select(data, llm, host, ms, max_clips, min_len, max_len)
        if segments is not None:
            mode = "ollama"
        elif strict_llm:
            raise SystemExit(
                "Required AI clip selector is unavailable or returned invalid output; "
                "refusing to silently fall back to keyword/rule-based selection."
            )
    if segments is None:
        ms = min_score if min_score is not None else 6.5
        av_features = None
        if video_path:
            from av_features import extract_features
            print("Extracting audio-energy and sampled scene-change signals...", flush=True)
            av_features = extract_features(video_path)
            print(f"AV analysis: {len(av_features['audio'])} audio windows, "
                  f"{len(av_features['scene_changes'])} sampled visual changes.", flush=True)
        # Generate a wider shortlist before multimodal ranking so a music
        # passage is not excluded merely because its lyrics score weakly.
        candidates = build_candidates(sentences, min_len, max_len,
                                      max_clips, av_features,
                                      pool_size=max(max_clips * 8, max_clips))
        print(f"Candidate windows: {len(candidates)} complete windows from "
              f"{len(sentences)} sentence groups.", flush=True)
        ranked_all = sorted(candidates, key=lambda s: s["overall"], reverse=True)
        ranked = [s for s in ranked_all if s["overall"] >= ms]
        # Avoid returning three neighbouring snippets from one sequence when
        # strong alternatives exist elsewhere in the source.
        qualifying = []
        separation = max(30.0, max_len * 1.5)
        for candidate in ranked:
            if all(candidate["end"] <= chosen["start"] - separation or
                   candidate["start"] >= chosen["end"] + separation
                   for chosen in qualifying):
                qualifying.append(candidate)
            if len(qualifying) >= max_clips:
                break
        segments = sorted(qualifying, key=lambda s: s["start"])
        print_candidate_diagnostics(ranked_all, segments, ms, separation)
        print(f"Quality gate: {len(segments)}/{max_clips} candidates met "
              f"the minimum score of {ms:.1f}/10; no below-threshold fillers.", flush=True)

    segments = pick_segments(segments, pick)
    if not segments:
        if pick:
            raise SystemExit("Nothing to render: --clips removed every candidate.")
        if 'candidates' in locals() and not candidates:
            cause = "incomplete/short clip windows or no connected speech groups"
        elif 'ranked_all' in locals() and ranked_all:
            cause = f"candidates failed the {ms:.1f}/10 quality gate or spacing requirement"
        elif diagnostics["poor_quality"] or diagnostics["script_mismatch"]:
            cause = "ASR transcript quality or language/script mismatch"
        elif len(data["words"]) < 20:
            cause = "insufficient detected speech (sparse source or missed ASR speech)"
        else:
            cause = "no complete clip windows were available"
        raise SystemExit(f"No usable clips: {cause}; inspect the compact diagnostics above.")

    print_table(segments)
    out = workdir / "segments.json"
    out.write_text(json.dumps(segments, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Wrote {out}  (mode={mode}, {len(segments)} clips)", flush=True)
    return segments, mode


def main():
    ap = argparse.ArgumentParser(description="Score a chopify transcript for virality.")
    ap.add_argument("workdir", nargs="?", default="work")
    ap.add_argument("--llm", nargs="?", const="qwen2.5:7b", default=None, metavar="MODEL",
                    help="score with a local Ollama model (e.g. qwen2.5:7b, llama3.1:8b)")
    ap.add_argument("--host", default=OLLAMA_HOST,
                    help="Ollama host (default http://localhost:11434)")
    ap.add_argument("--strict-llm", action="store_true",
                    help="fail instead of silently falling back when the requested AI model is unavailable")
    ap.add_argument("--min-score", type=float, default=None,
                    help="keep clips at/above this score (default 6.5 heuristic, 8.0 llm)")
    ap.add_argument("--max-clips", type=int, default=10)
    ap.add_argument("--min-len", type=int, default=60, help="minimum context-first clip duration in seconds")
    ap.add_argument("--max-len", type=int, default=180, help="maximum clip duration in seconds; extend to a complete thought within this limit")
    ap.add_argument("--search", default=None, metavar="KEYWORDS",
                    help="skip virality scoring: build clips around transcript "
                         "sentences containing ALL keywords (e.g. --search \"pricing\")")
    ap.add_argument("--clips", default=None, metavar="1,3,5",
                    help="render only these numbered candidates from the table "
                         "(review workflow)")
    ap.add_argument("--semantic", help="search by meaning using local Ollama embeddings")
    ap.add_argument("--embed-model", default="nomic-embed-text")
    args = ap.parse_args()
    run(args.workdir, args.llm, args.host, args.min_score, args.max_clips,
        args.min_len, args.max_len, search=args.search, pick=args.clips,
        semantic=args.semantic, embed_model=args.embed_model, strict_llm=args.strict_llm)
    print("SCORING COMPLETE", flush=True)


LLM_SYSTEM = (
    "You are a short-form video editor. You receive a timestamped transcript. "
    "Select the moments most likely to go viral as self-contained clips. Rules:\n"
    "- Each clip MUST be a complete thought: hook, build, payoff. Never end mid-sentence.\n"
    "- Aim for a complete, self-contained moment, not an arbitrary short duration.\n"
    "- Clip length must be between {min_len} and {max_len} seconds. Use the time needed to include the full setup, explanation, and payoff; a strong moment may run 1-3 minutes.\n"
    "- Never shorten a coherent story or explanation just to make the clip shorter. Stop at its natural ending, and do not pad after the point is complete.\n"
    "- Return AT MOST {max_clips} clips, taken from DIFFERENT parts of the video.\n"
    "- Rate each clip 0-10 on hook, shock, humour, controversy, insight, emotion, "
    "energy and complete arc; put the mean in 'overall'.\n"
    "- Only include clips with overall >= {min_score}.\n"
    'Respond with JSON only, an array: [{{"start": <sec>, "end": <sec>, '
    '"hook": "<3-7 word title>", "overall": <0-10>}}]'
)

if __name__ == "__main__":
    main()
