#!/usr/bin/env bash

set -euo pipefail

SCRIPT_STEP=""
SCRIPT_REPO=""
SCRIPT_BRANCH=""
SCRIPT_ORIGINAL_BRANCH=""
SCRIPT_PROJECT_KIND=""
SCRIPT_TARGET_BRANCH=""
SCRIPT_VERBOSE=0
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VALIDATE_SCRIPT="${SCRIPT_DIR}/validate-commit-message.sh"
source "${SCRIPT_DIR}/project-kind.sh"

# 展示脚本用法，避免调用方传参错误时无从排查。
usage() {
  cat <<'EOF'
Usage:
  run-fat-flow.sh --repo <repo-path> --branch <source-branch> [--verbose]
EOF
}

# 输出普通流程日志，便于 skill 直接转述关键信息。
log_info() {
  if [[ "$SCRIPT_VERBOSE" == "1" ]]; then
    printf 'INFO %s\n' "$1"
  fi
}

# 输出错误日志，统一写入标准错误。
log_error() {
  printf 'ERROR %s\n' "$1" >&2
}

# 统一执行 git 命令，并把完整命令打印出来，方便失败时定位。
run_git() {
  local command_string
  command_string="$(printf 'git -C %q' "$SCRIPT_REPO")"
  for arg in "$@"; do
    command_string+=" $(printf '%q' "$arg")"
  done
  log_info "执行命令: ${command_string}"
  if [[ "$SCRIPT_VERBOSE" == "1" ]]; then
    git -C "$SCRIPT_REPO" "$@"
  else
    git -C "$SCRIPT_REPO" "$@" >/dev/null 2>&1
  fi
}

# 统一执行提交信息校验脚本，确保远程拒绝的 message 在本地就被拦住。
run_validator() {
  local command_string
  command_string="$(printf '%q' "$VALIDATE_SCRIPT")"
  for arg in "$@"; do
    command_string+=" $(printf '%q' "$arg")"
  done
  log_info "执行校验: ${command_string}"
  if [[ "$SCRIPT_VERBOSE" == "1" ]]; then
    "$VALIDATE_SCRIPT" "$@"
  else
    "$VALIDATE_SCRIPT" "$@" >/dev/null 2>&1
  fi
}

# 在脚本中途失败时，尽量把仓库切回最初分支，减少人工善后成本。
restore_branch_if_needed() {
  if [[ -n "$SCRIPT_ORIGINAL_BRANCH" ]]; then
    local current_branch
    current_branch="$(git -C "$SCRIPT_REPO" branch --show-current 2>/dev/null || true)"
    if [[ "$current_branch" != "$SCRIPT_ORIGINAL_BRANCH" ]]; then
      log_info "尝试切回原分支: ${SCRIPT_ORIGINAL_BRANCH}"
      git -C "$SCRIPT_REPO" checkout "$SCRIPT_ORIGINAL_BRANCH" >/dev/null 2>&1 || true
    fi
  fi
}

# 统一失败出口，保证错误信息格式一致，并优先尝试恢复现场。
fail() {
  local message="$1"
  restore_branch_if_needed
  printf 'FAIL status=failed step=%s repo=%s branch=%s message=%s\n' \
    "$SCRIPT_STEP" "$SCRIPT_REPO" "$SCRIPT_BRANCH" "$message" >&2
  exit 1
}

# 解析命令行参数，只接受 repo 和 branch 两个显式输入。
parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --repo)
        SCRIPT_REPO="$2"
        shift 2
        ;;
      --branch)
        SCRIPT_BRANCH="$2"
        shift 2
        ;;
      --verbose)
        SCRIPT_VERBOSE=1
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        log_error "未知参数: $1"
        usage
        exit 1
        ;;
    esac
  done

  if [[ -z "$SCRIPT_REPO" || -z "$SCRIPT_BRANCH" ]]; then
    log_error "必须同时提供 --repo 和 --branch"
    usage
    exit 1
  fi
}

