#!/usr/bin/env node

import { releaseStageName, releaseStageOrder } from './release-step-schema.mjs';

const matchesCondition = (when, changedFiles) => {
  if (!when) return true;
  if (Array.isArray(when.changedPaths)) {
    return changedFiles.some((file) => when.changedPaths.some((prefix) => file.startsWith(prefix)));
  }
  return true;
};

export const planEnvironmentRelease = ({ environment, repositories, allowedStepTypes = null }) => {
  if (!environment) throw new Error('缺少发布环境');
  if (!Array.isArray(repositories) || repositories.length === 0) throw new Error('至少需要一个仓库');
  const stages = new Map(releaseStageOrder.map((name) => [name, []]));
  const unresolved = [];
  const pipelineLoad = new Map();
  for (const item of repositories) {
    const { profile, sourceBranch, changedFiles = [] } = item;
    const configured = profile.environments?.[environment];
    if (!configured) {
      unresolved.push(`项目 ${profile.project} 未配置环境 ${environment}`);
      continue;
    }
    for (const issue of configured.issues ?? []) {
      if (allowedStepTypes && !allowedStepTypes.includes('pipeline')) continue;
      if (issue.stage === 'backend-client-package' && item.includeClient === false) continue;
      if (['frontend-client-deploy', 'backend-server-deploy'].includes(issue.stage) && item.includeServer === false) continue;
      unresolved.push(issue.message);
    }
    for (const step of configured.steps) {
      if (allowedStepTypes && !allowedStepTypes.includes(step.type)) continue;
      const isClientStep = step.type === 'pipeline' && step.stage === 'backend-client-package';
      if (isClientStep && item.includeClient === false) continue;
      if (!(isClientStep && item.includeClient === true) && !matchesCondition(step.when, changedFiles)) continue;
      if (step.type === 'pipeline' && ['frontend-client-deploy', 'backend-server-deploy'].includes(step.stage) && item.includeServer === false) continue;
      const common = { project: profile.project, repositoryKey: profile.repository.repositoryKey };
      let planned;
      if (step.type === 'promote-branch') {
        planned = {
          ...common,
          type: step.type,
          remoteName: profile.repository.remoteName,
          sourceBranch,
          prerequisiteBranch: profile.mergeRequest.targetBranch,
          targetBranch: configured.branch,
          ...(profile.git.commitMessagePattern ? { commitMessagePattern: profile.git.commitMessagePattern } : {}),
        };
      } else {
        let selected = step;
        if (step.type === 'pipeline' && Array.isArray(step.alternatives)) {
          selected = [...step.alternatives].sort((left, right) => {
            const leftKey = String(left.pipelineId || left.pipelineName);
            const rightKey = String(right.pipelineId || right.pipelineName);
            return (pipelineLoad.get(leftKey) ?? 0) - (pipelineLoad.get(rightKey) ?? 0)
              || (String(left.pipelineName) === String(right.pipelineName) ? 0 : (String(left.pipelineName) < String(right.pipelineName) ? -1 : 1));
          })[0];
          const key = String(selected.pipelineId || selected.pipelineName);
          pipelineLoad.set(key, (pipelineLoad.get(key) ?? 0) + 1);
        } else if (step.type === 'pipeline' && step.stage === 'backend-client-package') {
          const key = String(step.pipelineId || step.pipelineName);
          pipelineLoad.set(key, (pipelineLoad.get(key) ?? 0) + 1);
        }
        const { when: _when, stage: _stage, alternatives: _alternatives, ...rest } = selected;
        planned = { ...common, ...rest };
      }
      const name = releaseStageName(step);
      if (!stages.has(name)) stages.set(name, []);
      stages.get(name).push(planned);
    }
  }
  return {
    environment,
    repositories: repositories.map(({ profile }) => profile.project),
    stages: [...stages.entries()].filter(([, steps]) => steps.length).map(([name, steps]) => ({ name, steps })),
    unresolved,
  };
};
