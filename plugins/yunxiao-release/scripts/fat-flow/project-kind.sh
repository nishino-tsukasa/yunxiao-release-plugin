#!/usr/bin/env bash

# 名称包含 -web 的仓库统一按前端处理；其余仓库按后端处理。
is_frontend_repo() {
  [[ "$(basename "$1")" == *-web* ]]
}
