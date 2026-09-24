# 云效发版配置字段

本文是配置字段的维护入口。插件代码只负责校验和执行，不内置组织、仓库、分支、项目类型或流水线映射。

## 配置来源与选择规则

| 来源 | 路径 | 作用 |
|---|---|---|
| 全局默认 | `${XDG_CONFIG_HOME:-$HOME/.config}/yunxiao-release/global-defaults.json` | 跨仓库一致的组织、存储路径和执行参数 |
| 全局仓库 | `${XDG_CONFIG_HOME:-$HOME/.config}/yunxiao-release/global-repositories.json` | 没有项目配置时使用的完整仓库配置 |
| 项目配置 | `.agents/yunxiao-release.json` | 存在时完整替换该仓库的全局仓库配置 |

解析规则是 `全局默认 + (项目配置或全局仓库配置)`。项目配置与全局仓库配置不会逐字段或递归合并；项目文件一旦存在，就必须能作为完整仓库配置独立使用。对象和数组也不做深合并。

## 全局默认字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `schemaVersion` | `1` | 是 | 文件格式版本，不进入运行 Profile |
| `organizationId` | string | 是 | 云效组织 ID |
| `localConfigFile` | string | 是 | 项目成员身份文件的项目内相对路径 |
| `runtimeFile` | string | 是 | MR 状态文件的项目内相对路径 |
| `commentsFile` | string | 是 | MR 评论工作文件的项目内相对路径 |
| `releaseExecution` | object | 有 pipeline 时 | 流水线轮询和各阶段等待参数 |

全局默认禁止仓库 ID、remote、分支、评审人、版本文件、验证命令和环境发布步骤。

## 完整仓库配置字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `organizationId` | string | 条件必填 | 项目配置需脱离全局使用时提供；否则可由全局默认提供 |
| `repositoryId` | string | MR 流程必填 | 云效代码库数字 ID；已有值直接使用，缺失时配置流程按 remote 查询、核实并持久化 |
| `remoteName` | string | 是 | Git remote 名称，例如 `origin` |
| `targetBranch` | string | 是 | MR 目标分支，不是环境分支 |
| `reviewerMode` | `ask\|fixed` | 是 | 评审人选择方式 |
| `reviewerUserIds` | string[] | 是 | 评审人用户 ID 白名单 |
| `versionFile` | string\|null | 是 | 合并前更新的版本文件；`null` 表示跳过 |
| `announcementFile` | string\|null | 是 | 发版公告文件；`null` 表示跳过 |
| `localConfigFile` | string | 条件必填 | 项目内相对路径；可由全局默认提供 |
| `runtimeFile` | string | 条件必填 | 项目内相对路径；可由全局默认提供 |
| `commentsFile` | string | 条件必填 | 项目内相对路径；可由全局默认提供 |
| `validationCommands` | string[] | 是 | 创建 MR 和合并前准备执行的非空命令列表 |
| `commitMessagePattern` | string | 否 | Git 提交信息正则规则 |
| `environments` | object | 否 | 以环境名为键的发布配置 |
| `releaseExecution` | object | 否 | 项目文件需要脱离全局配置独立工作时提供；同一次多仓发布中必须完全一致 |

`repositoryId` 缺失不阻止只使用 Git 和流水线的 FAT 发布，但创建、查询或维护 MR 前必须解析成功。
全局仓库条目通常复用全局默认的 `releaseExecution`；随仓库提交的完整项目配置可复制该字段，保证其他使用者没有全局配置时也能执行。多仓计划发现执行参数不一致时会在触发前拒绝执行。

## `environments`

环境名没有内置枚举。`fat`、`uat`、`production` 和其他名称均由配置决定。

```json
{
  "fat": {
    "branch": "develop",
    "steps": [
      { "type": "promote-branch" },
      {
        "type": "pipeline",
        "stage": "frontend-client-deploy",
        "pipelineName": "前端 FAT",
        "pipelineId": "100",
        "params": { "envs": { "branch": "develop", "project": "web", "envName": "default" } }
      }
    ]
  }
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `branch` | string\|null | 自动发布的环境目标分支；纯人工入口为 `null` |
| `steps` | object[] | 按顺序声明的环境动作 |
项目先后关系与额外构建分支预检取决于本次改动，不写入 `environments`。多仓发布时按实际变更传入 `--depends-on <consumer:provider>` 和 `--preflight-merge-branch <project:branch>`；两者都可重复，未指定时不附加顺序或额外分支预检。`dependsOn`、`preflightMergeBranches` 作为固定配置会被拒绝。

## Step 字段

### `promote-branch`

将 MR 目标分支合入环境分支并非强制推送。

```json
{ "type": "promote-branch" }
```

### `pipeline`

```json
{
  "type": "pipeline",
  "stage": "backend-server-deploy",
  "pipelineName": "服务端 FAT",
  "pipelineId": "200",
  "params": { "envs": {} },
  "when": { "changedPaths": ["client/"] }
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `stage` | string | 是 | `frontend-client-deploy`、`backend-client-package` 或 `backend-server-deploy` |
| `pipelineName` | string | 是 | 展示和诊断名称 |
| `pipelineId` | string | 是 | 云效流水线 ID |
| `params` | object | 是 | 传给云效流水线 API 的参数 |
| `when.changedPaths` | string[] | 否 | 仅在指定路径前缀有改动时执行；`when` 不接受其他字段 |
| `candidates` | object[] | 否 | 等价流水线候选；Backend Client 执行前查询运行占用，优先选择空闲候选并按本次计划负载均衡；均忙时等待空闲或超时 |

同一个项目、同一个环境、同一实际流水线只能选择 `pipeline` 或 `webhook` 一种触发方式。需要查询结果、超时控制或多仓编排时使用 `pipeline`。

### `webhook`

```json
{ "type": "webhook", "hookUrl": "https://example.com/hook", "webUrl": "https://example.com/run" }
```

仅用于无法通过 Pipeline API 执行的系统。`hookUrl` 用于触发；可选 `webUrl` 用于查看。

### `manual-link`

```json
{ "type": "manual-link", "webUrl": "https://example.com/production" }
```

只返回人工发布入口，不修改环境分支或触发流水线。

## `releaseExecution`

```json
{
  "pollIntervalSeconds": 10,
  "stages": {
    "frontend-client-deploy": { "initialWaitSeconds": 0, "timeoutSeconds": 1800 },
    "backend-client-package": { "initialWaitSeconds": 60, "timeoutSeconds": 600 },
    "backend-server-deploy": { "initialWaitSeconds": 0, "timeoutSeconds": 1800 }
  }
}
```

`pollIntervalSeconds` 是流水线状态查询间隔。每个实际使用的 pipeline stage 必须提供 `timeoutSeconds`；`initialWaitSeconds` 缺省为 `0`。

## 成员与凭据

成员配置位于项目 `localConfigFile` 或用户级 `${XDG_CONFIG_HOME:-$HOME/.config}/yunxiao-release/member.json`，字段为 `displayName`、`userId` 和可选 `feishuId`。项目成员配置优先。

Token 固定存放在 `${XDG_CONFIG_HOME:-$HOME/.config}/yunxiao-release/credentials.env` 的 `YUNXIAO_ACCESS_TOKEN`，不进入上述 JSON、Git 或日志。

## 向后兼容

读取边界继续接受 `testDeployments`、旧 `fatFlow`、`projectType`、`fatTargetBranch`、`clientDetection`、旧阶段名 `frontend-deploy`/`client-package`/`server-deploy` 和旧 `releaseExecution` 字段。规范化后的 Profile 与新写入配置只使用本文格式。
