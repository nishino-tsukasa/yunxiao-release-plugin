#!/usr/bin/env python3
"""执行 Environment Release Planner 生成的云效流水线计划。"""

from __future__ import annotations

import argparse
import json
import sys
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


def wait_flow_step(step: dict[str, Any], poll_interval: int, timeout: int, verbose: bool, initial_wait_seconds: int = 0) -> dict[str, Any]:
    """等待单个流水线运行完成。"""
    log_progress(
        f"stage={step['type']} status=starting project={step['project']} "
        f"pipeline={step['pipelineName']}"
    )
    trigger_result = run_flow_step(step)
    pipeline_run_result = trigger_result.get("pipelineRunResult", {})
    pipeline_run_id = extract_pipeline_run_id(pipeline_run_result)
    step["pipelineRunId"] = pipeline_run_id
    log_progress(
        f"stage={step['type']} status=triggered project={step['project']} "
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
            step["runResult"] = trigger_result
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
                f"status={status} detail={json.dumps(detail, ensure_ascii=False)}"
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


def execute_pipeline_queue(steps: list[dict[str, Any]], poll_interval: int, timeout: int, verbose: bool, initial_wait_seconds: int) -> list[dict[str, Any]]:
    """同一条流水线内串行执行多个步骤。"""
    completed: list[dict[str, Any]] = []
    for step in steps:
        log_verbose(verbose, f"准备执行 {step['type']} project={step['project']} pipeline={step['pipelineName']}")
        completed.append(wait_flow_step(step, poll_interval, timeout, verbose, initial_wait_seconds))
    return completed


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
                  initial_wait_seconds: int = 0, stage_index: int = 1, stage_total: int = 1) -> list[dict[str, Any]]:
    """按流水线分组并发执行一个阶段，同组内串行。"""
    steps = stage.get("steps", [])
    if not steps:
        log_verbose(verbose, f"阶段 {stage['name']} 没有需要执行的步骤")
        return []
    queues: dict[str, list[dict[str, Any]]] = {}
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
        futures = [executor.submit(execute_pipeline_queue, queue, poll_interval, timeout, verbose, initial_wait_seconds) for queue in queues.values()]
        for future in as_completed(futures):
            completed.extend(future.result())
    log_verbose(verbose, f"阶段完成 {stage['name']}")
    log_verbose(verbose, summarize_stage_steps(str(stage["name"]), completed))
    log_progress(
        f"stage={stage['name']} status=success order={stage_index}/{stage_total} "
        f"completed={len(completed)}"
    )
    return completed


def execute_plan(plan: dict[str, Any], poll_interval: int, client_initial_wait: int, client_timeout: int, server_timeout: int, verbose: bool) -> dict[str, Any]:
    """按阶段执行流水线计划，client 全部成功后再执行 server。"""
    require_yunxiao_env()
    if plan["unresolved"]:
        raise RuntimeError("存在未配置映射，禁止执行真实流水线。请先补齐配置。")
    stage_results: list[dict[str, Any]] = []
    stages = plan["stages"]
    for stage_index, stage in enumerate(stages, start=1):
        is_client_stage = stage["name"] == "client-package"
        stage_timeout = client_timeout if is_client_stage else server_timeout
        initial_wait_seconds = client_initial_wait if is_client_stage else 0
        completed_steps = execute_stage(stage, poll_interval, stage_timeout, verbose, initial_wait_seconds,
                                        stage_index, len(stages))
        stage_results.append({
            "name": stage["name"],
            "steps": completed_steps,
        })
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
        frontend_steps = next((len(stage["steps"]) for stage in plan["stages"] if stage["name"] == "frontend-deploy"), 0)
        client_steps = next((len(stage["steps"]) for stage in plan["stages"] if stage["name"] == "client-package"), 0)
        server_steps = next((len(stage["steps"]) for stage in plan["stages"] if stage["name"] == "server-deploy"), 0)
        print(
            f"RESULT status=planned projects={projects} unresolved={unresolved_count} "
            f"frontend_steps={frontend_steps} client_steps={client_steps} server_steps={server_steps}",
            flush=True,
        )
        return
    frontend_stage = next((stage for stage in execution_result["stages"] if stage["name"] == "frontend-deploy"), {"steps": []})
    client_stage = next((stage for stage in execution_result["stages"] if stage["name"] == "client-package"), {"steps": []})
    server_stage = next((stage for stage in execution_result["stages"] if stage["name"] == "server-deploy"), {"steps": []})
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
        client_initial_wait = args.client_initial_wait if args.client_initial_wait is not None else int(execution["clientInitialWaitSeconds"])
        client_timeout = args.client_timeout if args.client_timeout is not None else int(execution["clientTimeoutSeconds"])
        server_timeout = args.server_timeout if args.server_timeout is not None else int(execution["serverTimeoutSeconds"])
        if args.run:
            execution_result = execute_plan(plan, poll_interval, client_initial_wait, client_timeout, server_timeout, args.verbose)
        print_final_summary(plan, execution_result)
    except Exception as error:
        print_failure_summary(projects, error)
        sys.exit(1)


if __name__ == "__main__":
    main()
