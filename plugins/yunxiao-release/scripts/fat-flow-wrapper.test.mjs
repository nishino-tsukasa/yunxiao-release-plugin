#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = resolve(dirname(fileURLToPath(import.meta.url)), 'fat-flow/run-full-fat-flow-deploy.sh');
const root = mkdtempSync(resolve(tmpdir(), 'yunxiao-fat-wrapper-'));
const scripts = resolve(root, 'scripts');
const fatFlow = resolve(scripts, 'fat-flow');
mkdirSync(fatFlow, { recursive: true });
copyFileSync(source, resolve(fatFlow, 'run-full-fat-flow-deploy.sh'));
writeFileSync(resolve(fatFlow, 'run-fat-flow.sh'), '#!/usr/bin/env bash\nif [[ -n "${GIT_FLOW_MARKER:-}" ]]; then touch "$GIT_FLOW_MARKER"; fi\nexit 0\n');
writeFileSync(resolve(fatFlow, 'preflight-merge-branches.mjs'), '#!/usr/bin/env node\nimport { appendFileSync } from "node:fs";\nif (process.env.PREFLIGHT_CAPTURE) appendFileSync(process.env.PREFLIGHT_CAPTURE, `${process.argv.slice(2).join("|")}\\n`);\n');
writeFileSync(resolve(fatFlow, 'plan-changed-fat-flow.sh'), '#!/usr/bin/env bash\nprintf \'%s\\n\' "$@" > "$CAPTURE_PATH"\nif [[ " $* " == *" --validate "* ]]; then exit "${VALIDATE_EXIT:-0}"; fi\n');
writeFileSync(resolve(scripts, 'release-configuration-cli.mjs'), `#!/usr/bin/env node
const command = process.argv[2];
if (command === 'get') {
  const field = process.argv[process.argv.indexOf('--field') + 1];
  console.log(field === 'repository.repositoryKey' ? (process.env.REPOSITORY_KEY || 'example.com/team/configured-project') : (process.env.PROJECT_ID || 'configured-project'));
}
else process.exit(Number(process.env.CLIENT_EXIT || '1'));
`);
for (const path of [
  resolve(fatFlow, 'run-full-fat-flow-deploy.sh'), resolve(fatFlow, 'run-fat-flow.sh'),
  resolve(fatFlow, 'plan-changed-fat-flow.sh'), resolve(scripts, 'release-configuration-cli.mjs'),
]) chmodSync(path, 0o755);

const run = (args, env) => spawnSync(resolve(fatFlow, 'run-full-fat-flow-deploy.sh'), args, {
  encoding: 'utf8', env: { ...process.env, ...env },
});

try {
  const projectCapture = resolve(root, 'project.args');
  const projectResult = run(['--branch', 'feature/demo', '--project', 'service-a'], {
    CAPTURE_PATH: projectCapture, CLIENT_EXIT: '1',
  });
  assert.equal(projectResult.status, 0, projectResult.stderr);
  const projectArgs = readFileSync(projectCapture, 'utf8').trim().split('\n');
  assert.deepEqual(projectArgs.slice(0, 6), ['--projects', 'service-a', '--client-projects', '', '--branch', 'feature/demo']);

  const failedCapture = resolve(root, 'failed.args');
  const failedResult = run(['--branch', 'feature/demo', '--project', 'service-a'], {
    CAPTURE_PATH: failedCapture, CLIENT_EXIT: '2',
  });
  assert.equal(failedResult.status, 1, JSON.stringify(failedResult));
  assert.match(failedResult.stderr, /读取项目 Client 配置失败/);
  assert.equal(existsSync(failedCapture), false);

  const repository = resolve(root, 'renamed-worktree');
  mkdirSync(repository);
  spawnSync('git', ['init', '-q'], { cwd: repository });
  const repositoryCapture = resolve(root, 'repository.args');
  const preflightCapture = resolve(root, 'preflight.args');
  const repositoryResult = run(['--branch', 'feature/demo', '--repo', repository], {
    CAPTURE_PATH: repositoryCapture, CLIENT_EXIT: '1', PROJECT_ID: 'canonical-service', PREFLIGHT_CAPTURE: preflightCapture,
  });
  assert.equal(repositoryResult.status, 0, repositoryResult.stderr);
  const repositoryArgs = readFileSync(repositoryCapture, 'utf8').trim().split('\n');
  assert.deepEqual(repositoryArgs.slice(0, 6), [
    '--repos', repository, '--client-repos', '', '--branch', 'feature/demo',
  ]);
  assert.equal(existsSync(preflightCapture), false);

  const releaseInputCapture = resolve(root, 'release-input.args');
  const releaseInputResult = run([
    '--branch', 'feature/demo', '--repo', repository,
    '--depends-on', 'canonical-service:provider',
    '--preflight-merge-branch', 'canonical-service:fat_jdk17',
  ], { CAPTURE_PATH: releaseInputCapture, CLIENT_EXIT: '1', PROJECT_ID: 'canonical-service', PREFLIGHT_CAPTURE: preflightCapture });
  assert.equal(releaseInputResult.status, 0, releaseInputResult.stderr);
  const releaseInputArgs = readFileSync(releaseInputCapture, 'utf8').trim().split('\n');
  assert.deepEqual(releaseInputArgs.slice(releaseInputArgs.indexOf('--depends-on'), releaseInputArgs.indexOf('--branch')), [
    '--depends-on', 'canonical-service:provider', '--preflight-merge-branch', 'canonical-service:fat_jdk17',
  ]);
  assert.equal(readFileSync(preflightCapture, 'utf8').trim(), `${repository}|feature/demo|fat|fat_jdk17`);
  const projectPreflightResult = run([
    '--branch', 'feature/demo', '--project', 'service-a', '--preflight-merge-branch', 'service-a:fat_jdk17',
  ], { CAPTURE_PATH: resolve(root, 'project-preflight.args') });
  assert.equal(projectPreflightResult.status, 1);
  assert.match(projectPreflightResult.stderr, /需要 --repo/);

  const gitMarker = resolve(root, 'git-flow-ran');
  const invalidResult = run(['--branch', 'feature/demo', '--repo', repository], {
    CAPTURE_PATH: resolve(root, 'invalid.args'), CLIENT_EXIT: '1', PROJECT_ID: 'canonical-service',
    VALIDATE_EXIT: '3', GIT_FLOW_MARKER: gitMarker,
  });
  assert.equal(invalidResult.status, 1);
  assert.match(invalidResult.stderr, /发布计划校验失败/);
  assert.equal(existsSync(gitMarker), false);

  const resumeCapture = resolve(root, 'resume.args');
  const resumeResult = run([
    '--branch', 'feature/demo', '--repo', repository, '--resume', '--state-file', resolve(root, 'run-state.json'),
    '--retry-failed',
  ], { CAPTURE_PATH: resumeCapture, CLIENT_EXIT: '2', PROJECT_ID: 'canonical-service' });
  assert.equal(resumeResult.status, 0, resumeResult.stderr);
  const resumeArgs = readFileSync(resumeCapture, 'utf8').trim().split('\n');
  assert.deepEqual(resumeArgs.slice(resumeArgs.indexOf('--state-file'), resumeArgs.indexOf('--branch')),
    ['--state-file', resolve(root, 'run-state.json'), '--resume', '--retry-failed']);
  console.log('fat flow wrapper self-test passed');
} finally {
  rmSync(root, { recursive: true, force: true });
}
