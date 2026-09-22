#!/usr/bin/env bash

set -euo pipefail

readonly ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly TEST_DIR="$(mktemp -d)"
trap 'rm -rf "$TEST_DIR"' EXIT

source "$ROOT_DIR/install.sh"

if ! grep -Fq '用户名称（真实名字）：' "$ROOT_DIR/plugins/yunxiao-release/skills/yunxiao-release-01-configure/SKILL.md"; then
  echo '成员配置必须明确提示用户名称（真实名字）' >&2
  exit 1
fi

# 发版步骤 Skill 使用编号稳定排序；可随时调用的环境发布 Skill 不使用编号。
readonly EXPECTED_SKILLS=(
  yunxiao-release-01-configure
  yunxiao-release-02-prepare-mr
  yunxiao-release-03-sync-comments
  yunxiao-release-04-fix-review-comments
  yunxiao-release-05-finalize
  yunxiao-release-deploy-environment
  yunxiao-release-deploy-multi-repository
)
actual_skill_count="$(find "$ROOT_DIR/plugins/yunxiao-release/skills" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
if [[ "$actual_skill_count" -ne "${#EXPECTED_SKILLS[@]}" ]]; then
  echo "Skill 数量与阶段清单不一致: $actual_skill_count" >&2
  exit 1
fi
for skill_name in "${EXPECTED_SKILLS[@]}"; do
  skill_file="$ROOT_DIR/plugins/yunxiao-release/skills/$skill_name/SKILL.md"
  if [[ ! -f "$skill_file" ]] || ! grep -Fqx "name: $skill_name" "$skill_file"; then
    echo "Skill 阶段名称或目录不匹配: $skill_name" >&2
    exit 1
  fi
done

if grep -Eq 'codex -C|claude "/plugin configure|claude "\$prompt"' \
  "$ROOT_DIR/install.sh" "$ROOT_DIR/install-codex.sh" "$ROOT_DIR/install-claude.sh"; then
  echo '安装脚本不得自动启动 Codex 或 Claude Code 交互配置' >&2
  exit 1
fi

resolved_installer="$(resolve_installer install-codex.sh "$TEST_DIR")"
if [[ "$resolved_installer" != "$ROOT_DIR/install-codex.sh" ]]; then
  echo '本地安装包必须复用包内同版本脚本' >&2
  exit 1
fi

printf '\n' >"$TEST_DIR/checkbox-keys"
if [[ "$(choose_installers "$TEST_DIR/checkbox-keys" 2>/dev/null)" != $'install-codex.sh\ninstall-claude.sh' ]]; then
  echo '复选框默认选中的宿主不符合预期' >&2
  exit 1
fi

printf ' \n' >"$TEST_DIR/checkbox-keys"
if [[ "$(choose_installers "$TEST_DIR/checkbox-keys" 2>/dev/null)" != 'install-claude.sh' ]]; then
  echo '复选框没有按空格切换当前宿主' >&2
  exit 1
fi

printf '\033[B \n' >"$TEST_DIR/checkbox-keys"
set +e
checkbox_selection="$(choose_installers "$TEST_DIR/checkbox-keys" 2>/dev/null)"
checkbox_status=$?
set -e
if [[ "$checkbox_status" -ne 0 || "$checkbox_selection" != 'install-codex.sh' ]]; then
  echo '复选框没有按方向键移动当前项' >&2
  exit 1
fi

printf 'q' >"$TEST_DIR/checkbox-keys"
set +e
choose_installers "$TEST_DIR/checkbox-keys" >/dev/null 2>&1
checkbox_status=$?
set -e
if [[ "$checkbox_status" -ne 130 ]]; then
  echo '复选框取消操作没有停止安装' >&2
  exit 1
fi

source "$ROOT_DIR/install-codex.sh"

if [[ "$(prepare_script configure-project.mjs "$TEST_DIR")" != "$ROOT_DIR/plugins/yunxiao-release/scripts/configure-project.mjs" ]]; then
  echo 'Codex 安装必须优先复用包内配置脚本' >&2
  exit 1
fi

MOCK_MODE='stale'

# 模拟 Codex CLI 的四类状态，并记录调用顺序以验证清理边界。
codex() {
  printf '%s\n' "$*" >>"$TEST_DIR/calls"
  case "$*" in
    'plugin marketplace list')
      if [[ "$MOCK_MODE" == 'list-error' ]]; then
        echo 'Error: failed to list marketplaces' >&2
        return 1
      fi
      [[ "$MOCK_MODE" == 'configured' ]] && printf 'MARKETPLACE ROOT\n%s /tmp/source\n' "$MARKETPLACE"
      return 0
      ;;
    'plugin marketplace upgrade yunxiao-release-community')
      printf 'Upgraded marketplace.\n'
      ;;
    'plugin marketplace add https://github.com/FlyAboveGrass/yunxiao-release-plugin.git --ref main')
      if [[ "$MOCK_MODE" == 'stale' && ! -f "$TEST_DIR/retried" ]]; then
        touch "$TEST_DIR/retried"
        echo "Error: marketplace '$MARKETPLACE' is already added from a different source; remove it before adding this source" >&2
        return 1
      fi
      if [[ "$MOCK_MODE" == 'network-error' ]]; then
        echo 'Error: failed to clone marketplace' >&2
        return 1
      fi
      printf 'Added marketplace.\n'
      ;;
    'plugin marketplace remove yunxiao-release-community')
      printf 'Removed marketplace.\n'
      ;;
    *)
      echo "未预期的 Codex 调用: $*" >&2
      return 1
      ;;
  esac
}

