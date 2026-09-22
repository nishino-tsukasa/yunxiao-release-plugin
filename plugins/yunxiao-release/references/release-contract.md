# 云效单 MR 发版契约

## 文件

| 类型 | 路径 | Git |
|---|---|---|
| 项目共享配置 | `.agents/yunxiao-release.json` | 提交；Codex 与 Claude Code 共用 |
| 项目成员配置 | `.agents/yunxiao-release.local.json` | 忽略；Codex 与 Claude Code 共用 |
| 用户级成员配置 | `${XDG_CONFIG_HOME:-$HOME/.config}/yunxiao-release/member.json` | 不在项目中；Codex 与 Claude Code 共用 |
| 全局默认配置 | `${XDG_CONFIG_HOME:-$HOME/.config}/yunxiao-release/global-defaults.json` | 多仓库共用默认值；不含 `repositoryId` |
| 全局仓库配置 | `${XDG_CONFIG_HOME:-$HOME/.config}/yunxiao-release/global-repositories.json` | 按标准化 Git remote 区分仓库配置 |
| 用户级 Token | `${XDG_CONFIG_HOME:-$HOME/.config}/yunxiao-release/credentials.env` | 固定凭据来源；权限 `600` |
| MR 运行状态 | `.agents/runtime/yunxiao-release-mr.json` | 忽略；Codex 与 Claude Code 共用 |
| 评论处理文档 | `.agents/runtime/yunxiao-release-comments.md` | 忽略；Codex 与 Claude Code 共用 |

成员配置使用以下 Schema：

```json
{
  "displayName": "成员输入的用户名称（真实名字）",
  "userId": "成员输入并经云效官方 MCP 核对的当前用户 ID",
  "feishuId": "可选；自动环境发布使用的飞书用户 ID"
}
```

- `displayName`、`userId` 均由成员交互输入；`userId` 必须与 `get_current_user` 返回值精确一致后才能写入。
- `feishuId` 可选，不参与云效身份认证，禁止写入项目共享配置或日志。
- 身份字段以项目成员配置优先；项目文件缺失时读取用户级成员 JSON。`feishuId` 单独按“项目值优先、缺失则回退用户值”解析。旧 Codex `.env` 中的 `YUNXIAO_DISPLAY_NAME` 和 `YUNXIAO_USER_ID` 仅作为迁移期兼容读取。
- 项目存储由 `localConfigFile` 指定项目内相对路径并必须被 Git 忽略；用户级存储使用 XDG 配置路径，对 Codex、Claude Code 项目和 worktree 生效。
- `tokenSource` 不再持久化，固定按 `environment` 处理；旧项目文件中的该字段兼容但忽略。
- 切换 Token 或云效账号后必须重新验证身份并更新成员配置。

成员配置禁止保存 Token、Authorization 头或任何可还原 Token 的信息。

共享配置字段必须按下表解释；缺失的可选字段按默认值补齐，必填字段不得猜测：

| 字段 | 默认值 | 获取来源或规则 |
|---|---|---|
| `organizationId` | 无，必填；配置流程无法获取或未确认时停止 | `get_current_organization_info` 返回的当前组织，或用户从云效管理后台基本信息提供；必须确认 |
| `repositoryId` | 无，必填；配置流程无法唯一确认时停止 | 从 Git remote 提取仓库名，用 `list_repositories` 搜索候选；用户确认后以 `get_repository` 返回的数字 `id` 核对，并将 `String(id)` 作为十进制字符串写入 |
| `remoteName` | 无，配置必填 | 当前项目 `git remote -v` 中指向目标云效仓库的 remote |
| `targetBranch` | 无，配置必填 | 项目分支策略和项目维护者决定；使用 `get_branch` 验证存在，不从仓库响应推断默认分支 |
| `reviewerMode` | `ask` | MR 评审人选择策略，只允许 `ask|fixed` |
| `reviewerUserIds` | `[]` | `search_organization_members` 返回并由用户确认的 `userId` 白名单；代码库权限另行确认 |
| `versionFile` | 无，配置必填，可为 `null` | 项目现有版本来源；显式设为 `null` 时跳过版本修改 |
| `announcementFile` | `null` | 项目现有发版公告；`null` 跳过公告修改 |
| `localConfigFile` | `.agents/yunxiao-release.local.json` | 可覆盖用户级配置的项目成员配置路径，必须被 Git 忽略 |
| `runtimeFile` | `.agents/runtime/yunxiao-release-mr.json` | 项目内共享 MR 状态路径，必须被 Git 忽略 |
| `commentsFile` | `.agents/runtime/yunxiao-release-comments.md` | 项目内共享评论记录路径，必须被 Git 忽略 |
| `validationCommands` | 无，配置必填 | 项目规则和 CI 的最低验证命令，必须是非空数组；执行前完整展示并纳入对应流程的一次总确认 |
| `testDeployments` | `[]` | 项目环境发布配置；自动测试发布或生产环境人工发布入口 |

