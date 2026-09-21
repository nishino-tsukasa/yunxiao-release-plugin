# Yunxiao Release Plugin

通过阿里云云效官方 MCP，把 Git 项目从开发分支推进到单个 MR 的合并前准备阶段，支持 Codex 和 Claude Code。源码和下载地址：<https://github.com/FlyAboveGrass/yunxiao-release-plugin>。

## 能力边界

- 支持任意云效组织、代码库、Git remote 和目标分支。
- 创建当前分支的单个 MR；已有开启中 MR 时停止，可选处理 Review 评论、版本文件和发版公告。
- 按项目配置发布测试分支并触发构建，或提供生产环境人工发布入口。
- 不合并 MR，也不绕过审批、流水线、冲突或保护分支。

## 安装

前置条件：Git、Node.js 20+、支持 Plugins 的 Codex 或 Claude Code，以及可访问目标云效组织和代码库的个人访问令牌。

代码库的个人访问令牌的获取方式在： https://account-devops.aliyun.com/settings/personalAccessToken 。

进入目标 Git 项目运行：

```bash
npx github:FlyAboveGrass/yunxiao-release-plugin
```

通过复选框选择 Codex、Claude Code 或两者。安装完成后会生成共享项目配置 `.agents/yunxiao-release.json`，并补充本地配置和运行文件所需的 `.gitignore` 规则。

建议使用用户级安装：同一宿主的多个项目可共享插件，每个项目仍通过 `.agents/yunxiao-release.json` 保存独立配置。一键安装默认使用用户级作用域。

选择 Codex 时，安装脚本会复用或交互式读取 `YUNXIAO_ACCESS_TOKEN`，以 `~/.config/yunxiao-release/credentials.env` 为固定来源，并同步到当前 Codex Home 供 MCP 启动时读取。旧 `${CODEX_HOME:-$HOME/.codex}/.env` Token 会自动迁移。

选择 Claude Code 时，插件安装到用户级作用域。启动 Claude Code 后，先运行 `/plugin configure yunxiao-release@yunxiao-release-community` 配置 Token。

安装后初始化项目配置和当前成员身份：

```text
# Codex
$yunxiao-release:yunxiao-release-01-configure 交互配置当前项目和成员身份。

# Claude Code
/yunxiao-release:yunxiao-release-01-configure 交互配置当前项目和成员身份。
```

如果需要在其他 Git 项目中初始化共享配置，进入项目根目录运行：

```bash
npx github:FlyAboveGrass/yunxiao-release-plugin configure
```

该命令保留已有配置值，只补齐缺少的默认字段。

## 项目配置

配置按字段使用以下优先级：项目 `.agents/yunxiao-release.json` > 全局仓库配置 > 全局默认配置 > 插件内置默认值。项目配置可以只保留需要覆盖的字段。

全局配置位于 `${XDG_CONFIG_HOME:-$HOME/.config}/yunxiao-release/projects.json`：

```json
{
  "schemaVersion": 1,
  "defaults": {
    "organizationId": "组织 ID",
    "targetBranch": "master",
    "reviewerMode": "ask",
    "reviewerUserIds": []
  },
  "repositories": {
    "codeup.aliyun.com/supermonkey/monkey-core": {
      "repositoryId": "代码库 ID",
      "targetBranch": "fat/fat"
    }
  }
}
```

仓库键由 Git remote 标准化得到。`repositoryId` 只能放在项目配置或具体仓库项中，不能放入 `defaults`。

共享配置位于 `.agents/yunxiao-release.json`：

```json
{
  "organizationId": "",
  "repositoryId": "",
  "remoteName": "origin",
  "targetBranch": "master",
  "reviewerMode": "ask",
  "reviewerUserIds": [],
  "versionFile": "package.json",
  "announcementFile": null,
  "localConfigFile": ".agents/yunxiao-release.local.json",
  "runtimeFile": ".agents/runtime/yunxiao-release-mr.json",
  "commentsFile": ".agents/runtime/yunxiao-release-comments.md",
  "validationCommands": ["git diff --check"],
  "testDeployments": [
    {
      "environment": "fat",
      "targetBranch": "develop",
      "hookUrl": "https://example.com/webhook",
      "webUrl": "https://example.com/pipeline"
    },
    {
      "environment": "production",
      "webUrl": "https://example.com/production-pipeline"
    }
  ]
}
```

