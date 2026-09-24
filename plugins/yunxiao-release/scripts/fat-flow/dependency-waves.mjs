// Release dependencies describe this run, not permanent repository topology.
export const planDependencyWaves = (entries, dependencies = []) => {
  const byProject = new Map();
  for (const entry of entries) {
    const project = entry.profile.project;
    if (byProject.has(project)) throw new Error(`发布项目重复: ${project}`);
    byProject.set(project, entry);
  }
  const byConsumer = new Map([...byProject.keys()].map((project) => [project, []]));
  const seen = new Set();
  for (const { consumer, provider } of dependencies) {
    if (!byProject.has(consumer) || !byProject.has(provider)) {
      throw new Error(`本次发布依赖必须引用已选项目: ${consumer}:${provider}`);
    }
    if (consumer === provider) throw new Error(`发布依赖不能指向自身: ${consumer}`);
    const key = `${consumer}\0${provider}`;
    if (seen.has(key)) throw new Error(`发布依赖重复: ${consumer}:${provider}`);
    seen.add(key);
    byConsumer.get(consumer).push(provider);
  }
  const remaining = new Set(byProject.keys());
  const completed = new Set();
  const waves = [];
  while (remaining.size) {
    const ready = [...remaining].sort().filter((project) => {
      return byConsumer.get(project).every((dependency) => completed.has(dependency));
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
