#!/usr/bin/env python3
"""根据本地改动项目生成 FAT client 打包与 server 部署流水线计划。"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from yunxiao_env import require_yunxiao_runtime, resolve_organization_id
from yunxiao_env import run_devops


SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_CONFIG = SCRIPT_DIR / "fat-pipeline-config.json"
DEFAULT_EXAMPLE_CONFIG = SCRIPT_DIR / "fat-pipeline-config.example.json"
DEFAULT_OUTPUT = SCRIPT_DIR / "output" / "changed-fat-flow-plan.json"


def parse_args() -> argparse.Namespace:
    """解析命令行参数。"""
    parser = argparse.ArgumentParser(description="生成或执行 FAT client 打包与 server 部署流水线计划。")
    parser.add_argument("--config", default=str(DEFAULT_CONFIG), help="流水线映射配置文件。")
    parser.add_argument("--projects-root", default=str(Path.cwd()), help="包含多个项目仓库的根目录。")
    parser.add_argument("--base-ref", default="origin/fat/fat", help="用于判断改动的基准 ref。")
    parser.add_argument("--projects", help="显式指定项目，逗号分隔；指定后不扫描本地 git 改动。")
    parser.add_argument("--client-projects", help="显式指定需要打 client 包的项目，逗号分隔；留空表示本次部署无需打任何 client 包。")
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT), help="计划输出文件。")
    parser.add_argument("--run", action="store_true", help="实际触发云效流水线；默认只生成计划。")
    parser.add_argument("--skip-server", action="store_true", help="只打 client 包，不生成 server 部署步骤。")
    parser.add_argument("--poll-interval", type=int, default=10, help="流水线状态轮询间隔秒数，默认 10。")
    parser.add_argument("--client-initial-wait", type=int, default=60, help="client 包触发后首次查询前的等待秒数，默认 60。")
    parser.add_argument("--client-timeout", type=int, default=600, help="单个 client 打包流水线最大等待秒数，默认 600。")
    parser.add_argument("--server-timeout", type=int, default=1800, help="单个 server 部署流水线最大等待秒数，默认 1800。")
    parser.add_argument("--verbose", action="store_true", help="输出详细执行日志。")
    return parser.parse_args()


def log_verbose(enabled: bool, message: str) -> None:
    """按开关输出详细日志，默认静默。"""
    if enabled:
        print(message, flush=True)


def log_progress(message: str) -> None:
    """输出默认可见的流水线进度，避免静默模式丢失执行顺序和失败上下文。"""
    print(f"PROGRESS {message}", flush=True)


def run_cmd(args: list[str], cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    """执行本地命令并返回结果，不直接抛出异常。"""
    return subprocess.run(args, cwd=str(cwd) if cwd else None, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)


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


def load_config(path: Path) -> dict[str, Any]:
    """读取流水线映射配置。"""
    if not path.exists():
        raise FileNotFoundError(f"缺少配置文件：{path}，请先复制 {DEFAULT_EXAMPLE_CONFIG.name} 并补充流水线映射。")
    return json.loads(path.read_text(encoding="utf-8"))


def list_git_projects(root: Path) -> list[Path]:
    """扫描根目录下一层 Git 项目。"""
    return sorted(path for path in root.iterdir() if path.is_dir() and (path / ".git").exists())


def ref_exists(repo: Path, ref: str) -> bool:
    """判断仓库中指定 ref 是否存在。"""
    proc = run_cmd(["git", "rev-parse", "--verify", "--quiet", ref], cwd=repo)
    return proc.returncode == 0


def has_status_changes(repo: Path) -> bool:
    """判断仓库工作区或暂存区是否有改动。"""
    proc = run_cmd(["git", "status", "--short"], cwd=repo)
    return bool(proc.stdout.strip())


def has_diff_from_ref(repo: Path, base_ref: str) -> bool:
    """判断当前 HEAD 相对基准 ref 是否存在文件差异。"""
    if not ref_exists(repo, base_ref):
        return False
    proc = run_cmd(["git", "diff", "--quiet", f"{base_ref}...HEAD"], cwd=repo)
    return proc.returncode == 1


def detect_changed_projects(root: Path, base_ref: str) -> list[str]:
    """根据本地 Git 状态和基准分支差异识别有改动的项目。"""
    changed: list[str] = []
    for repo in list_git_projects(root):
        if has_status_changes(repo) or has_diff_from_ref(repo, base_ref):
            changed.append(repo.name)
    return changed


def render_value(value: str, project: str, branch: str, env: str, env_name: str, feishu_id: str) -> str:
    """渲染流水线变量模板。"""
    return value.format(project=project, branch=branch, env=env, envName=env_name, feishuId=feishu_id)


def render_envs(template: dict[str, str], project: str, branch: str, env: str, env_name: str, feishu_id: str) -> dict[str, str]:
    """根据项目上下文生成 Flow envs 参数。"""
    return {key: render_value(str(value), project, branch, env, env_name, feishu_id) for key, value in template.items()}


def is_frontend_project(project: str) -> bool:
    """按项目命名约定识别前端项目；项目名包含 -web 即视为前端。"""
    return "-web" in project


def resolve_target_branch(project: str, config: dict[str, Any]) -> str:
    """选择项目在 FAT 流程中实际部署的目标分支。"""
    branches = config.get("branches", {})
    if is_frontend_project(project):
        frontend_branch = branches.get("frontend")
        frontend_config = config.get("frontendDeploy", {})
        return str(frontend_config.get("defaultBranch") or frontend_branch or "develop")
    return str(branches.get("backend") or config.get("branch") or "fat/fat")


def available_client_pipelines(project: str, config: dict[str, Any]) -> list[dict[str, Any]]:
    """获取单个项目可使用的 client 打包流水线列表。"""
    client_config = config.get("clientPackage", {})
    if project in client_config.get("skipProjects", []):
        return []
    pipelines: list[dict[str, Any]] = []
    framework = client_config.get("frameworkPipeline", {})
    if project in framework.get("projects", []):
        pipelines.append(framework)
    for pipeline in client_config.get("javaServicePipelines", []):
        if project in pipeline.get("projects", []):
            pipelines.append(pipeline)
    return pipelines


def build_client_step(project: str, pipeline: dict[str, Any], config: dict[str, Any], branch: str) -> tuple[dict[str, Any] | None, str | None]:
    """按指定流水线为单个项目生成 client 打包步骤。"""
    client_config = config.get("clientPackage", {})
    env = str(client_config.get("defaultEnv") or "fat")
    feishu_id = str(client_config.get("defaultFeishuId") or "")
    step = build_flow_step(project, branch, env, env, feishu_id, pipeline, "client-package")
    return step, None if step["readyToRun"] else f"项目 {project} 的 client 打包流水线 {step['pipelineName']} 未配置 pipelineId"


def build_server_step(project: str, config: dict[str, Any], branch: str) -> tuple[dict[str, Any] | None, str | None]:
    """为单个项目生成 server 部署步骤。"""
    server_config = config.get("serverDeploy", {})
    if project in server_config.get("skipProjects", []):
        return None, None
    project_config = server_config.get("projects", {}).get(project)
    if not project_config:
        return None, f"项目 {project} 未配置 server 部署流水线映射"
    env = str(project_config.get("env") or server_config.get("defaultEnv") or "fat")
    feishu_id = str(project_config.get("feishuId") or "")
    step = build_flow_step(project, branch, env, env, feishu_id, project_config, "server-deploy")
    return step, None if step["readyToRun"] else f"项目 {project} 的 server 部署流水线 {step['pipelineName']} 未配置 pipelineId"


def build_frontend_step(project: str, config: dict[str, Any]) -> tuple[dict[str, Any] | None, str | None]:
    """为前端项目生成 develop 分支上的 FAT 部署步骤。"""
    frontend_config = config.get("frontendDeploy", {})
    project_config = frontend_config.get("projects", {}).get(project)
    if not project_config:
        return None, f"项目 {project} 未配置 frontend FAT 部署流水线映射"
    branch = resolve_target_branch(project, config)
    env = str(project_config.get("env") or frontend_config.get("defaultEnv") or "fat")
    env_name = str(project_config.get("envName") or frontend_config.get("defaultEnvName") or "default")
    feishu_id = str(project_config.get("feishuId") or frontend_config.get("defaultFeishuId") or "")
    step = build_flow_step(project, branch, env, env_name, feishu_id, project_config, "frontend-deploy")
    return step, None if step["readyToRun"] else f"项目 {project} 的 frontend 部署流水线 {step['pipelineName']} 未配置 pipelineId"


def build_flow_step(project: str, branch: str, env: str, env_name: str, feishu_id: str, pipeline: dict[str, Any], step_type: str) -> dict[str, Any]:
    """生成单个云效 Flow 运行步骤。"""
    pipeline_id = str(pipeline.get("pipelineId") or "")
    envs = render_envs(pipeline.get("envs", {}), project, branch, env, env_name, feishu_id)
    return {
        "type": step_type,
        "project": project,
        "pipelineName": pipeline.get("name"),
        "pipelineId": pipeline_id,
        "params": {
            "envs": envs
        },
        "readyToRun": bool(pipeline_id),
    }


def should_package_client(project: str, explicit_client_projects: set[str] | None) -> bool:
    """判断当前项目本次计划中是否需要打 client 包。"""
    if explicit_client_projects is None:
        return True
    return project in explicit_client_projects


def build_plan(projects: list[str], config: dict[str, Any], skip_server: bool, explicit_client_projects: set[str] | None = None) -> dict[str, Any]:
    """生成 FAT 流水线执行计划。"""
    branches = {project: resolve_target_branch(project, config) for project in projects}
    unique_branches = sorted(set(branches.values()))
    branch = unique_branches[0] if len(unique_branches) == 1 else "mixed"
    frontend_steps: list[dict[str, Any]] = []
    client_steps: list[dict[str, Any]] = []
    server_steps: list[dict[str, Any]] = []
    unresolved: list[str] = []
    client_pipeline_load: dict[str, int] = {}
    for project in projects:
        if is_frontend_project(project):
            if not skip_server:
                frontend_step, frontend_error = build_frontend_step(project, config)
                if frontend_step:
                    frontend_steps.append(frontend_step)
                if frontend_error:
                    unresolved.append(frontend_error)
            continue
        client_config = config.get("clientPackage", {})
        if should_package_client(project, explicit_client_projects) and project not in client_config.get("skipProjects", []):
            candidates = available_client_pipelines(project, config)
            if candidates:
                selected_pipeline = sorted(candidates, key=lambda item: (client_pipeline_load.get(str(item.get("pipelineId") or item.get("name")), 0), str(item.get("name"))))[0]
                client_step, client_error = build_client_step(project, selected_pipeline, config, branches[project])
                if client_step:
                    client_steps.append(client_step)
                    pipeline_key = str(client_step.get("pipelineId") or client_step.get("pipelineName"))
                    client_pipeline_load[pipeline_key] = client_pipeline_load.get(pipeline_key, 0) + 1
                if client_error:
                    unresolved.append(client_error)
            else:
                unresolved.append(f"项目 {project} 未配置 client 打包流水线映射")
        if not skip_server:
            server_step, server_error = build_server_step(project, config, branches[project])
            if server_step:
                server_steps.append(server_step)
            if server_error:
                unresolved.append(server_error)
    return {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "branch": branch,
        "changedProjects": projects,
        "stages": [
            {
                "name": "frontend-deploy",
                "description": "部署前端项目 develop 分支的 FAT 流水线",
                "steps": frontend_steps,
            },
            {
                "name": "client-package",
                "description": "先打所有改动项目的 client 包",
                "steps": client_steps,
            },
            {
                "name": "server-deploy",
                "description": "client 包完成后再部署所有改动 server 项目",
                "steps": server_steps,
            },
        ],
        "unresolved": unresolved,
    }


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
    """执行计划生成或真实触发主流程。"""
    args = parse_args()
    projects: list[str] = []
    try:
        config = load_config(Path(args.config))
        explicit_client_projects: set[str] | None = None
        if args.projects:
            projects = sorted({project.strip() for project in args.projects.split(",") if project.strip()})
        else:
            projects = detect_changed_projects(Path(args.projects_root), args.base_ref)
        if args.client_projects is not None:
            explicit_client_projects = {project.strip() for project in args.client_projects.split(",") if project.strip()}
        plan = build_plan(projects, config, args.skip_server, explicit_client_projects)
        execution_result: dict[str, Any] | None = None
        if args.run:
            execution_result = execute_plan(plan, args.poll_interval, args.client_initial_wait, args.client_timeout, args.server_timeout, args.verbose)
        output = Path(args.output)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(plan, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        log_verbose(args.verbose, f"已生成计划：{output}")
        log_verbose(args.verbose, f"改动项目：{', '.join(projects) if projects else '无'}")
        log_verbose(args.verbose, f"组织 ID：{resolve_organization_id()}")
        if plan["unresolved"]:
            if args.verbose:
                print("存在未配置映射：", file=sys.stderr)
            for item in plan["unresolved"]:
                if args.verbose:
                    print(f"- {item}", file=sys.stderr)
            if args.run:
                sys.exit(3)
        print_final_summary(plan, execution_result)
    except Exception as error:
        print_failure_summary(projects, error)
        sys.exit(1)


if __name__ == "__main__":
    main()
