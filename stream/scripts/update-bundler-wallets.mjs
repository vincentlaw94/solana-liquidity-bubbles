// Re-downloads isitbundled.com's bundler-wallet list and rewrites the hardcoded bundler-wallets.json.
// Run occasionally: npm run update-bundlers   (takes ~25 minutes; resumes if interrupted)
// Then restart the server to load the new list.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncBundlerWallets } from '../lib/bundlers.js';

const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bundler-wallets.json');
syncBundlerWallets({ file }).catch(e => { console.error('stopped:', e.message, '(run again to resume)'); process.exit(1); });
