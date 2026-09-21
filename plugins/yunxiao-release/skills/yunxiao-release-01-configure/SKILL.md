---
name: yunxiao-release-01-configure
description: 初始化、更新或检查任意 Git 项目的云效发版配置、成员身份和 MR 评审人。用户提到初始化云效、配置 Token、检查 MCP 认证、切换成员、目标分支、评审人或发版配置缺失时使用。
---

# 云效发版配置

先阅读 [发版契约](../../references/release-contract.md) 和 [MCP 能力矩阵](../../references/mcp-capability-matrix.md)。

## 流程

1. 确认当前目录是 Git 仓库，读取 remote 和适用的项目规则。
2. 读取项目共享配置、用户级 `projects.json` 和当前 Git remote，按“项目配置 > 全局仓库配置 > 全局 defaults > 插件默认值”合并。项目文件缺失但合并结果完整时无需生成；全局 `defaults` 禁止包含 `repositoryId`。
3. 确认当前会话真实存在云效官方 MCP 工具，并读取其 Schema。
4. 缺少 `organizationId` 时调用 `get_current_organization_info` 和 `get_user_organizations` 准备组织候选；缺少 `repositoryId` 时从 remote URL 仅提取仓库名，用 `list_repositories` 准备仓库候选。此阶段只收集信息，不写配置，不从 remote URL 推导 ID。
5. 检查项目成员配置和用户级 `${XDG_CONFIG_HOME:-$HOME/.config}/yunxiao-release/member.json`；项目配置存在时优先使用。旧 Codex `.env` 成员字段仅作为迁移期兼容读取。
6. 初始化或更新配置时，只展示一次完整表单，集中收集或确认：组织、仓库、remote、目标分支、评审人模式与白名单、可选发版文件、内部文件路径、验证命令、`testDeployments`、成员配置存储范围，以及 `用户名称（真实名字）：`、`用户 ID：`、`飞书 ID（可选）：`。切换到用户级存储且项目成员配置已存在时，同一表单必须说明项目文件会覆盖用户级配置，并收集是否删除该项目文件。不得拆成逐项确认；发布环境及 URL 不得猜测。
7. 表单返回后统一校验所有字段。缺失或无法唯一匹配时一次性列出全部问题并停止，不得猜测后继续；`feishuId` 留空时不写入，不要求输入 `tokenSource`。
8. 调用当前用户、组织、仓库和目标分支的只读工具验证认证与配置；用户输入的 ID 必须与 `get_current_user` 返回的 `userId` 精确一致，不一致时停止且不写入。
9. 检查 `reviewerMode` 只使用 `ask|fixed`，`reviewerUserIds` 只包含非空且不重复的字符串；`fixed` 至少需要一个 ID。对每个评审人 ID 调用 `get_organization_member_info_by_user_id`，核对返回的 `userId`、组织和启用状态；名称无法唯一映射到 ID 时停止并列入统一错误结果，禁止按名称猜 ID。
10. 校验全部通过后按表单结果一次性写入共享配置和成员配置，不再逐项确认。项目存储使用 `localConfigFile` 并以 `git check-ignore` 验证；用户级存储通过 stdin 将成员 JSON 交给 `scripts/configure-member.mjs` 原子写入权限为 `600` 的用户配置 JSON，禁止把用户输入拼入 shell 命令。只有表单已选择删除时才删除现有项目成员配置。
11. `tokenSource` 固定视为 `environment`，不写入新配置；旧项目文件存在该字段时忽略。
12. 输出配置来源、用户名称（真实名字）、MCP 用户、是否已配置可选飞书 ID、组织、仓库、remote、目标分支、评审人模式、已验证评审人、环境发布配置、可选发版文件及权限验证结果；不得回显 `feishuId` 原值。

## 安全规则

- 不读取、打印或写入 Token 原文。
- 用户输入的用户 ID 只是待核对值，未通过 `get_current_user` 精确匹配前不得写入任何存储。
- 首次安装缺少 Token 时让 Codex 用户重新运行 `npx github:FlyAboveGrass/yunxiao-release-plugin`，让 Claude Code 用户通过 `/plugin` 配置敏感 `userConfig`；Codex Token 过期或被撤销时运行 `npx github:FlyAboveGrass/yunxiao-release-plugin token`，不要要求手工编辑凭据文件。
- 只读调用不能证明写权限；将权限分为“已验证”“未验证”“缺失”，不得推断。
- 组织成员查询不能证明代码库权限。评审人白名单必须由用户确认；当前 MCP 无法自动生成“全部有代码库权限的成员”。
- 401、403、身份不匹配或仓库不可见时停止并给出不含认证数据的修复方法。
