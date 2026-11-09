// The caller's own build requests (docs/ELVAR_MULTIUSER.md 8.1): the list behind Settings, and removing an entry from it. The requests themselves go to the
// user's OWN GitHub repository with their OWN token (server/build.js); only a small record is kept here, so the list can be seen, exported and deleted (principle 7).
// Deleting an entry here does not touch the GitHub issue: that lives in the user's repository.
const bad = (status, error, message) => ({ status, body: { error, ...(message ? { message } : {}) } });

export async function listBuilds({ user }) { return { status: 200, body: { builds: await user.db((r) => r.builds.list({ limit: 50 })) } }; }

export async function deleteBuild({ user, params }) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(params.id))) return bad(404, 'not_found');
  return (await user.db((r) => r.builds.del(params.id))) ? { status: 200, body: { ok: true } } : bad(404, 'not_found');
}
