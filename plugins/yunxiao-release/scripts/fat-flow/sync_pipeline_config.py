#!/usr/bin/env python3
"""从云效 Flow API 同步 FAT 流水线配置。"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any

from yunxiao_env import require_yunxiao_runtime
from yunxiao_env import run_devops
from fat_flow_config import default_paths


SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_OUTPUT = SCRIPT_DIR / "output" / "pipeline-sync-result.json"


def parse_args() -> argparse.Namespace:
    """解析命令行参数。"""
    parser = argparse.ArgumentParser(description="从云效 Flow API 同步 FAT 流水线映射配置。")
    parser.add_argument("--config", default=str(default_paths()[0]), help="要更新的全局默认配置文件。")
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT), help="同步结果输出文件。")
    parser.add_argument("--max-pages", type=int, default=20, help="查询流水线列表的最大页数。")
    parser.add_argument(
        "--frontend-project",
        action="append",
        default=[],
        help="按项目名同步前端 FAT 流水线，可重复传入；未传时同步配置文件中已有前端项目。",
    )
    return parser.parse_args()


def load_config(path: Path) -> dict[str, Any]:
    """读取配置文件。"""
    return json.loads(path.read_text(encoding="utf-8"))


def run_devops_json(args: list[str]) -> Any:
    """调用云效 HTTP API 并解析 JSON 输出。"""
    proc = run_devops(args)
    if proc.returncode != 0:
        raise RuntimeError(f"云效 API 调用失败：{args}\n{proc.stderr.strip()}")
    output = proc.stdout.strip()
    return json.loads(output) if output else {}


def write_json(path: Path, value: Any) -> None:
    """写入格式化 JSON 文件。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def list_pipelines_by_name(name: str, max_pages: int) -> list[dict[str, Any]]:
    """按名称搜索流水线列表。"""
    pipelines: list[dict[str, Any]] = []
    for page in range(1, max_pages + 1):
        data = run_devops_json([
            "flow-list-pipelines",
            "--pipeline-name",
            name,
            "--page",
            str(page),
            "--per-page",
            "30",
        ])
        if not isinstance(data, list):
            break
        pipelines.extend(item for item in data if isinstance(item, dict))
        if len(data) < 30:
            break
    return pipelines


def get_pipeline(pipeline_id: str) -> dict[str, Any]:
    """读取流水线详情。"""
    data = run_devops_json(["flow-get-pipeline", "--pipeline-id", pipeline_id])
    if not isinstance(data, dict):
        raise RuntimeError(f"流水线详情返回结构异常：pipelineId={pipeline_id}")
    return data


def find_exact_pipeline(pipelines: list[dict[str, Any]], name: str) -> dict[str, Any] | None:
    """从流水线列表中按名称精确匹配，优先使用创建时间最新的一条。"""
    matched = [item for item in pipelines if item.get("pipelineName") == name]
    if not matched:
        return None
    return sorted(matched, key=lambda item: int(item.get("createTime") or 0), reverse=True)[0]


def extract_project_options(pipeline_detail: dict[str, Any]) -> list[str]:
    """从流水线详情 settings.globalParams 中提取 project 下拉选项。"""
    settings_text = pipeline_detail.get("pipelineConfig", {}).get("settings")
    if not settings_text:
        return []
    settings = json.loads(settings_text)
    for param in settings.get("globalParams", []):
        if param.get("key") != "project":
            continue
        metadata = param.get("metaData")
        options = json.loads(metadata) if metadata else []
        return [item for item in options if item and not str(item).startswith("----")]
    return []


def update_client_pipelines(config: dict[str, Any], discovery: dict[str, Any], sync_result: dict[str, Any], max_pages: int) -> None:
    """同步 client 打包流水线配置。"""
    client_config = config.setdefault("clientPackage", {})
    framework_name = str(discovery["frameworkPipelineName"])
    framework_candidates = list_pipelines_by_name(str(discovery["frameworkSearchName"]), max_pages)
    framework = find_exact_pipeline(framework_candidates, framework_name)
    if framework:
        detail = get_pipeline(str(framework["pipelineId"]))
        framework_config = client_config.setdefault("frameworkPipeline", {})
        framework_config["name"] = framework["pipelineName"]
        framework_config["pipelineId"] = str(framework["pipelineId"])
        framework_config["projects"] = extract_project_options(detail)
        sync_result["frameworkPipeline"] = framework_config

    client_candidates = list_pipelines_by_name(str(discovery["clientSearchName"]), max_pages)
    pipelines_by_name = {pipeline.get("pipelineName"): pipeline for pipeline in client_candidates}
    java_service_pipelines: list[dict[str, Any]] = []
    for name in discovery["clientPipelineNames"]:
        pipeline = pipelines_by_name.get(name)
        if not pipeline:
            sync_result.setdefault("missingClientPipelines", []).append(name)
            continue
        detail = get_pipeline(str(pipeline["pipelineId"]))
        java_service_pipelines.append({
            "name": pipeline["pipelineName"],
            "pipelineId": str(pipeline["pipelineId"]),
            "projects": extract_project_options(detail),
            "envs": {
                "branch": "{branch}",
                "project": "{project}",
                "env": "{env}",
                "feishuId": "{feishuId}",
            },
        })
    if java_service_pipelines:
        client_config["javaServicePipelines"] = java_service_pipelines
        sync_result["javaServicePipelines"] = java_service_pipelines