| 字段 | 默认值 | 说明 |
|---|---|---|
| `organizationId` | 无，必填 | 云效组织 ID。推荐由配置 Skill 查询并确认，也可在云效“管理后台 > 基本信息”查看。 |
| `repositoryId` | 无，必填 | 云效代码库数字 ID 的字符串形式。推荐由配置 Skill 根据当前 remote 查询并确认。 |
| `remoteName` | `origin` | 推送和同步使用的 Git remote。可通过 `git remote -v` 确认。 |
| `targetBranch` | `master` | MR 的目标分支。应按项目分支策略配置。 |
| `reviewerMode` | `ask` | 评审人选择模式：用户未指定时，`ask` 从白名单中选择一个、多个、全部或不指定；已指定评审人时不再询问。`fixed` 使用白名单中的全部成员，白名单为空时报错。 |
| `reviewerUserIds` | `[]` | 评审人用户 ID 白名单。配置 Skill 可按成员名称查询并写入；代码库权限需由项目维护者确认。 |
| `versionFile` | `package.json` | 合并前按配置更新的版本文件。没有统一版本文件时设为 `null`。 |
| `announcementFile` | `null` | 合并前按配置更新的发版公告。`null` 表示跳过。 |
| `localConfigFile` | `.agents/yunxiao-release.local.json` | 项目级成员身份配置，必须是项目内相对路径并被 Git 忽略。 |
| `runtimeFile` | `.agents/runtime/yunxiao-release-mr.json` | 当前分支和 MR 的运行状态，必须是项目内相对路径并被 Git 忽略。 |
| `commentsFile` | `.agents/runtime/yunxiao-release-comments.md` | MR 评论处理记录，必须是项目内相对路径并被 Git 忽略。 |
| `validationCommands` | `["git diff --check"]` | 创建 MR 和合并前准备阶段执行的最低验证命令。根据项目规则、CI 和现有脚本配置，必须是非空数组；全部命令会纳入对应流程的一次总确认。 |
| `testDeployments` | `[]` | 环境发布配置。`targetBranch + hookUrl` 表示自动测试发布；仅 `environment + webUrl` 表示生产环境人工发布入口。 |

## 成员身份与 Token

成员身份可存放在：

- 项目级：`.agents/yunxiao-release.local.json`
- 用户级：`${XDG_CONFIG_HOME:-$HOME/.config}/yunxiao-release/member.json`

项目级配置优先于用户级配置。用户级配置可供 Codex、Claude Code 和同一用户的多个 worktree 共用。

## 前后端 FAT 发版

`yunxiao-release fat-flow` 支持多个仓库的固定 FAT 流程：名称包含 `-web` 的项目合入 `develop` 并执行前端流水线；其他项目合入 `fat/fat`，再执行后端 client 打包与 server 部署。流水线映射由 `scripts/fat-flow/fat-pipeline-config.json` 管理。

推荐使用配置 Skill 生成，内容如下：

```json
{
  "displayName": "张三",
  "userId": "云效 MCP 返回的当前用户 ID",
  "feishuId": "可选的飞书用户 ID"
}
```

- `displayName` 是用户真实名字，不参与认证。
- `userId` 必须与当前 Token 对应的云效用户 ID 一致，不能使用组织 ID、邮箱或用户名代替。
- `feishuId` 是可选字段，只用于自动环境发布；与 `displayName`、`userId` 存放在同一个成员配置文件，可放在用户级配置，也可由项目级配置覆盖。未配置时 webhook 仅发送目标分支，不阻断发布。

项目级配置必须被 Git 忽略，可运行以下命令确认：

```bash
git check-ignore -v .agents/yunxiao-release.local.json
```

如果命令没有输出，重新运行安装命令或 `configure` 命令补齐忽略规则。

切换到用户级身份时，需要删除项目级身份文件，否则项目级配置仍会优先。切换 Token 或云效账号后，重新执行配置 Skill 验证成员身份。

### 更新 Token

Codex 更新 Token：

```bash
npx github:FlyAboveGrass/yunxiao-release-plugin token
```

检查当前 Codex Home 是否已配置 Token：

```bash
npx github:FlyAboveGrass/yunxiao-release-plugin token --check
```

更新后重启 Codex 并新建会话。Claude Code 通过 `/plugin` 打开 `yunxiao-release` 的 Configure 更新 Token。

