"""Guards for the GitHub Actions workflows the Worker depends on.

Regression: process-video.yml contained Python at column 0 inside `run: |`
blocks, so it was not valid YAML. GitHub never registers a workflow file it
cannot parse, so the Worker's `repository_dispatch` (HTTP 204) started no run.
"""
import re
from pathlib import Path

import pytest
import yaml

WORKFLOWS = Path(__file__).resolve().parent.parent / ".github" / "workflows"


def _load(name):
    return yaml.safe_load((WORKFLOWS / name).read_text(encoding="utf-8"))


def _triggers(doc):
    # PyYAML (YAML 1.1) parses the bare key `on` as boolean True.
    return doc.get("on", doc.get(True))


@pytest.mark.parametrize("path", sorted(WORKFLOWS.glob("*.yml")), ids=lambda p: p.name)
def test_every_workflow_is_valid_yaml(path):
    doc = yaml.safe_load(path.read_text(encoding="utf-8"))
    assert isinstance(doc, dict) and "jobs" in doc


def test_process_video_listens_for_worker_dispatch():
    triggers = _triggers(_load("process-video.yml"))
    assert triggers["repository_dispatch"]["types"] == ["process-video"]


def _steps():
    return _load("process-video.yml")["jobs"]["process"]["steps"]


def test_process_video_never_pipes_stdout_into_github_output():
    # Log lines that are not `key=value` make the runner fail the step.
    for step in _steps():
        assert ">> $GITHUB_OUTPUT" not in step.get("run", ""), step["name"]
        assert '>> "$GITHUB_OUTPUT"' not in step.get("run", ""), step["name"]


def test_process_video_python_steps_compile():
    seen = 0
    for step in _steps():
        match = re.search(r"python - <<'PY'\n(.*?)\n\s*PY\s*$", step.get("run", ""), re.S)
        if match:
            compile(match.group(1), step["name"], "exec")
            seen += 1
    assert seen >= 5


def test_process_video_reads_the_fields_the_worker_actually_returns():
    run = next(s["run"] for s in _steps() if s["name"] == "Get job preferences")
    assert "caption_style" in run  # the jobs table has caption_style, not `style`


def test_completion_status_does_not_depend_on_boolean_string_case():
    step = next(s for s in _steps() if s["name"] == "Report completion to Worker")
    env = step["env"]
    assert "steps.chopify.outcome" in env["CHOPIFY_OUTCOME"]
    assert "== 'True'" not in step["run"]
