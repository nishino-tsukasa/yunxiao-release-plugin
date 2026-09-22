#!/usr/bin/env bash

set -euo pipefail

SCRIPT_STEP=""
SCRIPT_BRANCH=""
SCRIPT_REPOS=()
SCRIPT_PROJECTS=()
SCRIPT_CLIENT_PROJECTS=()
SCRIPT_MANUAL_CLIENT_PROJECTS=()
SCRIPT_SERVER_ONLY=0
SCRIPT_VERBOSE=0
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_FAT_FLOW_SCRIPT="${SCRIPT_DIR}/run-fat-flow.sh"
PLAN_DEPLOY_SCRIPT="${SCRIPT_DIR}/plan-changed-fat-flow.sh"
source "${SCRIPT_DIR}/project-kind.sh"

# 展示脚本用法，避免固定流程入口传参不完整时难以排查。
usage() {
  cat <<'EOF'
Usage:
  run-full-fat-flow-deploy.sh --branch <source-branch> --repo <repo-path> [--repo <repo-path> ...] [--verbose]
  run-full-fat-flow-deploy.sh --branch <source-branch> --project <project-name> [--project <project-name> ...] [--client-project <project-name> ...] [--verbose]
  run-full-fat-flow-deploy.sh --branch <source-branch> --project <project-name> [--project <project-name> ...] --server-only [--verbose]
EOF
}

# 输出普通流程日志，便于 skill 直接转述关键阶段。
log_info() {
  if [[ "$SCRIPT_VERBOSE" == "1" ]]; then
    printf 'INFO %s\n' "$1"
  fi
}

# 默认展示关键进度，避免静默模式隐藏 FAT 执行顺序和失败位置。
log_progress() {
  printf 'PROGRESS %s\n' "$1"
}

# 输出错误日志，统一写入标准错误。
log_error() {
  printf 'ERROR %s\n' "$1" >&2
}

