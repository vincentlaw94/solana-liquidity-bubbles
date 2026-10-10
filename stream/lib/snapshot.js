// Snapshot of the server's in-memory state, so a restart picks up where it left off: pools with their volume
// buckets, the token info cache, and the launches the bundle detector is following. Saved gzipped to
// data/snapshot.json.gz every minute and on shutdown; loaded on start unless it's older than a day.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import path from 'node:path';

export function createSnapshot({ file, maxAgeMs = 24 * 3600e3, log = () => {} }) {
  const stats = { loadedAt: null, loadedFrom: null, savedAt: null, bytes: null, ms: null, error: null };
  return {
    stats,
    load() {
      let j;
      try { j = JSON.parse(gunzipSync(readFileSync(file)).toString('utf8')); }
      catch (e) { if (e.code !== 'ENOENT') log('snapshot not loaded: ' + e.message); return null; }
      if (!j?.at || Date.now() - j.at > maxAgeMs) { log('snapshot is over a day old: starting fresh'); return null; }
      Object.assign(stats, { loadedAt: Date.now(), loadedFrom: j.at });
      return j;
    },
    save(data) {
      const t0 = performance.now();
      try {
        const buf = gzipSync(JSON.stringify({ at: Date.now(), ...data }), { level: 4 });
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file + '.tmp', buf);
        renameSync(file + '.tmp', file);
        Object.assign(stats, { savedAt: Date.now(), bytes: buf.length, ms: Math.round(performance.now() - t0), error: null });
      } catch (e) { stats.error = e.message; log('snapshot not saved: ' + e.message); }
    },
  };
}