## 使用

发版步骤 Skill 使用 `01–05` 编号辅助排序和识别；环境发布不使用编号。测试环境发布可独立调用；正式环境发布必须先完成 05 合并前准备。编号本身不表示其他 Skill 之间存在调用依赖或自动流转。

| 编号 | 操作 | Codex | Claude Code | 用途 |
|---|---|---|---|---|
| 01 | 配置项目 | `$yunxiao-release:yunxiao-release-01-configure` | `/yunxiao-release:yunxiao-release-01-configure` | 初始化或检查项目配置、成员身份、MCP 认证和评审人。 |
| 02 | 云效 MR 创建 | `$yunxiao-release:yunxiao-release-02-prepare-mr` | `/yunxiao-release:yunxiao-release-02-prepare-mr` | 验证当前分支并创建 MR；已有开启中 MR 时停止。 |
| 03 | 同步评论 | `$yunxiao-release:yunxiao-release-03-sync-comments` | `/yunxiao-release:yunxiao-release-03-sync-comments` | 完整同步当前 MR 的全局评论、行内评论和回复。 |
| 04 | 处理评论 | `$yunxiao-release:yunxiao-release-04-fix-review-comments` | `/yunxiao-release:yunxiao-release-04-fix-review-comments` | 分析并处理当前 MR 的未解决评论。 |
| 05 | 云效 MR 合并前准备 | `$yunxiao-release:yunxiao-release-05-finalize` | `/yunxiao-release:yunxiao-release-05-finalize` | 按配置更新版本号、发版资料，验证并在必要时推送到同一 MR，等待人工合并。 |
| — | 环境发布 | `$yunxiao-release:yunxiao-release-deploy-environment` | `/yunxiao-release:yunxiao-release-deploy-environment` | 发布一个测试环境，或返回生产环境人工发布入口。 |
| — | FAT Git Flow | `$yunxiao-release:yunxiao-release-fat-flow` | `/yunxiao-release:yunxiao-release-fat-flow` | 多仓库前后端分支合入及 FAT 流水线部署。 |

创建 MR 时若远端目标分支尚未合入当前分支，插件会自动普通合入并非强制推送源分支，不再额外确认；工作区不干净、合并冲突或推送校验失败时停止。

明确要求发布 FAT、UAT 等自动测试环境时，预检通过后直接完成发布，不再重复确认；未明确环境且存在多个候选时才询问环境选择。

明确要求发布正式环境时，插件先核验并补齐 05 合并前准备，再返回人工发布入口。`testDeployments` 未配置或为空数组时，只完成合并前准备，不返回生产发布地址。

## 常见问题

### 安装后找不到插件

```bash
# Codex
codex plugin marketplace list
codex plugin list

# Claude Code
claude plugin marketplace list
claude plugin list
```

确认 marketplace `yunxiao-release-community` 和插件 `yunxiao-release` 已启用。Codex 重启并新建会话；Claude Code 执行 `/reload-plugins`。

### Token 配置后仍返回 401/403

重新配置 Token，并确认 Token 有权访问目标组织和代码库。

### `allRequirementsPass` 为 `false`

表示云效仍有审批、流水线、分支保护或其他门禁。

## 更新与卸载

更新插件：

```bash
# Codex
codex plugin marketplace upgrade yunxiao-release-community
codex plugin add yunxiao-release@yunxiao-release-community

# Claude Code
claude plugin marketplace update yunxiao-release-community
claude plugin update yunxiao-release@yunxiao-release-community --scope user
```

卸载插件和 marketplace：

```bash
# Codex
codex plugin remove yunxiao-release@yunxiao-release-community
codex plugin marketplace remove yunxiao-release-community

# Claude Code
claude plugin uninstall yunxiao-release@yunxiao-release-community --scope user
claude plugin marketplace remove yunxiao-release-community
```

操作后重启对应宿主。卸载不会删除项目配置、用户级成员配置或已保存的 Token。

## 运行限制

- 一键安装脚本支持 macOS、Linux 和 WSL，暂不支持原生 Windows PowerShell。
- 运行时依赖 Node.js 20+、Git、Codex Plugins 或 Claude Code Plugins，以及阿里云云效官方 MCP。

## 许可证

本项目采用 [MIT License](../../LICENSE)。
