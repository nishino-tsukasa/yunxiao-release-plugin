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
writeFileSync(resolve(fatFlow, 'run-fat-flow.sh'), '#!/usr/bin/env bash\nexit 0\n');
writeFileSync(resolve(fatFlow, 'plan-changed-fat-flow.sh'), '#!/usr/bin/env bash\nprintf \'%s\\n\' "$@" > "$CAPTURE_PATH"\n');
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
  const repositoryResult = run(['--branch', 'feature/demo', '--repo', repository], {
    CAPTURE_PATH: repositoryCapture, CLIENT_EXIT: '1', PROJECT_ID: 'canonical-service',
  });
  assert.equal(repositoryResult.status, 0, repositoryResult.stderr);
  const repositoryArgs = readFileSync(repositoryCapture, 'utf8').trim().split('\n');
  assert.deepEqual(repositoryArgs.slice(0, 6), [
    '--repos', repository, '--client-repos', '', '--branch', 'feature/demo',
  ]);
  console.log('fat flow wrapper self-test passed');
} finally {
  rmSync(root, { recursive: true, force: true });
}
