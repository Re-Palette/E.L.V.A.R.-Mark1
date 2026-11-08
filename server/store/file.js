// FileStore: the local node server. ${ELVAR_DATA_DIR || ~/.elvar}/store.json, mode 0600, written atomically (tmp -> rename).
// TTLs are judged on read. Plain JSON on purpose: secrets in it are already envelope-encrypted by the vault.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalStore } from './local.js';

export class FileStore extends LocalStore {
  constructor(dir = process.env.ELVAR_DATA_DIR || path.join(os.homedir(), '.elvar')) {
    super();
    this.dir = dir; this.file = path.join(dir, 'store.json');
    try { this.data = Object.assign(Object.create(null), JSON.parse(fs.readFileSync(this.file, 'utf8'))); } catch { /* first run, or unreadable: start empty */ }
  }
  get kind() { return 'file'; }
  _persist() {
    const now = Date.now();
    for (const k of Object.keys(this.data)) if (this.data[k].x != null && this.data[k].x <= now) delete this.data[k];
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (e) { console.error('[store] could not write', this.file, e?.code || e?.message); }
  }
}