# 校验目标目录存在且确实是 Git 仓库。
ensure_repo_exists() {
  SCRIPT_STEP="verify_repo"
  if [[ ! -d "$SCRIPT_REPO" ]]; then
    fail "仓库目录不存在"
  fi
  if [[ "$(git -C "$SCRIPT_REPO" rev-parse --is-inside-work-tree 2>/dev/null || true)" != "true" ]]; then
    fail "目标目录不是 Git 仓库"
  fi
  if [[ ! -x "$VALIDATE_SCRIPT" ]]; then
    fail "提交信息校验脚本不存在或不可执行"
  fi
}

# 依据仓库名识别项目类型；名称包含 -web 的项目走前端发版分支。
resolve_project_flow() {
  SCRIPT_STEP="resolve_project_flow"
  if is_frontend_repo "$SCRIPT_REPO"; then
    SCRIPT_PROJECT_KIND="frontend"
    SCRIPT_TARGET_BRANCH="develop"
  else
    SCRIPT_PROJECT_KIND="backend"
    SCRIPT_TARGET_BRANCH="fat/fat"
  fi
}

# 脚本只接管“已干净仓库”的固定流程，未提交改动交给上层 skill 判断。
ensure_clean_worktree() {
  SCRIPT_STEP="verify_clean_worktree"
  local status_output
  status_output="$(git -C "$SCRIPT_REPO" status --short)"
  if [[ -n "$status_output" ]]; then
    printf '%s\n' "$status_output" >&2
    fail "工作树不干净，脚本拒绝继续执行"
  fi
}

# 记录进入脚本时所在分支，后续成功或失败都尽量切回。
remember_original_branch() {
  SCRIPT_STEP="remember_original_branch"
  SCRIPT_ORIGINAL_BRANCH="$(git -C "$SCRIPT_REPO" branch --show-current)"
  if [[ -z "$SCRIPT_ORIGINAL_BRANCH" ]]; then
    fail "无法识别当前分支"
  fi
}

# 如果当前不在目标源分支，先切换到源分支再继续后续同步。
checkout_source_branch() {
  SCRIPT_STEP="checkout_source_branch"
  if [[ "$SCRIPT_ORIGINAL_BRANCH" != "$SCRIPT_BRANCH" ]]; then
    run_git checkout "$SCRIPT_BRANCH" || fail "切换源分支失败"
  fi
}

# 推送源分支前先校验待推送 commit；如果远程分支还不存在，则至少校验当前 HEAD。
validate_source_branch_commits() {
  local commit_range
  local commit_list
  local commit_id

  SCRIPT_STEP="validate_source_branch_commits"

  if git -C "$SCRIPT_REPO" ls-remote --exit-code --heads origin "$SCRIPT_BRANCH" >/dev/null 2>&1; then
    commit_range="origin/${SCRIPT_BRANCH}..${SCRIPT_BRANCH}"
    commit_list="$(git -C "$SCRIPT_REPO" rev-list "$commit_range")"
    if [[ -z "$commit_list" ]]; then
      log_info "源分支没有待推送 commit，跳过源分支提交信息校验"
      return
    fi
  else
    commit_list="$(git -C "$SCRIPT_REPO" rev-parse HEAD)"
  fi

  while IFS= read -r commit_id; do
    [[ -z "$commit_id" ]] && continue
    run_validator --repo "$SCRIPT_REPO" --commit "$commit_id" --kind "$SCRIPT_PROJECT_KIND" || fail "源分支存在不合规提交信息: ${commit_id}"
  done <<< "$commit_list"
}

# 先同步源分支；如果远程不存在同名分支，则初始化 upstream 后再继续推送。
sync_source_branch() {
  SCRIPT_STEP="pull_source_branch"
  if git -C "$SCRIPT_REPO" ls-remote --exit-code --heads origin "$SCRIPT_BRANCH" >/dev/null 2>&1; then
    run_git pull --no-rebase origin "$SCRIPT_BRANCH" || fail "拉取同名源分支失败"
  else
    log_info "远程不存在同名源分支，将在提交信息校验通过后初始化 upstream"
  fi

  validate_source_branch_commits

  SCRIPT_STEP="push_source_branch"
  run_git push -u origin "$SCRIPT_BRANCH" || fail "推送源分支失败"
}

