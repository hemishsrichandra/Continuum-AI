// Windows keeps SQLite's -shm/-wal files locked while a connection is open, so a test's temp-directory cleanup can
// fail with EBUSY/EPERM after every assertion has already passed. That is not an application failure; on Windows
// only, a locked temporary directory is left for the OS to remove. Other platforms are untouched.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';

// Suites written before explicit suggestion choice exist run the legacy mode (the best suggestion is recorded as the attempt when shown).
// New suites opt into the product default with `world(t, { choose: true })`.
process.env.SUGGESTION_MODE ??= 'auto_first';

if (process.platform === 'win32') {
  const locked = (e) => ['EBUSY', 'EPERM'].includes(e?.code);
  const rm = fsp.rm;
  fsp.rm = async (...args) => {
    try {
      return await rm(...args);
    } catch (e) {
      if (!locked(e)) throw e;
    }
  };
  const rmSync = fs.rmSync;
  fs.rmSync = (...args) => {
    try {
      return rmSync(...args);
    } catch (e) {
      if (!locked(e)) throw e;
    }
  };
  syncBuiltinESMExports();
}
