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
        match = re.search(r"python - <<'PY'\\n(.*?)\\n\\s*PY\\s*$", step.get("run", ""), re.S)
        if match:
            compile(match.group(1), step["name"], "exec")
            seen += 1
    assert seen >= 5


def test_process_video_uses_worker_download_url():
    step_names = [s["name"] for s in _steps()]
    assert "Download video via Worker presigned URL" in step_names
    # Old boto3 download step should be gone
    assert "Download video from R2" not in step_names


def test_process_video_reads_the_fields_the_worker_actually_returns():
    run = next(s["run"] for s in _steps() if s["name"] == "Get job preferences")
    assert "caption_style" in run  # the jobs table has caption_style, not `style`


def test_completion_status_does_not_depend_on_boolean_string_case():
    step = next(s for s in _steps() if s["name"] == "Report completion to Worker")
    env = step["env"]
    assert "steps.chopify.outcome" in env["CHOPIFY_OUTCOME"]
    assert "== 'True'" not in step["run"]


def test_process_video_no_longer_uses_boto3_for_download():
    for step in _steps():
        run = step.get("run", "")
        # boto3 may be installed as a dependency, but must not be used for download.
        if "download" not in step["name"].lower():
            continue
        assert "boto3" not in run
        assert "R2_ACCESS_KEY_ID" not in run
        assert "R2_SECRET_ACCESS_KEY" not in run
        assert "boto3.client" not in run
        assert "download_file" not in run


def test_process_video_downloads_via_http_streaming():
    step = next(s for s in _steps() if s["name"] == "Download video via Worker presigned URL")
    run = step["run"]
    assert "requests.get" in run
    assert "stream=True" in run
    assert "iter_content" in run
    assert "r.raise_for_status()" in run


def test_process_video_gets_download_url_from_worker():
    step = next(s for s in _steps() if s["name"] == "Download video via Worker presigned URL")
    run = step["run"]
    assert "/api/internal/jobs/" in run
    assert "/download-url" in run
    assert "download_url=" not in run  # URL is internal to the step, not a step output
    # The presigned URL variable must never be passed to print()
    print_calls = re.findall(r'print\\((.*)\\)', run)
    for call in print_calls:
        assert 'download_url' not in call, f"Presigned URL leaked to print(): {call}"


def test_process_video_installs_boto3_for_r2_clip_uploads():
    install_step = next(
        s for s in _steps() if s["name"] == "Install Python dependencies"
    )
    assert re.search(r"\\bpip install\\b[^\\n]*\\bboto3\\b", install_step["run"])

    upload_step = next(s for s in _steps() if s["name"] == "Upload clips to R2")
    assert "import boto3" in upload_step["run"]
    assert "from botocore.config import Config" in upload_step["run"]
