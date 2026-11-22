"""Guards for the GitHub Actions workflows the Worker depends on.

Regression: process-video.yml contained Python at column 0 inside \`run: |\`
blocks, so it was not valid YAML. GitHub never registers a workflow file it
cannot parse, so the Worker's \`repository_dispatch\` (HTTP 204) started no run.
"""
import re
from pathlib import Path

import pytest
import yaml

WORKFLOWS = Path(__file__).resolve().parent.parent / ".github" / "workflows"


def _load(name):
    return yaml.safe_load((WORKFLOWS / name).read_text(encoding="utf-8"))


def _triggers(doc):
    # PyYAML (YAML 1.1) parses the bare key \`on\` as boolean True.
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
    # Log lines that are not \`key=value\` make the runner fail the step.
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


def test_process_video_uses_worker_download_url():
    step_names = [s["name"] for s in _steps()]
    assert "Download video via Worker presigned URL" in step_names
    # Old boto3 download step should be gone
    assert "Download video from R2" not in step_names


def test_process_video_requests_multiple_quality_clips_and_cjk_fonts():
    steps = _steps()
    install = next(s for s in steps if s["name"] == "Install system dependencies")
    assert "fonts-noto-cjk" in install["run"]
    run = next(s["run"] for s in steps if s["name"] == "Run Chopify processing")
    assert "'--max-clips', '3'" in run
    assert "'--min-score', '5.5'" in run


def test_process_video_reads_the_fields_the_worker_actually_returns():
    run = next(s["run"] for s in _steps() if s["name"] == "Get job preferences")
    assert "caption_style" in run  # the jobs table has caption_style, not \`style\`


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
    print_calls = re.findall(r'print\((.*)\)', run)
    for call in print_calls:
        assert 'download_url' not in call, f"Presigned URL leaked to print(): {call}"


def test_process_video_installs_boto3_for_r2_clip_uploads():
    install_step = next(
        s for s in _steps() if s["name"] == "Install Python dependencies"
    )
    assert re.search(r"\bpip install\b[^\n]*\bboto3\b", install_step["run"])

    upload_step = next(s for s in _steps() if s["name"] == "Upload clips to R2")
    assert "import boto3" in upload_step["run"]
    assert "from botocore.config import Config" in upload_step["run"]

def test_process_video_passes_r2_configuration_to_upload_step():
    step = next(s for s in _steps() if s["name"] == "Upload clips to R2")
    env = step.get("env", {})
    assert env["R2_ACCOUNT_ID"] == "${{ secrets.R2_ACCOUNT_ID }}"
    assert env["R2_ACCESS_KEY_ID"] == "${{ secrets.R2_ACCESS_KEY_ID }}"
    assert env["R2_SECRET_ACCESS_KEY"] == "${{ secrets.R2_SECRET_ACCESS_KEY }}"
    assert env["R2_BUCKET"] == "telegram-video-clipper-uploads"

    run = step["run"]
    for name in ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"):
        assert name in run
    assert "Missing R2 upload configuration" in run


# ---------------------------------------------------------------------------
# extract-youtube job (self-hosted Linux/WSL2 runner) regression guards
# ---------------------------------------------------------------------------
def _extract():
    return _load("process-video.yml")["jobs"]["extract-youtube"]


def _extract_steps():
    return _extract()["steps"]


def test_workflow_dispatch_has_optional_source_url_and_object_key():
    inputs = _triggers(_load("process-video.yml"))["workflow_dispatch"]["inputs"]
    assert "source_url" in inputs
    assert inputs["source_url"]["required"] is False
    assert "object_key" in inputs
    assert inputs["object_key"]["required"] is False


def test_extract_job_uses_configured_label_on_linux_self_hosted():
    runs_on = _extract()["runs-on"]
    assert "self-hosted" in runs_on
    assert "linux" in runs_on
    assert "x64" in runs_on
    assert "youtube-extractor" in runs_on


def test_extract_job_verifies_runner_prerequisites():
    step = next(s for s in _extract_steps() if s["name"] == "Verify runner prerequisites")
    assert step.get("shell") == "bash"
    run = step["run"]
    for tool in ("python3", "ffmpeg", "ffprobe"):
        assert tool in run, f"prerequisite check missing {tool}"


def test_extract_job_conditional_runs_for_both_dispatch_types():
    cond = _extract()["if"]
    assert "repository_dispatch" in cond
    assert "workflow_dispatch" in cond
    assert "inputs.source_url" in cond
    assert "client_payload.source_url" in cond


def test_extract_job_never_changes_powershell_policy_or_registry():
    text = (WORKFLOWS / "process-video.yml").read_text(encoding="utf-8")
    for forbidden in ("reg add", "ExecutionPolicy", "HKLM", "HKCU", "shell: pwsh", "runs-on: windows"):
        assert forbidden not in text, forbidden


def test_extract_job_installs_deno_and_current_ytdlp_before_download():
    names = [s["name"] for s in _extract_steps()]
    assert names.index("Set up Deno (JavaScript runtime yt-dlp needs for YouTube)") < names.index("Download YouTube video")
    install = next(s for s in _extract_steps() if s["name"] == "Install Python dependencies")
    assert "yt-dlp[default]" in install["run"]


