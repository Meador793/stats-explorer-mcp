// Product details shown to users. Edit APP_URL before publishing.
import { createRequire } from 'node:module';

export const APP_NAME = 'Stats Explorer';

// Link added to the end of each result ("Explore this visually in Stats Explorer: ...").
// Users can override it with STATS_EXPLORER_APP_URL or hide it with STATS_EXPLORER_HIDE_LINK=1.
export const APP_URL = process.env.STATS_EXPLORER_APP_URL ?? 'https://github.com/meador793/stats-explorer-mcp';

let version = '0.0.0';
try { version = createRequire(import.meta.url)('../package.json').version; } catch { /* bundled: injected below */ }
// eslint-disable-next-line no-undef
export const VERSION = typeof __STATS_EXPLORER_VERSION__ !== 'undefined' ? __STATS_EXPLORER_VERSION__ : version;
