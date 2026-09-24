// Only selected projects participate in this release. Dependencies outside the
// selection are already-running services and do not create phantom steps.
export const planDependencyWaves = (entries, environment) => {
  const byProject = new Map();
  for (const entry of entries) {
    const project = entry.profile.project;
    if (byProject.has(project)) throw new Error(`发布项目重复: ${project}`);
    byProject.set(project, entry);
  }
  const remaining = new Set(byProject.keys());
  const completed = new Set();
  const waves = [];
  while (remaining.size) {
    const ready = [...remaining].sort().filter((project) => {
      const dependencies = byProject.get(project).profile.environments[environment]?.dependsOn ?? [];
      if (dependencies.includes(project)) throw new Error(`发布依赖不能指向自身: ${project}`);
      return dependencies.filter((dependency) => byProject.has(dependency)).every((dependency) => completed.has(dependency));
    });
    if (!ready.length) throw new Error(`发布依赖存在环: ${[...remaining].sort().join(', ')}`);
    waves.push(ready);
    for (const project of ready) {
      remaining.delete(project);
      completed.add(project);
    }
  }
  return waves;
};
