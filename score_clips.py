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


def sentenceize(words, gap=1.2, segments=None, max_group_duration=18.0):
    """Group words using punctuation, pauses and Whisper chunk boundaries.

    Whisper boundaries are soft complete-thought hints, not fixed-length clip
    cuts. Long punctuation-free chunks are capped so they cannot swallow a
    whole recording; those emergency splits remain marked incomplete.
    """
    if not words:
        return []
    segments = segments or []
    bounds = [(float(s["start"]), float(s["end"])) for s in segments
              if isinstance(s, dict) and "start" in s and "end" in s]
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
                   word["start"] >= bounds[segment_pointer][1] - 0.05):
                segment_pointer += 1
            seg_index = segment_pointer
        if cur:
            pause = word["start"] - cur[-1]["end"] > gap
            new_segment = seg_index is not None and current_segment is not None and seg_index != current_segment
            at_limit = word["end"] - cur[0]["start"] > max_group_duration
            if pause:
                flush(True, "pause")
            elif new_segment:
                flush(True, "whisper_segment")
            elif at_limit:
                flush(False, "duration_limit")
        cur.append(word)
        current_segment = seg_index
        if is_arc_complete(word["word"]):
            flush(True, "punctuation")
            current_segment = seg_index
    flush(False, "end_of_transcript")
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
    if letters and len(scripts) > 1:
        print("ASR script mix: " + ", ".join(f"{k}={v / letters:.0%}" for k, v in
              sorted(scripts.items(), key=lambda item: item[1], reverse=True)), flush=True)
    if data.get("expected_language") and language != data["expected_language"]:
        print(f"ASR language warning: requested {data['expected_language']} but detected {language}.", flush=True)
    dominant_script = max(scripts, key=scripts.get) if scripts else None
    if language in _LATIN_LANGUAGES and dominant_script and dominant_script != "LATIN":
        print(f"ASR language/script warning: {language} speech is usually written in Latin script, "
              f"but transcript text is mostly {dominant_script}; transcription may be unreliable.", flush=True)
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
            "script_mismatch": bool(language in _LATIN_LANGUAGES and dominant_script and dominant_script != "LATIN")}


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


def _grow_window(sentences, seed, taken, min_len, max_len, av_features=None):
    """Grow a window from `seed` to >= min_len seconds, then extend or trim it so
    it always ends on a complete sentence (the #1 complaint about AI clippers is
    clips that start or end mid-thought). Returns (seed, end_idx) or None."""
    n = len(sentences)

    # If the seed is an emergency duration split inside a thought, start at
    # the preceding group boundary so a candidate does not open mid-sentence.
    while seed > 0 and not _group_complete(sentences[seed - 1]):
        seed -= 1

    def span(a, b):
        return sentences[b]["end"] - sentences[a]["start"]

    j = seed
    while span(seed, j) < min_len and j + 1 < n and not taken[j + 1]:
        if _is_natural_break(sentences[j], sentences[j + 1], av_features):
            break
        j += 1
    while span(seed, j) > max_len and j > seed:
        j -= 1
    if span(seed, j) < min_len * 0.6:
        return None
    # Keep growing until the final group has a reliable boundary marker.
    while not _group_complete(sentences[j]) and j + 1 < n \
            and not taken[j + 1] and span(seed, j + 1) <= max_len:
        if _is_natural_break(sentences[j], sentences[j + 1], av_features):
            break
        j += 1
    # still incomplete -> back off to the last complete sentence in the window
    while j > seed and not _group_complete(sentences[j]):
        j -= 1
    if not _group_complete(sentences[j]):
        return None
    if span(seed, j) < min_len * 0.6:
        return None
    return seed, j


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


def build_candidates(sentences, min_len, max_len, max_clips, av_features=None):
    """Seed windows at the highest-scoring sentences, grow to min_len, dedup, sort.
    Windows always end on a complete sentence (complete-thought rule)."""
    scored = {i: score_sentence(s)[1] for i, s in enumerate(sentences)}
    ranked_seeds = sorted(range(len(sentences)), key=lambda i: scored[i], reverse=True)
    # Keep strong dialogue seeds, but also sample the full timeline so quiet
    # lyrics or visually driven sequences can enter the AV shortlist.
    temporal_count = min(len(sentences), max(1, max_clips * 2))
    temporal_seeds = sorted({round(i * (len(sentences) - 1) / max(1, temporal_count - 1))
                             for i in range(temporal_count)})
    priority_seeds = ranked_seeds[:max(1, max_clips * 2)]
    # Interleave score-led and evenly-spaced seeds, so a shortlist capped by
    # max_clips still includes candidate windows from later parts of the video.
    order = []
    for i in range(max(len(priority_seeds), len(temporal_seeds))):
        if i < len(priority_seeds):
            order.append(priority_seeds[i])
        if i < len(temporal_seeds):
            order.append(temporal_seeds[i])
    order = list(dict.fromkeys(order))
    # Build overlapping alternatives: greedy "taken" suppression previously
    # removed nearby candidate moments before audiovisual ranking could compare
    # them. Deduplicate near-identical windows only, then let the caller rank
    # and enforce spacing across the final selections.
    accepted = []
    seen = set()
    taken = [False] * len(sentences)  # window growth itself remains unconstrained
    for seed in order:
        if len(accepted) >= max_clips:
            break
        w = _grow_window(sentences, seed, taken, min_len, max_len, av_features)
        if w is None:
            continue
        a, b = w
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

