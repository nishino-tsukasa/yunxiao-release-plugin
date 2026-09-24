---
name: yunxiao-release-deploy-multi-repository
description: 编排两个及以上已配置 Git 仓库的 FAT 环境发布，按配置顺序推进分支、触发并等待前后端流水线。用户要求跨仓库、前后端联动或多项目 FAT 发版时使用；单仓库发布使用 yunxiao-release-deploy-environment。
---

# 多仓库 FAT 环境发布

1. 确认用户指定的至少两个仓库和源分支；只处理明确范围。仅有一个仓库时改用 `yunxiao-release-deploy-environment`。
2. 检查每个仓库是 Git 仓库且工作区干净。相关改动先按项目规则提交；混有无关改动时停止。
3. 对每个仓库读取 Release Configuration module 统一后的 `repository.remoteName`、`environments.<环境>`、可选 `git.commitMessagePattern`、`dependsOn`、`preflightMergeBranches` 和显式步骤条件；必要字段缺失时停止，不从仓库名称、目录名称或项目类型推断。选中的仓库形成依赖链时展示发布波次，发现环则停止。
4. 展示仓库、源分支、目标分支、部署项目和依赖波次，获得远端写入和流水线触发的一次确认。
5. 执行 `<plugin-root>/scripts/fat-flow/run-full-fat-flow-deploy.sh --branch <source> --repo <repo>...`。仅部署指定项目时使用 `--project`；只发布后端 server 时增加 `--server-only`。
6. 记录命令输出的 `resume_state`。流水线阶段失败后，使用相同仓库和源分支加 `--resume --state-file <resume_state>`；已失败的运行实例先核对云效状态，人工重试同一任务后可直接续跑，确需新实例时加 `--retry-failed`。续跑拒绝变化的远端环境分支或未知触发结果，不改写状态文件。默认只报告最终 `RESULT` 或 `FAIL`；排障时增加 `--verbose`。

脚本先校验完整发布计划与依赖环，再模拟显式配置的构建分支合并并检查冲突，之后校验提交信息、同步并推送源分支、合入目标分支。Planner 按依赖波次执行；每波次先前端、再后端 Client、最后 Server。Client 有多个等价候选时先查云效占用，选空闲流水线；均忙时等待或超时，不盲目触发。同一波次的不同流水线可并行，依赖项目完成后才进入调用方波次。任何阶段失败即停止。

认证从 `~/.config/yunxiao-release/credentials.env` 读取；仓库特定行为从全局仓库配置或项目配置的 `environments` 读取。旧 `projects.json` 中的 `fatFlow` 只作为兼容输入；新的 `global-defaults.json` 禁止保存项目映射。插件目录不保存组织或项目专属流水线信息。