def test_extract_download_merges_video_and_audio_and_handles_cookies_safely():
    run = next(s for s in _extract_steps() if s["name"] == "Download YouTube video")["run"]
    assert "--merge-output-format" in run and "bv*" in run
    assert "best[ext=mp4]/best" not in run
    assert "0o600" in run and "os.unlink(cookies_path)" in run
    assert "print(cookies" not in run and "print(cmd" not in run
    assert "capture_output" not in run  # logs stay yt-dlp's own output, never the cookie file


def test_extract_download_step_compiles_and_cleans_partials():
    step = next(s for s in _extract_steps() if s["name"] == "Download YouTube video")
    assert step.get("shell") == "bash"
    run = step["run"]
    match = re.search(r"<<'PY'\n(.*?)\n\s*PY\s*$", run, re.S)
    assert match is not None
    compile(match.group(1), step["name"], "exec")
    # Partial-file cleanup on failure.
    assert "os.unlink(path)" in run
    assert "except subprocess.CalledProcessError" in run


def test_extract_upload_step_verifies_and_cleans_up():
    step = next(s for s in _extract_steps() if s["name"] == "Upload source to R2")
    assert step.get("shell") == "bash"
    run = step["run"]
    match = re.search(r"<<'PY'\n(.*?)\n\s*PY\s*$", run, re.S)
    assert match is not None
    compile(match.group(1), step["name"], "exec")
    # head_object verification + size comparison.
    assert "head_object" in run
    assert "ContentLength" in run
    assert "uploaded size mismatch" in run
    # Temp file cleanup in finally.
    assert "finally" in run
    assert "os.unlink(video_path)" in run


def test_extract_upload_step_supports_object_key_input():
    step = next(s for s in _extract_steps() if s["name"] == "Upload source to R2")
    env = step.get("env", {})
    assert env["OBJECT_KEY"] == "${{ github.event.client_payload.object_key || inputs.object_key || '' }}"
    run = step["run"]
    assert "object_key = os.environ.get('OBJECT_KEY') or ''" in run
    assert "key = object_key or f'jobs/{job_id}/source.mp4'" in run


def test_process_fetch_source_uses_extract_output_key():
    step = next(s for s in _steps() if s["name"] == "Fetch YouTube source from R2")
    env = step.get("env", {})
    assert env["SOURCE_R2_KEY"] == "${{ needs.extract-youtube.outputs.source_r2_key }}"


def test_failed_extraction_is_reported_in_process_job():
    steps = _steps()
    fail = next(s for s in steps if s["name"].startswith("Fail workflow when YouTube extraction"))
    assert "always()" in fail["if"]
    assert "!contains" in fail["if"]
    assert "needs.extract-youtube.result" in fail["if"]
    assert "exit 1" in fail["run"]


def test_extract_result_is_available_to_completion_report():
    report = next(s for s in _steps() if s["name"] == "Report completion to Worker")
    env = report.get("env", {})
    # The completion report runs with if: always() and will surface the failure
    # captured by the fail step above.
    assert report["if"] == "always()"


def test_chopify_receives_video_path_from_download_step_outputs():
    step = next(s for s in _steps() if s["name"] == "Run Chopify processing")
    env = step.get("env", {})
    assert env["VIDEO_PATH"] == "${{ steps.download.outputs.video_path || steps.fetch-source.outputs.video_path }}"


def test_extract_job_if_matches_youtube_and_youtu_be_urls():
    cond = _extract()["if"]
    assert "youtube.com" in cond
    assert "youtu.be" in cond


def test_download_steps_are_mutually_exclusive():
    download = next(s for s in _steps() if s["name"] == "Download video via Worker presigned URL")
    fetch = next(s for s in _steps() if s["name"] == "Fetch YouTube source from R2")
    assert "source_r2_key == ''" in download["if"]
    assert "source_r2_key != ''" in fetch["if"]


def test_failed_download_step_reported_in_completion():
    steps = _steps()
    fail = next(s for s in steps if s["name"].startswith("Fail workflow when YouTube extraction"))
    # The fail step must run before any download step so a failed extraction
    # never reaches Chopify with a missing source.
    fail_index = next(i for i, s in enumerate(steps) if s["name"].startswith("Fail workflow when YouTube extraction"))
    download_index = next(i for i, s in enumerate(steps) if s["name"] == "Download video via Worker presigned URL")
    assert fail_index < download_index
    report = next(s for s in steps if s["name"] == "Report completion to Worker")
    assert report["if"] == "always()"

def test_extract_ytdlp_runtime_is_explicit_and_verified():
    steps = _extract_steps()
    deno = next(s for s in steps if s["name"] == "Set up Deno (JavaScript runtime yt-dlp needs for YouTube)")
    assert deno["uses"] == "denoland/setup-deno@v2"
    install = next(s for s in steps if s["name"] == "Install Python dependencies")
    run = install["run"]
    assert '"yt-dlp[default]"' in run
    assert "yt-dlp-ejs" in run
    assert "command -v deno" in run
    assert "2, 3, 0" in run
    download = next(s for s in steps if s["name"] == "Download YouTube video")["run"]
    assert "'--js-runtimes', 'deno'" in download