def normalize_server_project(pipeline_name: str, pattern: str) -> str | None:
    """从 FAT server 流水线名称推断项目名。"""
    matched = re.match(pattern, pipeline_name)
    if not matched:
        return None
    return matched.group(1)


def update_server_pipelines(config: dict[str, Any], discovery: dict[str, Any], sync_result: dict[str, Any], max_pages: int) -> None:
    """同步 FAT server 部署流水线配置。"""
    server_config = config.setdefault("serverDeploy", {})
    projects = server_config.setdefault("projects", {})
    pipelines = list_pipelines_by_name(str(discovery["serverSearchName"]), max_pages)
    matched: dict[str, dict[str, str]] = {}
    for pipeline in pipelines:
        pipeline_name = str(pipeline.get("pipelineName") or "")
        project = normalize_server_project(pipeline_name, str(discovery["serverNamePattern"]))
        if not project:
            continue
        current = matched.get(project)
        if current and int(current.get("createTime") or 0) >= int(pipeline.get("createTime") or 0):
            continue
        matched[project] = {
            "name": pipeline_name,
            "pipelineId": str(pipeline.get("pipelineId")),
            "createTime": str(pipeline.get("createTime") or ""),
        }
    for project, pipeline in sorted(matched.items()):
        projects[project] = {
            "name": pipeline["name"],
            "pipelineId": pipeline["pipelineId"],
            "envs": {
                "branch": "{branch}",
                "env": "{env}",
            },
        }
    sync_result["serverProjects"] = projects


def select_frontend_pipeline(project: str, discovery: dict[str, Any], max_pages: int) -> tuple[dict[str, Any], dict[str, Any]] | None:
    """查找前端-FAT 分组中项目对应的 nodejs 流水线，优先选择非 mise 版本。"""
    exact_names = [str(template).format(project=project) for template in discovery["frontendNameTemplates"]]
    candidates = list_pipelines_by_name(exact_names[0], max_pages)
    for expected_name in exact_names:
        matched = [item for item in candidates if item.get("pipelineName") == expected_name]
        for pipeline in sorted(matched, key=lambda item: int(item.get("createTime") or 0), reverse=True):
            detail = get_pipeline(str(pipeline["pipelineId"]))
            if str(detail.get("groupId") or "") == str(discovery["frontendGroupId"]):
                return pipeline, detail
    return None


def update_frontend_pipelines(
    config: dict[str, Any],
    discovery: dict[str, Any],
    sync_result: dict[str, Any],
    max_pages: int,
    explicit_projects: list[str],
) -> None:
    """同步前端-FAT 分组中的项目部署流水线配置。"""
    frontend_config = config.setdefault("frontendDeploy", {})
    frontend_config.setdefault("groupId", str(discovery["frontendGroupId"]))
    projects_config = frontend_config.setdefault("projects", {})
    projects = explicit_projects or sorted(str(project) for project in projects_config)
    for project in projects:
        selected = select_frontend_pipeline(project, discovery, max_pages)
        if selected is None:
            sync_result.setdefault("missingFrontendPipelines", []).append(project)
            continue
        pipeline, _detail = selected
        project_config = projects_config.setdefault(project, {})
        project_config.update(
            {
                "name": pipeline["pipelineName"],
                "pipelineId": str(pipeline["pipelineId"]),
                "envs": {
                    "branch": "{branch}",
                    "project": "{project}",
                    "envName": "{envName}",
                    "feishuId": "{feishuId}",
                },
            }
        )
        sync_result.setdefault("frontendProjects", {})[project] = project_config


def main() -> None:
    """执行配置同步主流程。"""
    args = parse_args()
    require_yunxiao_runtime()
    config_path = Path(args.config)
    document = load_config(config_path)
    config = document.get("fatFlow")
    if not isinstance(config, dict):
        raise ValueError("全局默认配置缺少 fatFlow")
    discovery = config.get("pipelineDiscovery")
    if not isinstance(discovery, dict):
        raise ValueError("fatFlow 缺少 pipelineDiscovery")
    sync_result: dict[str, Any] = {}
    update_client_pipelines(config, discovery, sync_result, args.max_pages)
    update_frontend_pipelines(config, discovery, sync_result, args.max_pages, args.frontend_project)
    update_server_pipelines(config, discovery, sync_result, args.max_pages)
    document["fatFlow"] = config
    write_json(config_path, document)
    write_json(Path(args.output), sync_result)
    print(f"已同步配置：{config_path}")
    print(f"同步结果：{args.output}")


if __name__ == "__main__":
    main()
