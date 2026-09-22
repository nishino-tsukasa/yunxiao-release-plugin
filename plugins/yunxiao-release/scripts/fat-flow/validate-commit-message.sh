#!/usr/bin/env bash

set -euo pipefail

TARGET_MESSAGE=""
TARGET_COMMIT=""
TARGET_REPO=""
TARGET_PATTERN=""

# 统一展示脚本用法，避免调用参数错误时难以排查。
usage() {
  cat <<'EOF'
Usage:
  validate-commit-message.sh --message "<commit-message>"
  validate-commit-message.sh --repo <repo-path> --commit <commit-id> --pattern <regex>
EOF
}

# 输出普通校验日志，便于上层 skill 直接复述结果。
log_info() {
  printf 'INFO %s\n' "$1"
}

# 输出失败日志，统一写入标准错误。
log_error() {
  printf 'ERROR %s\n' "$1" >&2
}

# 解析输入参数，仅支持直接校验 message 或读取指定 commit message 校验。
parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --message)
        TARGET_MESSAGE="$2"
        shift 2
        ;;
      --commit)
        TARGET_COMMIT="$2"
        shift 2
        ;;
      --repo)
        TARGET_REPO="$2"
        shift 2
        ;;
      --pattern)
        TARGET_PATTERN="$2"
        shift 2
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

  if [[ -n "$TARGET_MESSAGE" && -n "$TARGET_COMMIT" ]]; then
    log_error "不能同时传入 --message 和 --commit"
    exit 1
  fi

  if [[ -z "$TARGET_MESSAGE" && -z "$TARGET_COMMIT" ]]; then
    log_error "必须传入 --message 或 --commit"
    exit 1
  fi

  if [[ -n "$TARGET_COMMIT" && -z "$TARGET_REPO" ]]; then
    log_error "使用 --commit 时必须同时传入 --repo"
    exit 1
  fi
}

# 校验仓库目录，确保读取 commit message 时不会落到错误目录。
ensure_repo_exists() {
  if [[ "$(git -C "$TARGET_REPO" rev-parse --is-inside-work-tree 2>/dev/null || true)" != "true" ]]; then
    log_error "repo=${TARGET_REPO} 不是有效 Git 仓库"
    exit 1
  fi
}

# 读取某个 commit 的完整 message，供正则统一校验。
load_commit_message() {
  ensure_repo_exists
  TARGET_MESSAGE="$(git -C "$TARGET_REPO" log -1 --format=%B "$TARGET_COMMIT" 2>/dev/null || true)"
  if [[ -z "$TARGET_MESSAGE" ]]; then
    log_error "repo=${TARGET_REPO} commit=${TARGET_COMMIT} 无法读取提交信息"
    exit 1
  fi
}

# 使用与远程相同的正则表达式做硬校验，避免仅靠模型口头判断。
validate_message() {
  local validation_output
  validation_output="$(
    # Perl 不能依赖调用机器是否安装 C.UTF-8；显式解码提交信息，保证中文 scope 仍按 UTF-8 校验。
    LC_ALL=C LANG=C COMMIT_MESSAGE="$TARGET_MESSAGE" COMMIT_PATTERN="$TARGET_PATTERN" perl -e '
      use strict;
      use warnings;
      use utf8;
      use Encode qw(decode FB_CROAK);
      use open q(:std), q(:encoding(UTF-8));

      my $message;
      eval {
        $message = decode(q(UTF-8), $ENV{COMMIT_MESSAGE} // q{}, FB_CROAK);
        1;
      } or do {
        print "INVALID reason=invalid_utf8_message\n";
        exit 1;
      };
      my $pattern = decode(q(UTF-8), $ENV{COMMIT_PATTERN} // q{}, FB_CROAK);
      if ($pattern eq q{}) {
        print "INVALID reason=missing_pattern\n";
        exit 1;
      }
      my $regex = eval { qr/$pattern/s };
      if (!$regex) {
        print "INVALID reason=invalid_pattern\n";
        exit 1;
      }

      if ($message !~ /\S/) {
        print "INVALID reason=empty_message\n";
        exit 1;
      }

      if ($message !~ $regex) {
        print "INVALID reason=regex_mismatch\n";
        exit 1;
      }

      my ($subject) = split /\n/, $message, 2;
      print "VALID subject=$subject\n";
    ' 2>&1
  )" || {
    printf '%s\n' "$validation_output" >&2
    return 1
  }

  printf '%s\n' "$validation_output"
}

# 主流程只负责参数解析、可选读取 commit message、执行正则校验。
main() {
  parse_args "$@"

  if [[ -n "$TARGET_COMMIT" ]]; then
    load_commit_message
    log_info "校验 commit=${TARGET_COMMIT}"
  else
    log_info "校验直接传入的提交信息"
  fi

  validate_message
}

main "$@"