if ! configure_marketplace; then
  echo '残留 marketplace 应自动恢复，但安装仍然失败' >&2
  exit 1
fi

expected_calls=$'plugin marketplace list\nplugin marketplace add https://github.com/FlyAboveGrass/yunxiao-release-plugin.git --ref main\nplugin marketplace remove yunxiao-release-community\nplugin marketplace add https://github.com/FlyAboveGrass/yunxiao-release-plugin.git --ref main'
actual_calls="$(<"$TEST_DIR/calls")"
if [[ "$actual_calls" != "$expected_calls" ]]; then
  printf '调用顺序不符合预期：\n%s\n' "$actual_calls" >&2
  exit 1
fi

: >"$TEST_DIR/calls"
MOCK_MODE='configured'
configure_marketplace
expected_calls=$'plugin marketplace list\nplugin marketplace upgrade yunxiao-release-community'
actual_calls="$(<"$TEST_DIR/calls")"
if [[ "$actual_calls" != "$expected_calls" ]]; then
  printf '已配置 marketplace 的调用顺序不符合预期：\n%s\n' "$actual_calls" >&2
  exit 1
fi

: >"$TEST_DIR/calls"
MOCK_MODE='network-error'
if configure_marketplace 2>"$TEST_DIR/network-error-output"; then
  echo '普通添加错误必须原样失败' >&2
  exit 1
fi
if [[ "$(<"$TEST_DIR/network-error-output")" != 'Error: failed to clone marketplace' ]]; then
  echo '普通添加错误没有原样返回' >&2
  exit 1
fi
expected_calls=$'plugin marketplace list\nplugin marketplace add https://github.com/FlyAboveGrass/yunxiao-release-plugin.git --ref main'
actual_calls="$(<"$TEST_DIR/calls")"
if [[ "$actual_calls" != "$expected_calls" ]]; then
  printf '普通错误不应触发清理：\n%s\n' "$actual_calls" >&2
  exit 1
fi

: >"$TEST_DIR/calls"
MOCK_MODE='list-error'
if configure_marketplace 2>"$TEST_DIR/list-error-output"; then
  echo 'marketplace 列表失败时必须停止安装' >&2
  exit 1
fi
if [[ "$(<"$TEST_DIR/list-error-output")" != 'Error: failed to list marketplaces' ]]; then
  echo 'marketplace 列表错误没有原样返回' >&2
  exit 1
fi
actual_calls="$(<"$TEST_DIR/calls")"
if [[ "$actual_calls" != 'plugin marketplace list' ]]; then
  printf '列表失败不应触发其他操作：\n%s\n' "$actual_calls" >&2
  exit 1
fi

export CODEX_HOME="$TEST_DIR/codex-home"
export XDG_CONFIG_HOME="$TEST_DIR/xdg-config"
mkdir -p "$CODEX_HOME"
printf 'YUNXIAO_ACCESS_TOKEN=existing-token\n' >"$CODEX_HOME/.env"
token_output="$(configure_token "$ROOT_DIR/plugins/yunxiao-release/scripts/configure-token.mjs")"
if [[ "$token_output" != '检测到 YUNXIAO_ACCESS_TOKEN 已存在，跳过输入。' ]]; then
  echo '已配置 Token 时必须跳过重复输入' >&2
  exit 1
fi

node() {
  echo 'simulated token check failure' >&2
  return 2
}
if configure_token ignored 2>"$TEST_DIR/token-check-error"; then
  echo 'Token 检查异常时必须停止安装' >&2
  exit 1
else
  check_status=$?
fi
unset -f node
if [[ "$check_status" -ne 2 || "$(<"$TEST_DIR/token-check-error")" != 'simulated token check failure' ]]; then
  echo 'Token 检查异常没有保留状态和错误信息' >&2
  exit 1
fi

rm -rf "$CODEX_HOME"
mkdir -p "$CODEX_HOME"
rm -f "$XDG_CONFIG_HOME/yunxiao-release/credentials.env"
# 标准输入模拟首次写入并验证输出不含 Token；终端隐藏参数和 /dev/tty 重定向另行锁定。
token_output="$(configure_token "$ROOT_DIR/plugins/yunxiao-release/scripts/configure-token.mjs" <<<'first-secret-token' 2>&1)"
if [[ "$token_output" == *'first-secret-token'* ]]; then
  echo 'Token 输入不应回显到终端' >&2
  exit 1
fi
if [[ -e "$CODEX_HOME/.env" ]]; then
  echo '首次输入的 Token 不应写入账号相关 Codex Home' >&2
  exit 1
fi
if [[ "$(<"$XDG_CONFIG_HOME/yunxiao-release/credentials.env")" != 'YUNXIAO_ACCESS_TOKEN=first-secret-token' ]]; then
  echo '首次输入的 Token 没有正确写入全局凭据文件' >&2
  exit 1
fi
if ! grep -Fq 'IFS= read -r -s access_token' "$ROOT_DIR/install-codex.sh"; then
  echo 'Token 必须使用隐藏输入模式读取' >&2
  exit 1
fi
if ! grep -Fq 'configure_token "$token_script" </dev/tty' "$ROOT_DIR/install-codex.sh"; then
  echo 'curl 管道安装时 Token 必须从控制终端读取' >&2
  exit 1
fi

piped_output="$(sed 's/^  main "$@"$/  printf "piped main invoked\\n"/' "$ROOT_DIR/install-codex.sh" | bash)"
if [[ "$piped_output" != 'piped main invoked' ]]; then
  echo '通过 curl 管道执行时必须进入主流程' >&2
  exit 1
fi

printf 'install tests passed\n'
