#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const files = [];
const visit = (directory) => readdirSync(directory, { withFileTypes: true }).forEach((entry) => {
  const path = resolve(directory, entry.name);
  if (entry.isDirectory()) visit(path);
  else if (!entry.name.includes('.test.') && !entry.name.startsWith('test_') && ['.md', '.mjs', '.py', '.sh', '.json'].includes(extname(entry.name))) files.push(path);
});
visit(pluginRoot);

const forbidden = [
  /supermonkey/i,
  /monkey-/i,
  /\betna\b/i,
  /fat\/fat/i,
  /fat-pipeline-config/i,
  /project-kind\.sh/i,
  /projectConfigMigration/,
  /projectMigration/,
  /finalizeProjectMigration/,
  /\b142296\b/,
  /\b49\d{5}\b/,
];
const violations = [];
for (const file of files) {
  const content = readFileSync(file, 'utf8');
  forbidden.forEach((pattern) => {
    if (pattern.test(content)) violations.push(`${file}: ${pattern}`);
  });
}
assert.deepEqual(violations, [], `插件包含组织或项目专属硬编码：\n${violations.join('\n')}`);
console.log('generic boundary self-test passed');
