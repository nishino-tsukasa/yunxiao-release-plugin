#!/usr/bin/env python3
"""云效脚本共用的 HTTP API、环境变量与认证预检工具。"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


DEFAULT_ORGANIZATION_ID = ""
YUNXIAO_OPENAPI_DOMAIN = "openapi-rdc.aliyuncs.com"
YUNXIAO_OPENAPI_BASE_URL = f"https://{YUNXIAO_OPENAPI_DOMAIN}"


def config_home() -> Path:
    """返回与 Codex/Claude 账号无关的用户级配置目录。"""
    configured = os.environ.get("XDG_CONFIG_HOME")
    return Path(configured).expanduser() if configured and Path(configured).is_absolute() else Path.home() / ".config"


def read_global_defaults() -> dict[str, Any]:
    path = config_home() / "yunxiao-release" / "global-defaults.json"
    if not path.exists():
        return {}
    data = json.loads(path.read_text(encoding="utf-8"))
    return {key: value for key, value in data.items() if key != "schemaVersion"}


def read_global_token() -> str | None:
    path = config_home() / "yunxiao-release" / "credentials.env"
    if not path.exists():
        return None
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("YUNXIAO_ACCESS_TOKEN="):
            return line.partition("=")[2].strip() or None
    return None


def run_zsh(command: str) -> subprocess.CompletedProcess[str]:
    """统一通过 zsh -ic 执行命令，兼容用户把环境变量写在 zshrc 里。"""
    return subprocess.run(["zsh", "-ic", command], text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)


def read_exported_env(name: str) -> str | None:
    """读取当前进程或 zsh 导出的环境变量值。"""
    if os.environ.get(name):
        return str(os.environ[name])
    proc = run_zsh(f"env | grep -E '^{name}=' | sed 's/^[^=]*=//' | head -n 1")
    value = proc.stdout.strip()
    return value or None


def is_exported_env_present(name: str) -> bool:
    """判断环境变量是否已被 export，避免误把 shell 局部变量当成可用配置。"""
    if os.environ.get(name):
        return True
    proc = run_zsh(f"env | grep -q '^{name}='")
    return proc.returncode == 0


def resolve_organization_id() -> str:
    """读取组织 ID；未配置时回退到组织统一默认值。"""
    configured = read_exported_env("YUNXIAO_ORGANIZATION_ID")
    return configured or str(read_global_defaults().get("organizationId") or DEFAULT_ORGANIZATION_ID)


def resolve_access_token() -> str:
    """读取云效个人访问令牌，并在缺失时给出明确错误。"""
    token = read_global_token() or read_exported_env("YUNXIAO_ACCESS_TOKEN")
    if token:
        return token
    raise RuntimeError(
        "缺少全局凭据或已导出的 YUNXIAO_ACCESS_TOKEN。请先运行配置 Skill；"
        "token 获取路径：云效 / Codeup -> 个人设置 -> 个人访问令牌。"
    )


def classify_http_failure(status_code: int, body_text: str) -> str:
    """把常见 HTTP 失败原因翻译成更贴近同事排障习惯的提示。"""
    normalized = body_text.strip()
    if "InvalidToken" in normalized or "token is invalid" in normalized.lower():
        return (
            "云效认证失败：InvalidToken。请检查 YUNXIAO_ACCESS_TOKEN 是否正确、未过期、复制完整，"
            "并确认使用的是云效 / Codeup 个人访问令牌。"
        )
    if "PermissionDenied" in normalized or "NoPermission" in normalized or "Forbidden" in normalized:
        return (
            "云效权限不足：token 有效但权限不够。请在个人访问令牌权限中把“流水线运行实例”开为“读写”，"
            "“流水线”的其余权限开为“只读”。"
        )
    if status_code == 401:
        return "云效认证失败：HTTP 401。请优先检查 YUNXIAO_ACCESS_TOKEN 是否正确并已生效。"
    if status_code == 403:
        return "云效权限不足：HTTP 403。请检查 token 是否属于当前组织成员，并确认流水线相关权限配置正确。"
    if status_code == 404:
        return "云效资源不存在：HTTP 404。请检查 organizationId、pipelineId 或 pipelineRunId 是否正确。"
    if normalized:
        return f"云效接口调用失败：HTTP {status_code} {normalized}"
    return f"云效接口调用失败：HTTP {status_code}"


def build_flow_url(path: str, query: dict[str, str] | None = None) -> str:
    """拼装云效 Flow OpenAPI URL。"""
    rendered_query = f"?{urllib.parse.urlencode(query)}" if query else ""
    return f"{YUNXIAO_OPENAPI_BASE_URL}{path}{rendered_query}"


def decode_response_body(raw_body: bytes) -> str:
    """按响应头或 UTF-8 解码 HTTP 响应体。"""
    try:
        return raw_body.decode("utf-8")
    except UnicodeDecodeError:
        return raw_body.decode("utf-8", errors="replace")


def http_json_request(method: str, path: str, query: dict[str, str] | None = None, body: dict[str, Any] | None = None) -> Any:
    """调用云效 HTTP API 并解析 JSON 响应。"""
    token = resolve_access_token()
    url = build_flow_url(path, query)
    payload = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
    request = urllib.request.Request(
        url,
        data=payload,
        method=method,
        headers={
            "x-yunxiao-token": token,
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            response_text = decode_response_body(response.read()).strip()
            if not response_text:
                return {}
            return json.loads(response_text)
    except urllib.error.HTTPError as error:
        body_text = decode_response_body(error.read())
        raise RuntimeError(classify_http_failure(error.code, body_text)) from error
    except urllib.error.URLError as error:
        raise RuntimeError(f"访问云效 OpenAPI 失败：{error}") from error


def require_yunxiao_runtime() -> tuple[str, str]:
    """检查云效运行时依赖，保证执行前就暴露 token、组织和权限问题。"""
    organization_id = resolve_organization_id()
    if not organization_id:
        raise RuntimeError("缺少 organizationId，请在全局 defaults 或环境变量 YUNXIAO_ORGANIZATION_ID 中配置")
    resolve_access_token()
    http_json_request(
        "GET",
        f"/oapi/v1/flow/organizations/{organization_id}/pipelines",
        query={"page": "1", "perPage": "1"},
    )
    return YUNXIAO_OPENAPI_BASE_URL, organization_id


def _parse_option_value(args: list[str], option_name: str) -> str | None:
    """从旧的 devops 风格参数列表中读取单值选项。"""
    if option_name not in args:
        return None
    index = args.index(option_name)
    if index + 1 >= len(args):
        raise RuntimeError(f"缺少参数值：{option_name}")
    return args[index + 1]


def _http_completed_process(args: list[str], data: Any) -> subprocess.CompletedProcess[str]:
    """把 HTTP API 返回结果包装成与旧实现兼容的 CompletedProcess。"""
    if isinstance(data, (dict, list)):
        stdout = json.dumps(data, ensure_ascii=False)
    elif data in (None, ""):
        stdout = ""
    else:
        stdout = str(data)
    return subprocess.CompletedProcess(args=args, returncode=0, stdout=stdout, stderr="")


def _http_failed_process(args: list[str], error: Exception) -> subprocess.CompletedProcess[str]:
    """把异常包装成失败的 CompletedProcess，兼容旧调用方的错误处理。"""
    return subprocess.CompletedProcess(args=args, returncode=1, stdout="", stderr=str(error))


def _run_flow_list_pipelines(args: list[str]) -> Any:
    """执行获取流水线列表接口。"""
    organization_id = resolve_organization_id()
    pipeline_name = _parse_option_value(args, "--pipeline-name")
    page = _parse_option_value(args, "--page") or "1"
    per_page = _parse_option_value(args, "--per-page") or "30"
    query = {"page": page, "perPage": per_page}
    if pipeline_name:
        query["pipelineName"] = pipeline_name
    return http_json_request("GET", f"/oapi/v1/flow/organizations/{organization_id}/pipelines", query=query)


def _run_flow_get_pipeline(args: list[str]) -> Any:
    """执行获取流水线详情接口。"""
    organization_id = resolve_organization_id()
    pipeline_id = _parse_option_value(args, "--pipeline-id")
    if not pipeline_id:
        raise RuntimeError("flow-get-pipeline 缺少 --pipeline-id")
    return http_json_request("GET", f"/oapi/v1/flow/organizations/{organization_id}/pipelines/{pipeline_id}")


def _run_flow_create_pipeline_run(args: list[str]) -> Any:
    """执行运行流水线接口。"""
    organization_id = resolve_organization_id()
    pipeline_id = _parse_option_value(args, "--pipeline-id")
    params = _parse_option_value(args, "--params") or ""
    if not pipeline_id:
        raise RuntimeError("flow-create-pipeline-run 缺少 --pipeline-id")
    result = http_json_request(
        "POST",
        f"/oapi/v1/flow/organizations/{organization_id}/pipelines/{pipeline_id}/runs",
        body={"params": params},
    )
    if isinstance(result, dict) and result.get("pipelineRunId") not in (None, ""):
        return int(result["pipelineRunId"])
    return result


def _run_flow_get_pipeline_run(args: list[str]) -> Any:
    """执行获取流水线运行实例详情接口。"""
    organization_id = resolve_organization_id()
    pipeline_id = _parse_option_value(args, "--pipeline-id")
    pipeline_run_id = _parse_option_value(args, "--pipeline-run-id")
    if not pipeline_id:
        raise RuntimeError("flow-get-pipeline-run 缺少 --pipeline-id")
    if not pipeline_run_id:
        raise RuntimeError("flow-get-pipeline-run 缺少 --pipeline-run-id")
    return http_json_request(
        "GET",
        f"/oapi/v1/flow/organizations/{organization_id}/pipelines/{pipeline_id}/runs/{pipeline_run_id}",
    )


def _run_flow_list_pipeline_runs(args: list[str]) -> Any:
    """按状态查询指定流水线的运行实例。"""
    organization_id = resolve_organization_id()
    pipeline_id = _parse_option_value(args, "--pipeline-id")
    if not pipeline_id:
        raise RuntimeError("flow-list-pipeline-runs 缺少 --pipeline-id")
    query = {"page": "1", "perPage": "30"}
    status = _parse_option_value(args, "--status")
    if status:
        query["status"] = status
    return http_json_request(
        "GET",
        f"/oapi/v1/flow/organizations/{organization_id}/pipelines/{pipeline_id}/runs",
        query=query,
    )


def run_devops(args: list[str]) -> subprocess.CompletedProcess[str]:
    """兼容旧的 devops 调用签名，但底层改为直连云效 HTTP API。"""
    try:
        command = args[0] if args else ""
        if command == "flow-list-pipelines":
            return _http_completed_process(args, _run_flow_list_pipelines(args))
        if command == "flow-get-pipeline":
            return _http_completed_process(args, _run_flow_get_pipeline(args))
        if command == "flow-create-pipeline-run":
            return _http_completed_process(args, _run_flow_create_pipeline_run(args))
        if command == "flow-get-pipeline-run":
            return _http_completed_process(args, _run_flow_get_pipeline_run(args))
        if command == "flow-list-pipeline-runs":
            return _http_completed_process(args, _run_flow_list_pipeline_runs(args))
        raise RuntimeError(f"暂不支持的云效命令：{' '.join(args)}")
    except Exception as error:
        return _http_failed_process(args, error)


def parse_args() -> argparse.Namespace:
    """解析脚本自检参数。"""
    parser = argparse.ArgumentParser(description="云效 HTTP API 运行时自检工具。")
    parser.add_argument("--check", action="store_true", help="执行环境与权限自检。")
    return parser.parse_args()


def main() -> None:
    """支持在 shell 中直接执行运行时自检。"""
    args = parse_args()
    if not args.check:
        print("请使用 --check 执行环境自检。", file=sys.stderr)
        sys.exit(2)
    endpoint, organization_id = require_yunxiao_runtime()
    print(f"RESULT status=success endpoint={endpoint} organizationId={organization_id}")


if __name__ == "__main__":
    main()
