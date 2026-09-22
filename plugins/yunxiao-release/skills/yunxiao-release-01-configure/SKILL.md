---
name: yunxiao-release-01-configure
description: 初始化、更新或检查任意 Git 项目的云效发版配置、成员身份和 MR 评审人。用户提到初始化云效、配置 Token、检查 MCP 认证、切换成员、目标分支、评审人或发版配置缺失时使用。
---

# 云效发版配置

先阅读 [发版契约](../../references/release-contract.md) 和 [MCP 能力矩阵](../../references/mcp-capability-matrix.md)。

## 流程

1. 确认当前目录是 Git 仓库，读取 remote 和适用的项目规则。
2. 读取项目共享配置、用户级 `global-defaults.json`、`global-repositories.json` 和当前 Git remote，按“项目配置 > 全局仓库配置 > 全局默认配置”合并。全局仓库项支持项目配置的全部字段；项目文件可以缺失或只含覆盖字段。全局默认配置禁止包含 `repositoryId`，插件不补组织或项目策略默认值。
3. 全局文件缺失、不完整，或用户要求导入配置时，先询问是否配置全局信息。用户可提供任意当前会话可读取的文件、目录、JSON、YAML、Markdown 表格或普通文本；读取后规范化为 `defaults` 和 `repositories`，不得要求用户转换格式。未同意配置时继续检查当前项目，并把全局缺失列入最终结果。
4. 确认当前会话真实存在云效官方 MCP 工具，并读取其 Schema。
5. 缺少 `organizationId` 时调用 `get_current_organization_info` 和 `get_user_organizations`；缺少 `repositoryId` 时从标准化 remote 提取仓库路径，用 `list_repositories` 准备候选并用 `get_repository` 精确核实。不得从 remote 猜 ID。
   MR 目标分支、FAT 目标分支、项目类型、提交规则、Client 检测方式和迁移动作均从输入来源核实后显式写入仓库配置；插件不根据项目名称或类型推断这些值。
6. 检查项目成员配置和用户级 `${XDG_CONFIG_HOME:-$HOME/.config}/yunxiao-release/member.json`；项目配置存在时优先使用。旧 Codex `.env` 成员字段仅作为迁移期兼容读取。
7. 初始化或更新配置时，只展示一次表单，集中收集配置范围（全局默认、全局仓库、当前项目）、组织、仓库、remote、目标分支、评审人、发版文件、验证命令、环境发布，以及 `用户名称（真实名字）：`、`用户 ID：`、`飞书 ID（可选）：`。不得拆成逐项确认；发布环境及 URL 不得猜测。
8. 表单返回后统一校验所有字段。缺失或无法唯一匹配时一次性列出全部问题并停止；`feishuId` 留空时不写入，不要求输入 `tokenSource`。
9. 调用当前用户、组织、仓库和目标分支的只读工具验证认证与配置；用户输入的 ID 必须与 `get_current_user` 返回的 `userId` 精确一致。
10. 检查评审人配置并逐个核对成员身份、组织和启用状态；名称无法唯一映射到 ID 时停止。
11. 写入前只展示摘要：配置范围、默认字段数、仓库总数、成功匹配数、待处理问题数和将写入的两个目标路径；不展示完整配置、Token、`feishuId` 或全部仓库明细。获得一次确认后，将规范化 JSON 通过 stdin 交给 `scripts/configure-global.mjs apply`，以 `600` 权限合并写入两个全局文件；项目和成员配置继续使用各自脚本安全写入。
12. 全局迁移后重新读取当前 remote 的有效配置，逐字段确认原项目共享配置均已被覆盖，再按仓库显式配置的 `projectConfigMigration=retain|delete` 处理项目文件。不得删除成员配置、运行状态或评论文件；迁移动作缺失时保留项目配置并列入待处理问题。
13. `tokenSource` 固定视为 `environment`，不写入新配置；旧项目文件存在该字段时忽略。
14. 输出配置来源、写入摘要、当前仓库匹配结果、项目配置保留或删除结果、成员与权限验证结果；不得回显完整导入内容或敏感原值。

## 安全规则

- 不读取、打印或写入 Token 原文。
- 用户输入的用户 ID 只是待核对值，未通过 `get_current_user` 精确匹配前不得写入任何存储。
- 首次安装缺少 Token 时让 Codex 用户重新运行 `npx github:FlyAboveGrass/yunxiao-release-plugin`，让 Claude Code 用户通过 `/plugin` 配置敏感 `userConfig`；Codex Token 过期或被撤销时运行 `npx github:FlyAboveGrass/yunxiao-release-plugin token`，不要要求手工编辑凭据文件。
- 只读调用不能证明写权限；将权限分为“已验证”“未验证”“缺失”，不得推断。
- 组织成员查询不能证明代码库权限。评审人白名单必须由用户确认；当前 MCP 无法自动生成“全部有代码库权限的成员”。
- 401、403、身份不匹配或仓库不可见时停止并给出不含认证数据的修复方法。
