#!/usr/bin/env node

import assert from 'node:assert/strict';

import { planDependencyWaves } from './dependency-waves.mjs';

const entry = (project) => ({ profile: { project } });
const edge = (consumer, provider) => ({ consumer, provider });

assert.deepEqual(
  planDependencyWaves([entry('core'), entry('wx'), entry('order')], [edge('core', 'wx')]),
  [['order', 'wx'], ['core']],
);
assert.deepEqual(planDependencyWaves([entry('core'), entry('wx')]), [['core', 'wx']]);
assert.throws(() => planDependencyWaves([entry('core')], [edge('core', 'external')]), /已选项目/);
assert.throws(() => planDependencyWaves([entry('wx'), entry('core')], [edge('wx', 'core'), edge('core', 'wx')]), /存在环/);
assert.throws(() => planDependencyWaves([entry('wx')], [edge('wx', 'wx')]), /指向自身/);
assert.throws(() => planDependencyWaves([entry('wx'), entry('core')], [edge('wx', 'core'), edge('wx', 'core')]), /依赖重复/);
assert.throws(() => planDependencyWaves([entry('wx'), entry('wx')]), /项目重复/);

console.log('dependency waves self-test passed');
