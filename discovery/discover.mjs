// Finds the repositories the pool should serve: every repository the App's
// installation can see that belongs to the owner, is private, is not archived
// or excluded, and has the spillway workflow active on its default branch.
// Opting in is adding that workflow, so a new repository joins on its own.
// `include` names repositories to serve before their workflow reaches the
// default branch: while hosted minutes are exhausted, the pull request that
// adds the workflow can only be checked on the pool through the label, and
// that needs the scale set to exist already.
// Public repositories are never served: GitHub advises against self-hosted
// runners for them, because anyone can open a pull request.

export async function discoverRepos({ client, owner, workflowPath, exclude = [], include = [] }) {
  const repos = await client.paginate('/installation/repositories', 'repositories');
  const selected = [];
  const skipped = [];
  for (const repo of repos) {
    const why = repo.owner?.login !== owner ? 'belongs to another owner'
      : !repo.private ? 'is public (never served)'
      : repo.archived ? 'is archived'
      : repo.disabled ? 'is disabled'
      : exclude.includes(repo.name) ? 'is excluded in the config'
      : null;
    if (why) {
      skipped.push({ repo: repo.full_name, why });
      continue;
    }
    const entry = { name: repo.name, fullName: repo.full_name, url: repo.html_url };
    if (include.includes(repo.name)) {
      selected.push(entry);
      continue;
    }
    const workflows = await client.paginate(`/repos/${owner}/${repo.name}/actions/workflows`, 'workflows');
    const workflow = workflows.find((w) => w.path === workflowPath);
    if (!workflow) {
      skipped.push({ repo: repo.full_name, why: `has no ${workflowPath}` });
    } else if (workflow.state !== 'active') {
      skipped.push({ repo: repo.full_name, why: `has ${workflowPath} but it is ${workflow.state}` });
    } else {
      selected.push(entry);
    }
  }
  return { selected, skipped };
}
