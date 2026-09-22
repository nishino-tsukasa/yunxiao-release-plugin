export const pipelineStages = Object.freeze(['frontend-deploy', 'client-package', 'server-deploy']);
export const releaseStageOrder = Object.freeze([
  'promote-branch', ...pipelineStages, 'pipeline', 'webhook', 'manual-link',
]);

export const releaseStageName = (step) => step.type === 'pipeline' ? (step.stage || 'pipeline') : step.type;
