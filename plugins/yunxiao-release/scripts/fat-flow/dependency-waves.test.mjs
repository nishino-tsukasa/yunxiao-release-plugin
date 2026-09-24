#!/usr/bin/env node

import assert from 'node:assert/strict';

import { planDependencyWaves } from './dependency-waves.mjs';

const entry = (project, dependsOn = []) => ({ profile: { project, environments: { fat: { dependsOn } } } });

assert.deepEqual(
  planDependencyWaves([entry('core', ['wx']), entry('wx'), entry('order')], 'fat'),
  [['order', 'wx'], ['core']],
);
assert.deepEqual(planDependencyWaves([entry('core', ['external'])], 'fat'), [['core']]);
assert.throws(() => planDependencyWaves([entry('wx', ['core']), entry('core', ['wx'])], 'fat'), /存在环/);
assert.throws(() => planDependencyWaves([entry('wx', ['wx'])], 'fat'), /指向自身/);
assert.throws(() => planDependencyWaves([entry('wx'), entry('wx')], 'fat'), /重复/);

console.log('dependency waves self-test passed');
