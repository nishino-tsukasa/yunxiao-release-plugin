#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = resolve(dirname(fileURLToPath(import.meta.url)), 'preflight-merge-branches.mjs');
const root = mkdtempSync(resolve(tmpdir(), 'yunxiao-preflight-'));
const bare = resolve(root, 'remote.git');
const repo = resolve(root, 'repo');
const config = resolve(root, 'config/yunxiao-release');
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });

try {
  execFileSync('git', ['init', '--bare', '-q', bare]);
  mkdirSync(repo);
  git('init', '-q');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  git('remote', 'add', 'origin', `file://${bare}`);
  writeFileSync(resolve(repo, 'code.txt'), 'base\n');
  git('add', 'code.txt');
  git('commit', '-qm', 'base');
  git('branch', '-M', 'main');
  git('branch', 'fat/fat');
  git('branch', 'fat/fat_jdk17');
  git('branch', 'feature');
  git('switch', '-q', 'fat/fat_jdk17');
  writeFileSync(resolve(repo, 'code.txt'), 'jdk17\n');
  git('commit', '-qam', 'jdk17');
  git('switch', '-q', 'feature');
  writeFileSync(resolve(repo, 'code.txt'), 'feature\n');
  git('commit', '-qam', 'feature');
  git('push', '-q', 'origin', 'feature', 'fat/fat', 'fat/fat_jdk17');

  mkdirSync(resolve(repo, '.agents'));
  mkdirSync(config, { recursive: true });
  writeFileSync(resolve(config, 'global-defaults.json'), JSON.stringify({ schemaVersion: 1, organizationId: 'org-1' }));
  writeFileSync(resolve(config, 'global-repositories.json'), JSON.stringify({ schemaVersion: 1, repositories: {} }));
  writeFileSync(resolve(repo, '.agents/yunxiao-release.json'), JSON.stringify({
    organizationId: 'org-1', repositoryId: '1', remoteName: 'origin', targetBranch: 'main',
    reviewerMode: 'ask', reviewerUserIds: [], versionFile: null, announcementFile: null,
    localConfigFile: '.agents/local.json', runtimeFile: '.agents/runtime.json', commentsFile: '.agents/comments.md',
    validationCommands: ['git diff --check'],
    environments: { fat: { branch: 'fat/fat', steps: [{ type: 'promote-branch' }] } },
  }));
  const env = { ...process.env, XDG_CONFIG_HOME: resolve(root, 'config') };
  const conflicted = spawnSync('node', [script, repo, 'feature', 'fat', 'fat/fat_jdk17'], { encoding: 'utf8', env });
  assert.equal(conflicted.status, 1);
  assert.match(conflicted.stderr, /预合并冲突/);
  assert.match(conflicted.stderr, /code.txt/);

  git('switch', '-q', 'fat/fat_jdk17');
  git('reset', '--hard', 'main');
  writeFileSync(resolve(repo, 'other.txt'), 'jdk17\n');
  git('add', 'other.txt');
  git('commit', '-qm', 'jdk17 other file');
  git('push', '-q', '--force', 'origin', 'fat/fat_jdk17');
  const compatible = spawnSync('node', [script, repo, 'feature', 'fat', 'fat/fat_jdk17'], { encoding: 'utf8', env });
  assert.equal(compatible.status, 0, compatible.stderr);
  assert.match(compatible.stdout, /status=success/);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('preflight merge branches self-test passed');
