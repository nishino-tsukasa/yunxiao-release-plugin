export const pipelineStages = Object.freeze([
  'frontend-client-deploy',
  'backend-client-package',
  'backend-server-deploy',
]);

export const legacyPipelineStageAliases = Object.freeze({
  'frontend-deploy': 'frontend-client-deploy',
  'client-package': 'backend-client-package',
  'server-deploy': 'backend-server-deploy',
});

export const normalizePipelineStage = (stage) => legacyPipelineStageAliases[stage] ?? stage;
export const releaseStageOrder = Object.freeze([
  'promote-branch', ...pipelineStages, 'pipeline', 'webhook', 'manual-link',
]);

export const releaseStageName = (step) => step.type === 'pipeline' ? (step.stage || 'pipeline') : step.type;
