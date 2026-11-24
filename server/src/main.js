import { LinkLibrary } from './library.js';
import { resolve } from 'node:path';
import { configuration, createTapServer } from './server.js';

try {
  const config = configuration();
  const library = new LinkLibrary(resolve(process.env.DATA_DIR || 'data', 'links.sqlite'));
  const server = createTapServer(config, { library });
  server.listen(config.port, config.host, () => {
    console.log(`Proclaim Tap listening on ${config.host}:${config.port}; heartbeat expiry ${config.ttlSeconds}s`);
  });
  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
} catch (error) {
  console.error(`Configuration error: ${error.message}`);
  process.exitCode = 1;
}