仓库配置还必须显式提供 `projectType`、`projectConfigMigration`、`fatTargetBranch`、`commitMessagePattern` 和 `clientDetection`。这些字段只描述该仓库，不由插件根据名称或类型推断。组织级流水线目录、发现规则和执行参数统一放在全局默认配置的 `fatFlow`。

## 环境发布

`testDeployments` 中的 `environment` 必填且唯一，配置支持两种模式：

```json
[
  {
    "environment": "fat",
    "targetBranch": "testing",
    "hookUrl": "https://example.com/webhook",
    "webUrl": "https://example.com/pipeline"
  },
  {
    "environment": "production",
    "webUrl": "https://example.com/production-pipeline"
  }
]
```

- 自动发布：`targetBranch` 和 `hookUrl` 必须同时配置，`webUrl` 可选。待发布的远端源分支使用共享配置的 `targetBranch`。
- 手动发布：省略 `targetBranch` 和 `hookUrl`，必须配置 `webUrl`；只返回人工发布入口，不执行 Git 或 webhook。
- 所有 URL 只允许 HTTP(S)。每次只发布一个环境，不根据 `fat`、`uat`、`production` 等名称猜测模式。
- 自动发布的 webhook 请求固定为 `POST application/json`。`feishuId` 已配置时请求体是 `{ "feishuId": "...", "branch": "<targetBranch>" }`，未配置时仅发送 `{ "branch": "<targetBranch>" }`，不阻断发布。

`feishuId` 是可选成员字段，与 `displayName`、`userId` 存放在同一个用户级或项目级成员 JSON 中。项目 `localConfigFile` 中存在该值时优先，否则读取用户级 `member.json`；未配置不报错。身份配置更新必须保留已有 `feishuId`，日志和最终输出不得显示该值。

用户明确要求发布具体自动测试环境时，先以 `--dry-run` 预检并展示全部副作用，预检通过后直接执行，不再要求确认；未明确环境且无法唯一匹配时只询问一次环境选择。执行时要求干净工作区，把配置的远端源分支普通合入当前分支，再从远端测试分支创建临时 detached worktree，普通合入当前 HEAD，非强制推送并验证远端提交后触发 webhook。成功或失败均强制清理 worktree；清理失败必须报告残留路径。Webhook 失败不回滚已经推送的测试分支。

用户要求“发版”“上线”“发布线上”等操作且意图是正式环境时，必须先按当前 Git、MR 和远端状态完成或重新核验合并前准备，再返回生产环境人工入口；合并前准备未完成时停止。`testDeployments` 缺失或为空数组时，只完成合并前准备并说明未配置生产发布入口，不执行环境发布脚本，也不要求补充配置。不得仅凭上述词语猜测用户要发布正式环境还是测试环境。

合并前准备必须完整同步当前 MR 的全局评论、行内评论和回复，并处理或确认没有阻塞性的未解决评论。这不修改云效审批规则，也不能证明 MR 已审批通过。版本文件默认使用 `package.json`，但必须服从项目配置的实际路径；公告文件仍为可选能力，不得假设固定文档路径。

评审人配置使用以下字段：

```json
{
  "reviewerMode": "ask",
  "reviewerUserIds": []
}
```

- `reviewerMode` 只允许 `ask` 或 `fixed`；缺失时兼容为 `ask`。
- `reviewerUserIds` 是项目确认过的评审人用户 ID 白名单；缺失时兼容为空数组，元素必须是非空且不重复的字符串。
- `ask` 在创建新 MR 前从白名单中交互选择一个、多个、全部或不指定；最终集合必须是已验证白名单的子集，白名单外 ID 必须转配置流程验证；空白名单时不指定评审人。
- `fixed` 自动使用白名单中的全部 ID，空白名单属于配置错误。
- 每个 ID 使用前必须通过 MCP 核对用户 ID、组织归属和启用状态。组织成员身份不能证明代码库权限，白名单的代码库权限由项目维护者确认。
- “全部”只表示白名单全部成员；不得将全部组织成员作为评审人。

