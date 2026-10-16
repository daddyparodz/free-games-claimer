// util/config currently have a cycle; initialize in the same order as claimers.
import './src/util.js';
import { cfg } from './src/config.js';
import { stopBrowser } from './src/browser-lifecycle.js';

// Uses the same dotenv/environment profile selection as the claimers.
// The root launcher calls this only after acquiring its exclusive run lock.
for (const profile of new Set([cfg.epic_browser_dir, cfg.dir.browser])) {
  if (await stopBrowser(profile)) console.log('Closed previous claimer browser gracefully.');
}
