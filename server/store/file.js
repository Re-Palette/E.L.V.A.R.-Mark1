// FileStore: the local node server. ${ELVAR_DATA_DIR || ~/.elvar}/store.json, mode 0600, written atomically (random temp name created with O_EXCL -> rename).
// TTLs are judged on read. Plain JSON on purpose: secrets in it are already envelope-encrypted by the vault.
//   - only a missing file (ENOENT) means "first run"; an unreadable file stops the server instead of being overwritten
//   - a corrupt file is moved aside (store.json.corrupt-<time>) and the store starts empty
//   - a symlink at the store path is refused (it could point the writes somewhere else)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { LocalStore } from './local.js';

export class FileStore extends LocalStore {
  constructor(dir = process.env.ELVAR_DATA_DIR || path.join(os.homedir(), '.elvar')) {
    super();
    this.dir = dir; this.file = path.join(dir, 'store.json');
    let raw = null;
    try {
      const st = fs.lstatSync(this.file);
      if (st.isSymbolicLink() || !st.isFile()) throw Object.assign(new Error(`${this.file} is not a regular file (symlinks are refused)`), { code: 'ELVAR_NOT_A_FILE' });
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;   // unreadable / not a file: do not start with an empty store that would overwrite it
    }
    if (raw !== null) {
      try { this.data = Object.assign(Object.create(null), JSON.parse(raw)); }
      catch {
        const aside = `${this.file}.corrupt-${Date.now()}`;
        fs.renameSync(this.file, aside);
        console.error(`[store] ${this.file} was not valid JSON: moved to ${aside}, starting empty`);
      }
    }
  }
  get kind() { return 'file'; }
  _persist() {
    const now = Date.now();
    for (const k of Object.keys(this.data)) if (this.data[k].x != null && this.data[k].x <= now) delete this.data[k];
    let tmp = '';
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      tmp = path.join(this.dir, `.store.${crypto.randomBytes(8).toString('hex')}.tmp`);
      const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(this.data)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, this.file);   // rename replaces a link itself, never its target
    } catch (e) {
      console.error('[store] could not write', this.file, e?.code || e?.message);
      if (tmp) { try { fs.unlinkSync(tmp); } catch { /* ignore */ } }
    }
  }
}