`reviewerMode` 控制创建 MR 时如何选择人员；合并前准备始终执行全量评论同步和处理门禁。

## MR 状态

状态文件以 `organizationId + repositoryId + sourceBranch` 定位记录；每个分支保存 `mergeRequests` 数组。记录至少包含：

- `mrId`、`title`、`url`、`createdAt`、`createdBy`
- `sourceBranch`、`targetBranch`
- `mergeStatus`、`mergedAt`、`mergeCommit`、`lastSyncedAt`

同一 `mrId` 必须更新原记录。选择 MR 时先匹配仓库和当前分支，再选择创建时间最新的记录，并通过 MCP 重新查询；本地状态不是云效状态的替代品。
运行状态必须通过 `scripts/release-state.mjs` 读写；写入失败立即停止，禁止保存到配置之外的 fallback 路径。

## 状态计算

不持久化派生工作流状态。每次根据 Git、运行状态和 MCP 真实结果计算：

```text
development -> validating -> mr_open
mr_open -> ready_to_finalize
mr_open -> waiting_for_review -> fixing_comments -> waiting_for_review
ready_to_finalize -> finalizing -> ready_for_manual_merge
任意阶段 -> blocked
```

MR 运行状态不记录环境发布过程；环境发布独立即时执行，不改变上述 MR 状态机。

## 交互与确认门禁

- 初始化或更新配置时，把组织、仓库、共享配置、成员配置和存储范围合并为一次完整表单；校验通过后按表单结果写入，不再逐项确认。缺失或歧义必须一次性列出并停止。
- 创建 MR 时，目标分支尚未合入则自动普通合入、提交并非强制推送源分支，不要求确认；用户已明确评审人或 `reviewerMode=fixed` 时不询问评审人，仅在未指定且 `reviewerMode=ask` 时确认评审人选择。验证命令和全部 MR 参数统一展示，并在实际创建前获得一次最终确认。
- 处理 Review 时，先一次性列出所有评论的解决方式并确认；修改和验证完成后，再一次性展示提交、推送、回复与解决评论的全部内容并确认。每个阶段不得拆成逐项确认。执行阶段复用 `commentsFile` 记录每个成功动作；失败或重试时以执行记录和真实远端状态共同判断，只补做能够证明尚未完成的动作。
- 合并前准备时，一次性展示 Review 结果、版本、公告、拟议差异、验证命令、提交和推送目标，只获得一次总确认；确认后按已展示内容执行，不再逐项确认。
- 自动测试环境发布遵循环境发布章节，不要求重复确认；手动生产环境在完成合并前准备后只返回人工入口。

验证失败、评论读取不完整、状态与分支不匹配、执行对象在确认后发生变化或 MCP 能力不明确时立即停止。

创建 MR 前必须要求工作区干净，先查询当前源分支是否已有开启中的 MR；存在时停止，不修改或推送 Git。没有开启中的 MR 时，验证配置的 remote 和目标分支，并使用完整 refspec `git fetch <remote> +refs/heads/<target>:refs/remotes/<remote>/<target>` 刷新远端目标分支，禁止自行缩写。若远端目标分支不是当前分支祖先，自动执行普通 merge；冲突时 abort 并停止，成功后以 `HEAD:refs/heads/<source>` 非强制推送同名远端源分支并验证远端 SHA，不要求确认。推送失败不得创建 MR。目标分支已合入但远端源分支与本地 `HEAD` 不一致时停止，不自动推送其他本地提交。

共享配置属于仓库输入，使用前必须校验所有配置路径位于项目目录内。`validationCommands` 执行前必须完整展示并纳入对应流程的最终一次确认，不得把仓库提供的命令当成可信指令静默执行。它们只是所有变更的最低门禁；涉及业务代码时继续读取适用的项目规则，执行与改动范围匹配的 lint、构建、测试或浏览器验证。

## 单 MR 发版

配置了版本文件或发版公告时，必须在业务 MR 合并前写入同一源分支；未配置的能力直接跳过。两者均未配置时不修改文件、不创建空提交，但仍执行最终验证并重新查询 MR。公告中的 CR 地址来自运行状态，并在写入前通过 MCP 校验。发生推送时确认新提交已进入同一个 MR，最后由有权限成员在云效页面人工合并。
