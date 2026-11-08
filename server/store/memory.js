// MemoryStore: tests (ELVAR_STORE=memory). Nothing is written to disk.
import { LocalStore } from './local.js';

export class MemoryStore extends LocalStore {
  get kind() { return 'memory'; }
}