# 把数组安全渲染成逗号分隔字符串，兼容 set -u 下的空数组场景。
join_csv() {
  if [[ $# -eq 0 ]]; then
    printf ''
    return
  fi
  local first="$1"
  shift || true
  printf '%s' "$first"
  if [[ $# -gt 0 ]]; then
    printf ',%s' "$@"
  fi
}

# 统一失败出口，保证最终有单行失败摘要可供 skill 读取。
fail() {
  local message="$1"
  printf 'FAIL status=failed step=%s branch=%s projects=%s message=%s\n' \
    "$SCRIPT_STEP" "$SCRIPT_BRANCH" "$(join_csv "${SCRIPT_PROJECTS[@]}")" "$message" >&2
  exit 1
}

# 解析命令行参数，支持按仓库执行完整 fat flow，或按项目直接部署。
parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --branch)
        SCRIPT_BRANCH="$2"
        shift 2
        ;;
      --repo)
        SCRIPT_REPOS+=("$2")
        shift 2
        ;;
      --project)
        SCRIPT_PROJECTS+=("$2")
        shift 2
        ;;
      --client-project)
        SCRIPT_MANUAL_CLIENT_PROJECTS+=("$2")
        shift 2
        ;;
      --server-only)
        SCRIPT_SERVER_ONLY=1
        shift
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

  if [[ -z "$SCRIPT_BRANCH" ]]; then
    log_error "必须提供 --branch"
    usage
    exit 1
  fi

  if [[ ${#SCRIPT_REPOS[@]} -gt 0 && ${#SCRIPT_PROJECTS[@]} -gt 0 ]]; then
    log_error "--repo 和 --project 不能混用"
    usage
    exit 1
  fi

  if [[ ${#SCRIPT_REPOS[@]} -eq 0 && ${#SCRIPT_PROJECTS[@]} -eq 0 ]]; then
    log_error "必须至少提供一个 --repo 或 --project"
    usage
    exit 1
  fi

  if [[ "$SCRIPT_SERVER_ONLY" == "1" && ${#SCRIPT_MANUAL_CLIENT_PROJECTS[@]} -gt 0 ]]; then
    log_error "--server-only 与 --client-project 不能同时使用"
    usage
    exit 1
  fi
}

# 校验依赖脚本存在，避免运行到中途才暴露环境问题。
ensure_scripts_exist() {
  SCRIPT_STEP="verify_scripts"
  if [[ ! -x "$RUN_FAT_FLOW_SCRIPT" ]]; then
    fail "run-fat-flow.sh 不存在或不可执行"
  fi
  if [[ ! -x "$PLAN_DEPLOY_SCRIPT" ]]; then
    fail "plan-changed-fat-flow.sh 不存在或不可执行"
  fi
}

# 校验 repo 参数并提前收敛出部署项目名，减少后续重复推断。
normalize_repos() {
  local repo
  SCRIPT_STEP="normalize_repos"
  SCRIPT_PROJECTS=()
  for repo in "${SCRIPT_REPOS[@]}"; do
    if [[ ! -d "$repo" ]]; then
      fail "仓库目录不存在: $repo"
    fi
    if [[ "$(git -C "$repo" rev-parse --is-inside-work-tree 2>/dev/null || true)" != "true" ]]; then
      fail "目标目录不是 Git 仓库: $repo"
    fi
    SCRIPT_PROJECTS+=("$(basename "$repo")")
  done
}

# 规范化项目模式输入，避免重复项目造成后续部署计划重复。
normalize_projects() {
  local project
  local unique_projects=()
  local unique_client_projects=()
  local project_key
  SCRIPT_STEP="normalize_projects"
  for project in "${SCRIPT_PROJECTS[@]}"; do
    if [[ -z "$project" ]]; then
      continue
    fi
    project_key=",${unique_projects[*]-},"
    if [[ "$project_key" != *",$project,"* ]]; then
      unique_projects+=("$project")
    fi
  done
  SCRIPT_PROJECTS=("${unique_projects[@]-}")
  for project in "${SCRIPT_MANUAL_CLIENT_PROJECTS[@]-}"; do
    if [[ -z "$project" ]]; then
      continue
    fi
    project_key=",${SCRIPT_PROJECTS[*]},"
    if [[ "$project_key" != *",$project,"* ]]; then
      fail "client 项目未包含在部署项目中: $project"
    fi
    project_key=",${unique_client_projects[*]-},"
    if [[ "$project_key" != *",$project,"* ]]; then
      unique_client_projects+=("$project")
    fi
  done
  SCRIPT_MANUAL_CLIENT_PROJECTS=("${unique_client_projects[@]-}")
}

# 判断仓库是否采用 monkey-*-client / monkey-*-server 的标准多模块结构。
repo_has_standard_client_server_layout() {
  local repo="$1"
  local entry
  for entry in "$repo"/monkey-*-client "$repo"/monkey-*-server; do
    if [[ -d "$entry" ]]; then
      return 0
    fi
  done
  return 1
}

# 依据项目名选择 FAT 发版目标分支；名称包含 -web 的前端项目合并到 develop，其他项目合并到 fat/fat。
resolve_target_branch_for_repo() {
  local repo="$1"
  if is_frontend_repo "$repo"; then
    printf 'develop\n'
  else
    printf 'fat/fat\n'
  fi
}

# 解析用于比较本次改动的基准分支，优先使用对应项目的远端发版分支。
resolve_diff_base_ref() {
  local repo="$1"
  local target_branch
  target_branch="$(resolve_target_branch_for_repo "$repo")"
  if git -C "$repo" rev-parse --verify --quiet "origin/${target_branch}" >/dev/null 2>&1; then
    printf 'origin/%s\n' "$target_branch"
    return 0
  fi
  if git -C "$repo" rev-parse --verify --quiet "$target_branch" >/dev/null 2>&1; then
    printf '%s\n' "$target_branch"
    return 0
  fi
  return 1
}

# 判断单个仓库本次是否真的改到了 client 模块。
repo_needs_client_package() {
  local repo="$1"
  local diff_base_ref
  local changed_files
  if is_frontend_repo "$repo"; then
    return 1
  fi
  if ! repo_has_standard_client_server_layout "$repo"; then
    return 0
  fi
  if ! diff_base_ref="$(resolve_diff_base_ref "$repo")"; then
    fail "无法确定 client 改动对比基准: $repo"
  fi
  if ! git -C "$repo" rev-parse --verify --quiet "$SCRIPT_BRANCH" >/dev/null 2>&1; then
    fail "源分支不存在，无法判断 client 改动: repo=$repo branch=$SCRIPT_BRANCH"
  fi
  changed_files="$(git -C "$repo" diff --name-only "${diff_base_ref}...${SCRIPT_BRANCH}")"
  if printf '%s\n' "$changed_files" | grep -Eq '^monkey-.*-client/'; then
    return 0
  fi
  return 1
}

# 在执行 fat flow 前预先确定哪些项目需要打 client，避免部署阶段再做推理。
collect_client_projects() {
  local repo
  SCRIPT_STEP="collect_client_projects"
  SCRIPT_CLIENT_PROJECTS=()
  if [[ "$SCRIPT_SERVER_ONLY" == "1" ]]; then
    return
  fi
  if [[ ${#SCRIPT_REPOS[@]} -eq 0 ]]; then
    if [[ ${#SCRIPT_MANUAL_CLIENT_PROJECTS[@]} -gt 0 ]]; then
      SCRIPT_CLIENT_PROJECTS=("${SCRIPT_MANUAL_CLIENT_PROJECTS[@]}")
      return
    fi
    SCRIPT_CLIENT_PROJECTS=("${SCRIPT_PROJECTS[@]}")
    return
  fi
  for repo in "${SCRIPT_REPOS[@]}"; do
    if repo_needs_client_package "$repo"; then
      SCRIPT_CLIENT_PROJECTS+=("$(basename "$repo")")
    fi
  done
}

# 要求上层在进入脚本前已经处理好自动提交，这里只接受干净仓库。
ensure_clean_repos() {
  local repo
  local status_output
  SCRIPT_STEP="verify_clean_repos"
  for repo in "${SCRIPT_REPOS[@]}"; do
    status_output="$(git -C "$repo" status --short)"
    if [[ -n "$status_output" ]]; then
      printf '%s\n' "$status_output" >&2
      fail "仓库工作树不干净: $repo"
    fi
  done
}

# 顺序执行每个仓库的 fat flow，保持与原有脚本的单仓语义一致。
run_git_fat_flow_for_each_repo() {
  local repo
  local output_file
  SCRIPT_STEP="run_git_fat_flow"
  if [[ ${#SCRIPT_REPOS[@]} -eq 0 ]]; then
    return
  fi
  for repo in "${SCRIPT_REPOS[@]}"; do
    log_info "开始执行仓库 FAT flow: repo=$repo branch=$SCRIPT_BRANCH"
    log_progress "stage=git-fat-flow status=started repo=$repo branch=$SCRIPT_BRANCH"
    if [[ "$SCRIPT_VERBOSE" == "1" ]]; then
      "$RUN_FAT_FLOW_SCRIPT" --repo "$repo" --branch "$SCRIPT_BRANCH" --verbose || fail "仓库 FAT flow 失败: $repo"
      continue
    fi
    output_file="$(mktemp)"
    if ! "$RUN_FAT_FLOW_SCRIPT" --repo "$repo" --branch "$SCRIPT_BRANCH" >"$output_file" 2>&1; then
      cat "$output_file" >&2
      rm -f "$output_file"
      fail "仓库 FAT flow 失败: $repo"
    fi
    rm -f "$output_file"
    log_progress "stage=git-fat-flow status=success repo=$repo branch=$SCRIPT_BRANCH"
  done
}

# 所有仓库完成后只触发一次部署，显式传项目名，避免脚本自行扫描本地目录。
run_single_deploy() {
  local projects_csv
  local client_projects_csv
  SCRIPT_STEP="run_deploy"
  projects_csv="$(join_csv "${SCRIPT_PROJECTS[@]}")"
  # 仅修改 server 时，client 项目集合为空是合法输入；显式传空值让下游跳过 client 阶段。
  client_projects_csv="$(join_csv "${SCRIPT_CLIENT_PROJECTS[@]-}")"
  log_info "开始执行统一 FAT 部署: projects=${projects_csv} clientProjects=${client_projects_csv:-none}"
  log_progress "stage=deploy status=started projects=${projects_csv} clientProjects=${client_projects_csv:-none} order=frontend-deploy-then-client-package-then-server-deploy"
  if [[ "$SCRIPT_VERBOSE" == "1" ]]; then
    "$PLAN_DEPLOY_SCRIPT" --projects "$projects_csv" --client-projects "$client_projects_csv" --run --verbose || fail "统一 FAT 部署失败"
    return
  fi
  if ! "$PLAN_DEPLOY_SCRIPT" --projects "$projects_csv" --client-projects "$client_projects_csv" --run; then
    fail "统一 FAT 部署失败，详见上方部署日志"
  fi
  log_progress "stage=deploy status=success projects=${projects_csv}"
}

# 成功收尾时输出单行结果，便于 skill 低成本总结。
finish_successfully() {
  local repos_csv
  local projects_csv
  SCRIPT_STEP="finish"
  repos_csv="$(join_csv "${SCRIPT_REPOS[@]-}")"
  projects_csv="$(join_csv "${SCRIPT_PROJECTS[@]}")"
  printf 'RESULT status=success branch=%s repos=%s projects=%s\n' \
    "$SCRIPT_BRANCH" "${repos_csv:-none}" "$projects_csv"
}

# 主流程只负责固定编排，不在这里加入额外推理逻辑。
main() {
  parse_args "$@"
  ensure_scripts_exist
  if [[ ${#SCRIPT_REPOS[@]} -gt 0 ]]; then
    normalize_repos
    ensure_clean_repos
  else
    normalize_projects
  fi
  collect_client_projects
  run_git_fat_flow_for_each_repo
  run_single_deploy
  finish_successfully
}

main "$@"
