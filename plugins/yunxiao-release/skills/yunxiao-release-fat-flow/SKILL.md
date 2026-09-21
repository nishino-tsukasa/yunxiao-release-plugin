---
name: yunxiao-release-fat-flow
description: 对一个或多个前后端仓库执行 FAT Git Flow 和云效流水线部署。项目名包含 -web 时合入 develop 并发布前端；其他项目合入 fat/fat，并执行后端 client 打包与 server 部署。用户要求完整 FAT 发版、多项目后端发版或从业务分支继续发布时使用。
---

# FAT Git Flow 与部署

1. 确认用户指定的仓库和源分支；只处理明确范围。
2. 检查每个仓库是 Git 仓库且工作区干净。相关改动先按项目规则提交；混有无关改动时停止。
3. 按仓库名分类：包含 `-web` 的前端项目目标分支为 `develop`，其他后端项目为 `fat/fat`。
4. 展示仓库、源分支、目标分支及部署项目，获得远端写入和流水线触发的一次确认。
5. 执行 `<plugin-root>/scripts/fat-flow/run-full-fat-flow-deploy.sh --branch <source> --repo <repo>...`。仅部署指定项目时使用 `--project`；只发布后端 server 时增加 `--server-only`。
6. 默认只报告最终 `RESULT` 或 `FAIL`；排障时增加 `--verbose`。

脚本校验提交信息、同步并推送源分支、合入目标分支，然后执行前端流水线、后端 client 打包和 server 部署。任何阶段失败即停止。

认证从 `~/.config/yunxiao-release/credentials.env` 读取；组织 ID 从全局项目配置的 `defaults.organizationId` 读取。流水线映射位于 `<plugin-root>/scripts/fat-flow/fat-pipeline-config.json`。
