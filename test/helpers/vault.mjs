// A second brain for the module tests (finance, shifts, courses, projects, conversation): the signed-in test user's OWN notes in the in-memory database.
// `store` is a synchronous Map-like view of those notes ({ text } by path), so a test can read what the code wrote and seed notes without going through
// the code under test. Replaces the old stub of the GitHub Contents API (the notes no longer live in a repository).
import { enterTestUser } from './user-ctx.mjs';

/** Call once at the top of a test file (it makes the test user the configuration of the whole file). */
export function useVault(opts) {
  const user = enterTestUser(opts);
  const store = user.db.testing.notesView(user.uid);
  return {
    ...user, store,
    /** Remember the notes now; the returned function lists the paths created or changed since (in the order they are stored). */
    watch() { const before = new Map([...store].map(([k]) => [k, store.get(k).rev])); return () => [...store].map(([k]) => k).filter((k) => before.get(k) !== store.get(k).rev); },
    /** Runs fn with an EMPTY vault ({ store }); the notes are removed afterwards. */
    async withVault(fn) {
      for (const k of [...store.keys()]) store.delete(k);
      try { return await fn({ store }); } finally { for (const k of [...store.keys()]) store.delete(k); }
    },
  };
}
