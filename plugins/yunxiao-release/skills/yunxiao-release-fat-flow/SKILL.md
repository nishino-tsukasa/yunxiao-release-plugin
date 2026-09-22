---
name: yunxiao-release-fat-flow
description: 按全局仓库配置对一个或多个仓库执行 FAT Git Flow 和云效流水线部署。用户要求完整 FAT 发版、多项目发版或从业务分支继续发布时使用。
---

# FAT Git Flow 与部署

1. 确认用户指定的仓库和源分支；只处理明确范围。
2. 检查每个仓库是 Git 仓库且工作区干净。相关改动先按项目规则提交；混有无关改动时停止。
3. 对每个仓库读取 Release Configuration module 统一后的 `repository.remoteName`、`environments.<环境>`、可选 `git.commitMessagePattern` 和显式步骤条件；必要字段缺失时停止，不从仓库名称、目录名称或项目类型推断。
4. 展示仓库、源分支、目标分支及部署项目，获得远端写入和流水线触发的一次确认。
5. 执行 `<plugin-root>/scripts/fat-flow/run-full-fat-flow-deploy.sh --branch <source> --repo <repo>...`。仅部署指定项目时使用 `--project`；只发布后端 server 时增加 `--server-only`。
6. 默认只报告最终 `RESULT` 或 `FAIL`；排障时增加 `--verbose`。

脚本校验提交信息、同步并推送源分支、合入目标分支，然后执行前端流水线、后端 client 打包和 server 部署。任何阶段失败即停止。

认证从 `~/.config/yunxiao-release/credentials.env` 读取；仓库特定行为从全局仓库配置或项目配置的 `environments` 读取。旧 `projects.json` 中的 `fatFlow` 只作为兼容输入；新的 `global-defaults.json` 禁止保存项目映射。插件目录不保存组织或项目专属流水线信息。
