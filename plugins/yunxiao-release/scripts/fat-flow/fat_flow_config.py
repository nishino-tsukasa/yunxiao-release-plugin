#!/usr/bin/env python3
"""Load organization-specific FAT settings from the global release configuration."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
from pathlib import Path
from typing import Any
from urllib.parse import urlparse
import re


def config_home() -> Path:
    configured = os.environ.get("XDG_CONFIG_HOME")
    return Path(configured).expanduser() if configured and Path(configured).is_absolute() else Path.home() / ".config"


def default_paths() -> tuple[Path, Path]:
    root = config_home() / "yunxiao-release"
    return root / "global-defaults.json", root / "global-repositories.json"


def normalize_remote_url(value: str) -> str | None:
    remote = value.strip().rstrip("/").removesuffix(".git")
    matched = re.match(r"^[^@\s]+@([^:\s]+):(.+)$", remote)
    if matched:
        return f"{matched.group(1).lower()}/{matched.group(2).lstrip('/')}"
    parsed = urlparse(remote)
    if parsed.hostname:
        return f"{parsed.hostname.lower()}/{parsed.path.lstrip('/')}"
    return None


def load_config(defaults_path: Path | None = None, repositories_path: Path | None = None) -> dict[str, Any]:
    default_defaults, default_repositories = default_paths()
    defaults_path = defaults_path or default_defaults
    repositories_path = repositories_path or default_repositories
    defaults = json.loads(defaults_path.read_text(encoding="utf-8"))
    repositories_doc = json.loads(repositories_path.read_text(encoding="utf-8"))
    fat_flow = defaults.get("fatFlow")
    repositories = repositories_doc.get("repositories")
    if not isinstance(fat_flow, dict):
        raise ValueError(f"全局默认配置缺少 fatFlow：{defaults_path}")
    if not isinstance(repositories, dict):
        raise ValueError(f"全局仓库配置缺少 repositories：{repositories_path}")
    by_project: dict[str, dict[str, Any]] = {}
    for repository_key, repository in repositories.items():
        project = repository_key.rsplit("/", 1)[-1]
        if project in by_project:
            raise ValueError(f"仓库项目名不唯一，必须使用 remote 定位：{project}")
        by_project[project] = {"repositoryKey": repository_key, **repository}
    return {**fat_flow, "_repositories": repositories, "_repositoriesByProject": by_project}


def project_config(project: str, config: dict[str, Any]) -> dict[str, Any]:
    value = config.get("_repositoriesByProject", {}).get(project)
    if not isinstance(value, dict):
        raise ValueError(f"全局仓库配置未登记项目：{project}")
    return value


def project_config_for_repo(repo: Path, config: dict[str, Any]) -> dict[str, Any]:
    remotes = subprocess.run(
        ["git", "remote"], cwd=repo, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False
    )
    matches: list[dict[str, Any]] = []
    for remote_name in remotes.stdout.splitlines():
        result = subprocess.run(
            ["git", "config", "--get", f"remote.{remote_name}.url"],
            cwd=repo, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
        )
        key = normalize_remote_url(result.stdout)
        repository = config.get("_repositories", {}).get(key) if key else None
        if isinstance(repository, dict):
            matches.append({"repositoryKey": key, **repository})
    if len(matches) == 1:
        return matches[0]
    if len(matches) > 1:
        raise ValueError(f"多个 Git remote 命中全局仓库配置：{repo}")
    return project_config(repo.name, config)


def needs_client_package(repo: Path, source_branch: str, config: dict[str, Any]) -> bool:
    repository = project_config_for_repo(repo, config)
    detection = repository.get("clientDetection")
    if not isinstance(detection, dict):
        raise ValueError(f"仓库缺少 clientDetection：{repository.get('repositoryKey')}")
    mode = detection.get("mode")
    if mode == "never":
        return False
    if mode == "always":
        return True
    if mode != "changed-paths":
        raise ValueError(f"不支持的 clientDetection.mode：{mode}")
    prefixes = detection.get("pathPrefixes")
    if not isinstance(prefixes, list) or not prefixes:
        raise ValueError("changed-paths 必须配置非空 pathPrefixes")
    remote = str(repository.get("remoteName") or "")
    target = str(repository.get("fatTargetBranch") or "")
    if not remote or not target:
        raise ValueError("changed-paths 必须配置 remoteName 和 fatTargetBranch")
    base = f"refs/remotes/{remote}/{target}"
    exists = subprocess.run(["git", "rev-parse", "--verify", "--quiet", base], cwd=repo, check=False)
    if exists.returncode != 0:
        raise ValueError(f"无法确定 Client 改动基准：{base}")
    changed = subprocess.run(
        ["git", "diff", "--name-only", f"{base}...{source_branch}"],
        cwd=repo, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
    )
    if changed.returncode != 0:
        raise ValueError(f"无法读取 Client 改动：{repo}")
    return any(any(path.startswith(str(prefix)) for prefix in prefixes) for path in changed.stdout.splitlines())


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["get", "needs-client"])
    parser.add_argument("--repo")
    parser.add_argument("--project")
    parser.add_argument("--field")
    parser.add_argument("--branch")
    args = parser.parse_args()
    config = load_config()
    repository = project_config_for_repo(Path(args.repo).resolve(), config) if args.repo else project_config(str(args.project), config)
    if args.command == "get":
        value: Any = repository
        for part in str(args.field or "").split("."):
            if not part or not isinstance(value, dict) or part not in value:
                raise ValueError(f"仓库配置缺少字段：{args.field}")
            value = value[part]
        print(json.dumps(value, ensure_ascii=False) if isinstance(value, (dict, list)) else value)
        return
    if not args.repo or not args.branch:
        raise ValueError("needs-client 必须提供 --repo 和 --branch")
    raise SystemExit(0 if needs_client_package(Path(args.repo).resolve(), args.branch, config) else 1)


if __name__ == "__main__":
    main()
