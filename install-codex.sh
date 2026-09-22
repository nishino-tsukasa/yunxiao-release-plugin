#!/usr/bin/env bash

set -euo pipefail

readonly REPOSITORY='https://github.com/FlyAboveGrass/yunxiao-release-plugin.git'
readonly RAW_BASE='https://raw.githubusercontent.com/FlyAboveGrass/yunxiao-release-plugin/main/plugins/yunxiao-release/scripts'
readonly MARKETPLACE='yunxiao-release-community'
readonly PLUGIN='yunxiao-release'
readonly CODEX_INSTALL_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-}")" && pwd)"

prepare_script() {
  local script_name="$1" temporary_dir="$2"
  local bundled_dir="$CODEX_INSTALL_ROOT/plugins/yunxiao-release/scripts"
  if [[ -f "$bundled_dir/$script_name" ]]; then
    printf '%s\n' "$bundled_dir/$script_name"
    return
  fi
  command -v curl >/dev/null || { echo '缺少命令：curl' >&2; return 1; }
  curl -fsSL "$RAW_BASE/$script_name" -o "$temporary_dir/$script_name"
  printf '%s\n' "$temporary_dir/$script_name"
}

# 已配置来源正常升级；仅在 CLI 明确报告失联缓存冲突时清理并重试。
configure_marketplace() {
  local marketplace_list
  if ! marketplace_list="$(codex plugin marketplace list)"; then
    return 1
  fi
  if awk -v target="$MARKETPLACE" 'NR > 1 && $1 == target { found = 1 } END { exit !found }' <<<"$marketplace_list"; then
    codex plugin marketplace upgrade "$MARKETPLACE"
    return
  fi

  local add_output
  if add_output="$(codex plugin marketplace add "$REPOSITORY" --ref main 2>&1)"; then
    [[ -z "$add_output" ]] || printf '%s\n' "$add_output"
    return
  fi
  if [[ "$add_output" != *"already added from a different source"* ]]; then
    printf '%s\n' "$add_output" >&2
    return 1
  fi

  echo "检测到未注册的 $MARKETPLACE 缓存，正在清理并重新添加。"
  codex plugin marketplace remove "$MARKETPLACE"
  codex plugin marketplace add "$REPOSITORY" --ref main
}

# 检测固定全局路径中的云效 Token；仅在缺失时通过终端隐藏输入。
configure_token() {
  local token_script="$1"
  local check_output
  local check_status=0
  check_output="$(node "$token_script" --check 2>&1)" || check_status=$?
  if [[ "$check_status" -eq 0 ]]; then
    echo '检测到 YUNXIAO_ACCESS_TOKEN 已存在，跳过输入。'
    return
  fi
  if [[ "$check_status" -ne 1 ]]; then
    if [[ -n "$check_output" ]]; then
      printf '%s\n' "$check_output" >&2
    else
      echo '检查 YUNXIAO_ACCESS_TOKEN 时发生错误' >&2
    fi
    return "$check_status"
  fi

  local access_token
  printf '请输入 YUNXIAO_ACCESS_TOKEN（输入不可见）：' >&2
  IFS= read -r -s access_token
  printf '\n' >&2
  [[ -n "$access_token" ]] || { echo 'Token 不能为空' >&2; exit 1; }
  printf '%s' "$access_token" | node "$token_script"
}

# 主流程依次验证环境、配置 Token、安装插件并初始化当前 Git 项目。
main() {
  for command in git node codex; do
    command -v "$command" >/dev/null || { echo "缺少命令：$command" >&2; exit 1; }
  done
  node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)" || {
    echo '需要 Node.js 20 或更高版本' >&2
    exit 1
  }

  git rev-parse --show-toplevel >/dev/null 2>&1 || { echo '请在 Git 项目内执行安装命令' >&2; exit 1; }
  [[ -r /dev/tty ]] || { echo '安装需要交互式终端' >&2; exit 1; }

  readonly TEMP_DIR="$(mktemp -d)"
  trap 'rm -rf "$TEMP_DIR"' EXIT
  local token_script project_script
  token_script="$(prepare_script configure-token.mjs "$TEMP_DIR")"
  project_script="$(prepare_script configure-project.mjs "$TEMP_DIR")"

  configure_token "$token_script" </dev/tty

  configure_marketplace
  codex plugin add "$PLUGIN@$MARKETPLACE"

  readonly PROJECT_ROOT="$(git rev-parse --show-toplevel)"
  (cd "$PROJECT_ROOT" && node "$project_script" --ignore-only)
}

if [[ -z "${BASH_SOURCE[0]:-}" || "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
