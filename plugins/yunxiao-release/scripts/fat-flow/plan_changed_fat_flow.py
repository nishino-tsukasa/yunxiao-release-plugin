#!/usr/bin/env python3
"""执行 Environment Release Planner 生成的云效流水线计划。"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

from yunxiao_env import require_yunxiao_runtime
from yunxiao_env import run_devops


def parse_args() -> argparse.Namespace:
    """解析命令行参数。"""
    parser = argparse.ArgumentParser(description="执行统一 Environment Release Planner 生成的流水线计划。")
    parser.add_argument("--plan-input", required=True, help="Environment Release Planner 生成的计划文件。")
    parser.add_argument("--run", action="store_true", help="实际触发云效流水线；未指定时只校验并摘要计划。")
    parser.add_argument("--poll-interval", type=int, help="覆盖配置中的流水线状态轮询间隔。")
    parser.add_argument("--client-initial-wait", type=int, help="覆盖配置中的 client 首次查询等待时间。")
    parser.add_argument("--client-timeout", type=int, help="覆盖配置中的 client 超时时间。")
    parser.add_argument("--server-timeout", type=int, help="覆盖配置中的 server 超时时间。")
    parser.add_argument("--verbose", action="store_true", help="输出详细执行日志。")
    parser.add_argument("--state-file", help="本次发布的持久化执行状态文件。")
    parser.add_argument("--resume", action="store_true", help="从已有状态文件继续，不重新触发成功的步骤。")
    parser.add_argument("--retry-failed", action="store_true", help="续跑时为仍失败的步骤创建新运行实例。")
    return parser.parse_args()


def log_verbose(enabled: bool, message: str) -> None:
    """按开关输出详细日志，默认静默。"""
    if enabled:
        print(message, flush=True)


def log_progress(message: str) -> None:
    """输出默认可见的流水线进度，避免静默模式丢失执行顺序和失败上下文。"""
    print(f"PROGRESS {message}", flush=True)


def parse_devops_output(raw_output: str) -> Any:
    """解析云效 CLI 输出，兼容 JSON、裸数字和普通字符串。"""
    content = raw_output.strip()
    if not content:
        return {}
    try:
        return json.loads(content)
    except json.JSONDecodeError:
        if content.isdigit():
            return int(content)
        return {"raw": content}

def require_yunxiao_env() -> None:
    """实际触发流水线前校验云效认证环境变量。"""
    require_yunxiao_runtime()


class ExecutionJournal:
    """只保存计划指纹和运行 ID；不把流水线参数或凭据写入状态文件。"""

    def __init__(self, path: Path, plan: dict[str, Any], resume: bool) -> None:
        self.path = path
        self.lock = threading.Lock()
        relevant = {key: plan.get(key) for key in (
            "environment", "branch", "changedProjects", "request", "stages", "waves", "revisions",
        )}
        fingerprint = hashlib.sha256(json.dumps(relevant, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
        if resume:
            self.data = json.loads(path.read_text(encoding="utf-8"))
            if self.data.get("fingerprint") != fingerprint:
                raise RuntimeError("续跑计划与原发布计划不一致")
        else:
            if path.exists():
                raise RuntimeError(f"执行状态文件已存在，请使用 --resume 或更换路径: {path}")
            self.data = {"version": 1, "fingerprint": fingerprint, "steps": {}}
            self._write()

    def _write(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=self.path.parent, prefix=".fat-state-", delete=False) as file:
            temporary = Path(file.name)
            os.chmod(temporary, 0o600)
            json.dump(self.data, file, ensure_ascii=False, sort_keys=True)
            file.write("\n")
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, self.path)

    def get(self, key: str) -> dict[str, Any] | None:
        with self.lock:
            record = self.data["steps"].get(key)
            return dict(record) if record else None

    def record(self, key: str, **values: Any) -> None:
        with self.lock:
            self.data["steps"][key] = values
            self._write()


def run_flow_step(step: dict[str, Any]) -> dict[str, Any]:
    """调用云效 CLI 触发单个流水线步骤。"""
    if not step.get("pipelineId"):
        raise RuntimeError(f"流水线未配置 pipelineId：{step}")
    params = json.dumps(step["params"], ensure_ascii=False, separators=(",", ":"))
    proc = run_devops([
        "flow-create-pipeline-run",
        "--pipeline-id",
        step["pipelineId"],
        "--params",
        params,
    ])
    if proc.returncode != 0:
        raise RuntimeError(f"触发流水线失败：{step['pipelineName']} project={step['project']}\n{proc.stderr.strip()}")
    return {
        "pipelineRunResult": parse_devops_output(proc.stdout),
        "rawStdout": proc.stdout.strip(),
        "rawStderr": proc.stderr.strip(),
    }


def read_field(value: Any, names: tuple[str, ...]) -> Any:
    """递归按候选字段名读取云效返回对象字段。"""
    if isinstance(value, dict):
        for name in names:
            if name in value and value[name] not in (None, ""):
                return value[name]
        for nested in value.values():
            found = read_field(nested, names)
            if found not in (None, ""):
                return found
    if isinstance(value, list):
        for item in value:
            found = read_field(item, names)
            if found not in (None, ""):
                return found
    return None


def extract_pipeline_run_id(result: Any) -> str:
    """从运行流水线返回结果中提取 pipelineRunId。"""
    if isinstance(result, int):
        return str(result)
    if isinstance(result, str):
        stripped = result.strip()
        if stripped.isdigit():
            return stripped
    if isinstance(result, dict):
        raw = result.get("raw")
        if isinstance(raw, str) and raw.strip().isdigit():
            return raw.strip()
    run_id = read_field(result, ("pipelineRunId", "pipeline_run_id", "runId", "id", "Id"))
    if not run_id:
        raise RuntimeError(f"无法从云效返回中提取 pipelineRunId：{json.dumps(result, ensure_ascii=False)[:1000]}")
    return str(run_id)


def extract_pipeline_status(result: dict[str, Any]) -> str:
    """从流水线运行详情中提取运行状态。"""
    status = read_field(result, ("status", "Status", "state", "State"))
    return str(status or "UNKNOWN").upper()


def get_pipeline_run(step: dict[str, Any], pipeline_run_id: str) -> dict[str, Any]:
    """查询单个流水线运行详情。"""
    proc = run_devops([
        "flow-get-pipeline-run",
        "--pipeline-id",
        step["pipelineId"],
        "--pipeline-run-id",
        pipeline_run_id,
    ])
    if proc.returncode != 0:
        raise RuntimeError(f"查询流水线状态失败：{step['pipelineName']} project={step['project']}\n{proc.stderr.strip()}")
    detail = parse_devops_output(proc.stdout)
    if not isinstance(detail, dict):
        raise RuntimeError(
            f"流水线状态返回格式异常：{step['pipelineName']} project={step['project']} "
            f"runId={pipeline_run_id} output={json.dumps(detail, ensure_ascii=False)}"
        )
    return detail


def wait_flow_step(step: dict[str, Any], poll_interval: int, timeout: int, verbose: bool,
                   initial_wait_seconds: int = 0, journal: ExecutionJournal | None = None,
                   retry_failed: bool = False) -> dict[str, Any]:
    """等待单个流水线运行完成。"""
    log_progress(
        f"stage={step['type']} status=starting project={step['project']} "
        f"pipeline={step['pipelineName']}"
    )
    key = str(step.get("journalKey", ""))
    record = journal.get(key) if journal else None
    if record and record.get("phase") != "not_started" and record.get("pipelineId") != str(step["pipelineId"]):
        raise RuntimeError(f"续跑流水线 ID 已变化: {step['project']} {step['pipelineName']}")
    if record and record.get("phase") == "triggering":
        raise RuntimeError(f"流水线触发结果未知，拒绝重复触发: {step['project']} {step['pipelineName']}；请人工核对运行实例")
    pipeline_run_id = str(record.get("runId")) if record and record.get("runId") else ""
    if pipeline_run_id:
        detail = get_pipeline_run(step, pipeline_run_id)
        status = extract_pipeline_status(detail)
        if status == "SUCCESS":
            step.update(pipelineRunId=pipeline_run_id, status="SUCCESS", runDetail=detail, durationSeconds=0)
            if journal:
                journal.record(key, phase="success", pipelineId=str(step["pipelineId"]), runId=pipeline_run_id)
            log_progress(f"stage={step['type']} status=reused project={step['project']} pipeline={step['pipelineName']} runId={pipeline_run_id}")
            return step
        if status in {"FAIL", "FAILED", "CANCELED", "CANCELLED", "ERROR"}:
            if not retry_failed:
                raise RuntimeError(f"已有流水线仍失败：{step['pipelineName']} project={step['project']} runId={pipeline_run_id}；可人工重试任务后续跑，或使用 --retry-failed")
            pipeline_run_id = ""
    newly_triggered = not pipeline_run_id
    if newly_triggered:
        if journal:
            journal.record(key, phase="triggering", pipelineId=str(step["pipelineId"]))
        try:
            trigger_result = run_flow_step(step)
        except RuntimeError as error:
            if journal and any(code in str(error) for code in ("HTTP 400", "HTTP 401", "HTTP 403", "HTTP 404")):
                journal.record(key, phase="not_started", pipelineId=str(step["pipelineId"]))
            raise
        pipeline_run_result = trigger_result.get("pipelineRunResult", {})
        pipeline_run_id = extract_pipeline_run_id(pipeline_run_result)
        if journal:
            journal.record(key, phase="triggered", pipelineId=str(step["pipelineId"]), runId=pipeline_run_id)
    step["pipelineRunId"] = pipeline_run_id
    log_progress(
        f"stage={step['type']} status={'triggered' if newly_triggered else 'resumed'} project={step['project']} "
        f"pipeline={step['pipelineName']} runId={pipeline_run_id}"
    )
    started_at = time.time()
    deadline = started_at + timeout
    log_verbose(
        verbose,
        f"已触发 {step['type']} project={step['project']} pipeline={step['pipelineName']} "
        f"runId={pipeline_run_id} timeout={timeout}s",
    )
    if initial_wait_seconds > 0:
        remaining_before_wait = max(0, int(deadline - time.time()))
        if remaining_before_wait <= initial_wait_seconds:
            raise TimeoutError(
                f"等待流水线超时：{step['pipelineName']} project={step['project']} "
                f"runId={pipeline_run_id} status=WAITING_INITIAL_DELAY"
            )
        log_verbose(
            verbose,
            f"首次查询前等待 {step['type']} project={step['project']} pipeline={step['pipelineName']} "
            f"runId={pipeline_run_id} delay={initial_wait_seconds}s",
        )
        time.sleep(initial_wait_seconds)
    while True:
        detail = get_pipeline_run(step, pipeline_run_id)
        status = extract_pipeline_status(detail)
        step["status"] = status
        if status == "SUCCESS":
            if journal:
                journal.record(key, phase="success", pipelineId=str(step["pipelineId"]), runId=pipeline_run_id)
            step["runDetail"] = detail
            step["durationSeconds"] = int(time.time() - started_at)
            log_progress(
                f"stage={step['type']} status=success project={step['project']} "
                f"pipeline={step['pipelineName']} runId={pipeline_run_id} "
                f"duration={step['durationSeconds']}s"
            )
            log_verbose(
                verbose,
                f"执行成功 {step['type']} project={step['project']} pipeline={step['pipelineName']} "
                f"runId={pipeline_run_id} duration={step['durationSeconds']}s",
            )
            return step
        if status in {"FAIL", "FAILED", "CANCELED", "CANCELLED", "ERROR"}:
            raise RuntimeError(
                f"流水线失败：{step['pipelineName']} project={step['project']} runId={pipeline_run_id} "
                f"status={status}；查看云效运行详情后续跑"
            )
        if time.time() >= deadline:
            raise TimeoutError(f"等待流水线超时：{step['pipelineName']} project={step['project']} runId={pipeline_run_id} status={status}")
        elapsed = int(time.time() - started_at)
        remaining = max(0, int(deadline - time.time()))
        log_verbose(
            verbose,
            f"等待中 {step['type']} project={step['project']} pipeline={step['pipelineName']} "
            f"runId={pipeline_run_id} status={status} elapsed={elapsed}s remaining={remaining}s",
        )
        time.sleep(poll_interval)


def execute_pipeline_queue(steps: list[dict[str, Any]], poll_interval: int, timeout: int, verbose: bool,
                           initial_wait_seconds: int, journal: ExecutionJournal | None = None,
                           retry_failed: bool = False) -> list[dict[str, Any]]:
    """同一条流水线内串行执行多个步骤。"""
    completed: list[dict[str, Any]] = []
    for step in steps:
        log_verbose(verbose, f"准备执行 {step['type']} project={step['project']} pipeline={step['pipelineName']}")
        completed.append(wait_flow_step(step, poll_interval, timeout, verbose, initial_wait_seconds, journal, retry_failed))
    return completed


def pipeline_has_running_run(pipeline_id: str) -> bool:
    """查询真实占用；查询失败或响应不明时不猜测为空闲。"""
    proc = run_devops(["flow-list-pipeline-runs", "--pipeline-id", pipeline_id, "--status", "RUNNING"])
    if proc.returncode != 0:
        raise RuntimeError(f"查询 Client 流水线占用失败: pipelineId={pipeline_id} {proc.stderr.strip()}")
    result = parse_devops_output(proc.stdout)
    runs = result if isinstance(result, list) else result.get("pipelineRuns") if isinstance(result, dict) else None
    if not isinstance(runs, list):
        raise RuntimeError(f"Client 流水线占用响应格式异常: pipelineId={pipeline_id}")
    return bool(runs)


def assign_client_pipelines(steps: list[dict[str, Any]], poll_interval: int, timeout: int,
                            journal: ExecutionJournal | None) -> None:
    """按执行时的运行状态选空闲候选，同次发布的项目均衡排队。"""
    reservations: dict[str, int] = {}
    for step in steps:
        candidates = step.get("candidates") or [{
            "pipelineId": step["pipelineId"], "pipelineName": step["pipelineName"], "params": step["params"],
        }]
        record = journal.get(step["journalKey"]) if journal else None
        pinned_id = str(record.get("pipelineId")) if record and record.get("pipelineId") and record.get("phase") != "not_started" else ""
        if pinned_id:
            selected = next((candidate for candidate in candidates if str(candidate["pipelineId"]) == pinned_id), None)
            if selected is None:
                raise RuntimeError(f"续跑 Client 候选流水线已变化: project={step['project']} pipelineId={pinned_id}")
        else:
            deadline = time.monotonic() + timeout
            while True:
                free = [candidate for candidate in candidates if not pipeline_has_running_run(str(candidate["pipelineId"]))]
                if free:
                    selected = min(free, key=lambda candidate: reservations.get(str(candidate["pipelineId"]), 0))
                    break
                if time.monotonic() >= deadline:
                    raise TimeoutError(f"所有 Client 候选流水线都在运行: project={step['project']}")
                log_progress(f"stage=backend-client-package status=waiting-free-pipeline project={step['project']}")
                time.sleep(max(1, poll_interval))
        step.update({field: selected[field] for field in ("pipelineId", "pipelineName", "params")})
        pipeline_id = str(selected["pipelineId"])
        reservations[pipeline_id] = reservations.get(pipeline_id, 0) + 1
        log_progress(f"stage=backend-client-package status=selected project={step['project']} pipeline={step['pipelineName']} pipelineId={pipeline_id}")


def summarize_stage_steps(stage_name: str, steps: list[dict[str, Any]]) -> str:
    """生成单个阶段的紧凑摘要，便于外层脚本和 skill 直接引用。"""
    if not steps:
        return f"RESULT stage={stage_name} status=success steps=0 pipelines=0 projects=none"
    projects = ",".join(step["project"] for step in steps)
    pipelines = ",".join(sorted({str(step["pipelineName"]) for step in steps}))
    return (
        f"RESULT stage={stage_name} status=success steps={len(steps)} "
        f"pipelines={len({str(step['pipelineId']) for step in steps})} "
        f"projects={projects} pipeline_names={pipelines}"
    )


def execute_stage(stage: dict[str, Any], poll_interval: int, timeout: int, verbose: bool,
                  initial_wait_seconds: int = 0, stage_index: int = 1, stage_total: int = 1,
                  journal: ExecutionJournal | None = None, retry_failed: bool = False,
                  wave_index: int = 0) -> list[dict[str, Any]]:
    """按流水线分组并发执行一个阶段，同组内串行。"""
    steps = stage.get("steps", [])
    if not steps:
        log_verbose(verbose, f"阶段 {stage['name']} 没有需要执行的步骤")
        return []
    queues: dict[str, list[dict[str, Any]]] = {}
    for index, step in enumerate(steps):
        step["journalKey"] = f"{wave_index}:{stage['name']}:{step['project']}:{index}"
    if stage["name"] == "backend-client-package":
        assign_client_pipelines(steps, poll_interval, timeout, journal)
    for step in steps:
        queues.setdefault(str(step["pipelineId"]), []).append(step)
    projects = ",".join(str(step["project"]) for step in steps)
    log_progress(
        f"stage={stage['name']} status=started order={stage_index}/{stage_total} "
        f"projects={projects} pipelines={len(queues)}"
    )
    log_verbose(
        verbose,
        f"开始阶段 {stage['name']}：steps={len(steps)} pipelines={len(queues)} "
        f"pollInterval={poll_interval}s timeout={timeout}s initialWait={initial_wait_seconds}s",
    )
    completed: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=len(queues)) as executor:
        futures = [executor.submit(execute_pipeline_queue, queue, poll_interval, timeout, verbose,
                                   initial_wait_seconds, journal, retry_failed) for queue in queues.values()]
        for future in as_completed(futures):
            completed.extend(future.result())
    log_verbose(verbose, f"阶段完成 {stage['name']}")
    log_verbose(verbose, summarize_stage_steps(str(stage["name"]), completed))
    log_progress(
        f"stage={stage['name']} status=success order={stage_index}/{stage_total} "
        f"completed={len(completed)}"
    )
    return completed


def execute_plan(plan: dict[str, Any], poll_interval: int, stage_execution: dict[str, dict[str, int]], verbose: bool,
                 journal: ExecutionJournal | None = None, retry_failed: bool = False) -> dict[str, Any]:
    """按阶段执行流水线计划；每个阶段使用规范化后的等待与超时设置。"""
    require_yunxiao_env()
    if plan["unresolved"]:
        raise RuntimeError("存在未配置映射，禁止执行真实流水线。请先补齐配置。")
    stage_results: list[dict[str, Any]] = []
    waves = plan.get("waves") or [{"stages": plan["stages"]}]
    stage_total = sum(sum(bool(stage["steps"]) for stage in wave["stages"]) for wave in waves)
    stage_index = 0
    for wave_index, wave in enumerate(waves):
        for stage in wave["stages"]:
            if not stage["steps"]:
                continue
            stage_index += 1
            settings = stage_execution.get(stage["name"])
            if not settings:
                raise RuntimeError(f"缺少阶段执行配置：{stage['name']}")
            stage_timeout = int(settings["timeoutSeconds"])
            initial_wait_seconds = int(settings.get("initialWaitSeconds", 0))
            completed_steps = execute_stage(stage, poll_interval, stage_timeout, verbose, initial_wait_seconds,
                                            stage_index, stage_total, journal, retry_failed, wave_index)
            existing = next((result for result in stage_results if result["name"] == stage["name"]), None)
            if existing:
                existing["steps"].extend(completed_steps)
            else:
                stage_results.append({"name": stage["name"], "steps": completed_steps})
    return {
        "status": "success",
        "projects": list(plan["changedProjects"]),
        "stages": stage_results,
    }


def print_final_summary(plan: dict[str, Any], execution_result: dict[str, Any] | None) -> None:
    """输出最终摘要行，避免 skill 逐段总结长日志。"""
    projects = ",".join(plan["changedProjects"]) if plan["changedProjects"] else "none"
    unresolved_count = len(plan["unresolved"])
    if execution_result is None:
        frontend_steps = next((len(stage["steps"]) for stage in plan["stages"] if stage["name"] == "frontend-client-deploy"), 0)
        client_steps = next((len(stage["steps"]) for stage in plan["stages"] if stage["name"] == "backend-client-package"), 0)
        server_steps = next((len(stage["steps"]) for stage in plan["stages"] if stage["name"] == "backend-server-deploy"), 0)
        print(
            f"RESULT status=planned projects={projects} unresolved={unresolved_count} "
            f"frontend_steps={frontend_steps} client_steps={client_steps} server_steps={server_steps}",
            flush=True,
        )
        return
    frontend_stage = next((stage for stage in execution_result["stages"] if stage["name"] == "frontend-client-deploy"), {"steps": []})
    client_stage = next((stage for stage in execution_result["stages"] if stage["name"] == "backend-client-package"), {"steps": []})
    server_stage = next((stage for stage in execution_result["stages"] if stage["name"] == "backend-server-deploy"), {"steps": []})
    print(
        f"RESULT status=success projects={projects} unresolved={unresolved_count} "
        f"frontend_success={len(frontend_stage['steps'])} client_success={len(client_stage['steps'])} "
        f"server_success={len(server_stage['steps'])}",
        flush=True,
    )


def print_failure_summary(projects: list[str], error: Exception) -> None:
    """输出统一失败摘要，避免调用方从长异常文本中二次提炼。"""
    rendered_projects = ",".join(projects) if projects else "none"
    message = " ".join(str(error).split())
    print(f"FAIL status=failed projects={rendered_projects} message={message}", file=sys.stderr, flush=True)


def main() -> None:
    """校验并按需执行统一规划器生成的计划。"""
    args = parse_args()
    projects: list[str] = []
    try:
        plan = json.loads(Path(args.plan_input).read_text(encoding="utf-8"))
        projects = [str(project) for project in plan.get("changedProjects", [])]
        execution_result: dict[str, Any] | None = None
        execution = plan.get("execution", {})
        poll_interval = args.poll_interval if args.poll_interval is not None else int(execution["pollIntervalSeconds"])
        stage_execution = {name: dict(settings) for name, settings in execution["stages"].items()}
        if args.client_initial_wait is not None:
            stage_execution["backend-client-package"]["initialWaitSeconds"] = args.client_initial_wait
        if args.client_timeout is not None:
            stage_execution["backend-client-package"]["timeoutSeconds"] = args.client_timeout
        if args.server_timeout is not None:
            stage_execution["backend-server-deploy"]["timeoutSeconds"] = args.server_timeout
        if args.retry_failed and not args.resume:
            raise RuntimeError("--retry-failed 只能与 --resume 一起使用")
        if args.resume and not args.state_file:
            raise RuntimeError("--resume 缺少 --state-file")
        journal = ExecutionJournal(Path(args.state_file), plan, args.resume) if args.run and args.state_file else None
        if args.run:
            execution_result = execute_plan(plan, poll_interval, stage_execution, args.verbose, journal, args.retry_failed)
        print_final_summary(plan, execution_result)
    except Exception as error:
        print_failure_summary(projects, error)
        sys.exit(1)


if __name__ == "__main__":
    main()