def ollama_select(data, model, host, min_score, max_clips, min_len, max_len, timeout=1800):
    """Ask local Ollama for clips. Returns list of dicts, or None on any failure."""
    sentences = sentenceize(data["words"], segments=data.get("segments"))
    if not sentences:
        return None

    def call(batch):
        lines = "\n".join(f"{s['start']:.1f}-{s['end']:.1f}: {s['text']}" for s in batch)
        sys_msg = LLM_SYSTEM.format(min_len=min_len, max_len=max_len,
                                    max_clips=max_clips, min_score=min_score)
        payload = {
            "model": model, "stream": False, "format": "json",
            "options": {"temperature": 0.2},
            "messages": [{"role": "system", "content": sys_msg},
                         {"role": "user", "content":
                          f"Video duration: {data['duration']:.0f}s\n\nTranscript:\n{lines}"}],
        }
        req = urllib.request.Request(
            host.rstrip("/") + "/api/chat",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            resp = json.loads(r.read().decode("utf-8"))
        content = resp.get("message", {}).get("content", "")
        m = re.search(r"\[.*\]", content, re.S)
        return json.loads(m.group(0)) if m else []

    try:
        chunks = [sentences[i:i + 400] for i in range(0, len(sentences), 400)] or [[]]
        raw = []
        for batch in chunks:
            raw.extend(call(batch) or [])
    except Exception as e:                                   # noqa: BLE001
        print(f"  Ollama unavailable ({e}) -> heuristic scoring", flush=True)
        return None

    valid = []
    for it in raw:
        try:
            start, end = float(it["start"]), float(it["end"])
            overall = float(it.get("overall", 0))
            hook = str(it.get("hook") or "clip")
        except (KeyError, TypeError, ValueError):
            continue
        start = max(0.0, min(start, data["duration"] - min_len))
        end = max(start + min_len, min(end, data["duration"]))
        if end - start > max_len + 15:
            end = start + max_len
        valid.append({"start": round(start, 2), "end": round(end, 2),
                      "hook": make_hook(hook, 8), "overall": round(overall, 1)})

    # snap to sentence boundaries (nearest within 3s) so clips never cut mid-word
    starts = [s["start"] for s in sentences]
    ends = [s["end"] for s in sentences]
    for seg in valid:
        si = _nearest(starts, seg["start"])
        ei = _nearest(ends, seg["end"])
        if 2.0 < ends[ei] - starts[si] < max_len + 15:
            seg["start"], seg["end"] = round(starts[si], 2), round(ends[ei], 2)

    valid.sort(key=lambda s: s["start"])
    dedup = []
    for seg in valid:
        if dedup and seg["start"] < dedup[-1]["end"] - 2:
            continue
        dedup.append(seg)
    return dedup[:max_clips]


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
        min_len=20, max_len=75, search=None, pick=None, semantic=None,
        embed_model="nomic-embed-text", video_path=None):
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
                                      max(max_clips * 8, max_clips), av_features)
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
    ap.add_argument("--min-score", type=float, default=None,
                    help="keep clips at/above this score (default 6.5 heuristic, 8.0 llm)")
    ap.add_argument("--max-clips", type=int, default=10)
    ap.add_argument("--min-len", type=int, default=20, help="min clip seconds")
    ap.add_argument("--max-len", type=int, default=75, help="max clip seconds")
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
        semantic=args.semantic, embed_model=args.embed_model)
    print("SCORING COMPLETE", flush=True)


LLM_SYSTEM = (
    "You are a short-form video editor. You receive a timestamped transcript. "
    "Select the moments most likely to go viral as self-contained clips. Rules:\n"
    "- Each clip MUST be a complete thought: hook, build, payoff. Never end mid-sentence.\n"
    "- Clip length between {min_len} and {max_len} seconds.\n"
    "- Return AT MOST {max_clips} clips, taken from DIFFERENT parts of the video.\n"
    "- Rate each clip 0-10 on hook, shock, humour, controversy, insight, emotion, "
    "energy and complete arc; put the mean in 'overall'.\n"
    "- Only include clips with overall >= {min_score}.\n"
    'Respond with JSON only, an array: [{{"start": <sec>, "end": <sec>, '
    '"hook": "<3-7 word title>", "overall": <0-10>}}]'
)

if __name__ == "__main__":
    main()
