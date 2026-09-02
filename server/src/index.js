/*
 * Entry point: build the app, attach the WebSocket server, start the
 * background jobs, and shut all of it down cleanly when Docker says stop.
 */
import http from 'node:http';

import { db } from './db.js';
import { purgeExpired } from './auth.js';
import { createApp } from './app.js';
import { attachRealtime } from './realtime.js';
import { VERSION } from './version.js';
import { dailySnapshots, gcImageFiles } from './history.js';
import { config as updateConfig, startUpdatePolling } from './updates.js';

const PORT = Number(process.env.PORT || 8787);

const server = http.createServer(createApp());
const wss = attachRealtime(server);

purgeExpired();
const sessionSweep = setInterval(purgeExpired, 6 * 3_600_000);
sessionSweep.unref();

// nightly restore points, then sweep up any upload nothing points at
const nightly = () => {
  try { dailySnapshots(); gcImageFiles(); }
  catch (e) { console.error('nightly maintenance failed', e); }
};
const firstNightly = setTimeout(nightly, 60_000);
const everyNightly = setInterval(nightly, 24 * 3_600_000);
firstNightly.unref();
everyNightly.unref();

const stopUpdatePolling = startUpdatePolling();

server.listen(PORT, '0.0.0.0', () => {
  const { enabled, repo } = updateConfig();
  console.log(`Drydock ${VERSION} listening on :${PORT}`);
  console.log(enabled ? `Update checks on, watching ${repo}` : 'Update checks off');
});

/*
 * `docker stop` sends SIGTERM and waits ten seconds. Closing the WebSocket
 * clients and the database inside that window means the last write is
 * checkpointed rather than left for the next boot to recover.
 */
let closing = false;
function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`${signal} received, shutting down`);

  clearInterval(sessionSweep);
  clearTimeout(firstNightly);
  clearInterval(everyNightly);
  stopUpdatePolling();

  for (const sock of wss.clients) {
    try { sock.close(1001, 'server restarting'); } catch { /* already gone */ }
  }
  wss.close();

  const done = () => {
    try { db.pragma('wal_checkpoint(TRUNCATE)'); db.close(); }
    catch (e) { console.error('could not close the database cleanly', e); }
    process.exit(0);
  };

  server.close(done);
  setTimeout(done, 8_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