# 确保本地存在目标发版分支；如果不存在，则从远端目标分支建立跟踪分支。
ensure_target_branch_exists() {
  SCRIPT_STEP="ensure_target_branch"
  if git -C "$SCRIPT_REPO" show-ref --verify --quiet "refs/heads/${SCRIPT_TARGET_BRANCH}"; then
    return
  fi
  run_git fetch origin "$SCRIPT_TARGET_BRANCH" || fail "拉取远程 ${SCRIPT_TARGET_BRANCH} 失败"
  run_git checkout -B "$SCRIPT_TARGET_BRANCH" --track "origin/${SCRIPT_TARGET_BRANCH}" || fail "创建本地 ${SCRIPT_TARGET_BRANCH} 跟踪分支失败"
  run_git checkout "$SCRIPT_BRANCH" || fail "创建目标分支后切回源分支失败"
}

# 推送目标分支前校验本次待推送的 commit message，避免坏提交流向远端。
validate_target_branch_commits() {
  local commit_list
  local commit_id

  SCRIPT_STEP="validate_target_branch_commits"

  if git -C "$SCRIPT_REPO" ls-remote --exit-code --heads origin "$SCRIPT_TARGET_BRANCH" >/dev/null 2>&1; then
    commit_list="$(git -C "$SCRIPT_REPO" rev-list "origin/${SCRIPT_TARGET_BRANCH}..${SCRIPT_TARGET_BRANCH}")"
  else
    commit_list="$(git -C "$SCRIPT_REPO" rev-parse "$SCRIPT_TARGET_BRANCH")"
  fi

  if [[ -z "$commit_list" ]]; then
    log_info "${SCRIPT_TARGET_BRANCH} 没有待推送 commit，跳过目标分支提交信息校验"
    return
  fi

  while IFS= read -r commit_id; do
    [[ -z "$commit_id" ]] && continue
    run_validator --repo "$SCRIPT_REPO" --commit "$commit_id" --kind "$SCRIPT_PROJECT_KIND" || fail "${SCRIPT_TARGET_BRANCH} 存在不合规提交信息: ${commit_id}"
  done <<< "$commit_list"
}

# 切到目标发版分支，拉取最新代码，合并源分支并推送到远端。
merge_into_target() {
  SCRIPT_STEP="checkout_target_branch"
  run_git checkout "$SCRIPT_TARGET_BRANCH" || fail "切换 ${SCRIPT_TARGET_BRANCH} 失败"

  SCRIPT_STEP="pull_target_branch"
  run_git pull --no-rebase origin "$SCRIPT_TARGET_BRANCH" || fail "拉取 ${SCRIPT_TARGET_BRANCH} 失败"

  SCRIPT_STEP="merge_source_into_target"
  run_git merge --no-ff --no-edit "$SCRIPT_BRANCH" || fail "合并源分支到 ${SCRIPT_TARGET_BRANCH} 失败"

  validate_target_branch_commits

  SCRIPT_STEP="push_target_branch"
  run_git push origin "$SCRIPT_TARGET_BRANCH" || fail "推送 ${SCRIPT_TARGET_BRANCH} 失败"
}

# 成功收尾时切回源分支，并输出便于 skill 汇总的结果行。
finish_successfully() {
  SCRIPT_STEP="restore_source_branch"
  run_git checkout "$SCRIPT_BRANCH" || fail "成功后切回源分支失败"
  printf 'RESULT status=success repo=%s kind=%s source_branch=%s target_branch=%s final_branch=%s\n' \
    "$SCRIPT_REPO" "$SCRIPT_PROJECT_KIND" "$SCRIPT_BRANCH" "$SCRIPT_TARGET_BRANCH" "$SCRIPT_BRANCH"
}

# 主流程只负责串联固定步骤，不在这里混入额外推理逻辑。
main() {
  parse_args "$@"
  ensure_repo_exists
  resolve_project_flow
  ensure_clean_worktree
  remember_original_branch
  checkout_source_branch
  sync_source_branch
  ensure_target_branch_exists
  merge_into_target
  finish_successfully
}

main "$@"
