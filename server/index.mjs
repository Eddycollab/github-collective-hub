// Railway entry point: node server/index.mjs (locally: node --env-file=.env server/index.mjs).
import http from 'node:http';
import { readConfig } from './config.mjs';
import { createApp } from './app.mjs';

let cfg;
try {
  cfg = readConfig();
} catch (e) {
  console.error(`config error: ${e.message}`);
  process.exit(1);
}

const server = http.createServer(createApp(cfg));
server.headersTimeout = 20000;
server.requestTimeout = 60000;
server.listen(cfg.port, () => {
  console.log(`GitHub Collective Hub listening on port ${cfg.port}; public URL ${cfg.publicUrl}; library ${cfg.libraryRepo}`);
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
