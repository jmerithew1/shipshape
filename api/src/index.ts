import { createServer } from 'http';
import { config } from 'dotenv';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables (.env.local takes precedence)
config({ path: join(__dirname, '../.env.local') });
config({ path: join(__dirname, '../.env') });

async function main() {
  // Load secrets from SSM in production (before importing app)
  if (process.env.NODE_ENV === 'production') {
    const { loadProductionSecrets } = await import('./config/ssm.js');
    await loadProductionSecrets();
  }

  // Now import app after secrets are loaded
  const { createApp } = await import('./app.js');
  const { setupCollaboration } = await import('./collaboration/index.js');

  const PORT = process.env.PORT || 3000;
  const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:5173';

  const app = createApp(CORS_ORIGIN);
  const server = createServer(app);

  // DDoS protection: Set server-wide timeouts to prevent slow-read attacks (Slowloris)
  server.timeout = 60000; // 60 seconds max request duration
  server.keepAliveTimeout = 65000; // 65 seconds (slightly longer than timeout)
  server.headersTimeout = 66000; // 66 seconds (slightly longer than keepAlive)

  // Setup WebSocket collaboration server
  setupCollaboration(server);

  // Start server
  server.listen(PORT, () => {
    console.log(`API server running on http://localhost:${PORT}`);
    console.log(`CORS origin: ${CORS_ORIGIN}`);
  });
}

// Process-level safety nets (AUDIT_REPORT.md Cat 6). Without these, Node's
// default kills the whole API — every user's session — on a single stray
// rejection anywhere in a request handler or background task.
//
// unhandledRejection: log loudly and keep serving. A rejected promise nobody
// awaited is a bug, but one that should cost an error log, not an outage.
// uncaughtException: log and exit non-zero after closing what we can —
// synchronous throws leave the process in an undefined state, so restarting
// (the process manager's job) is safer than limping on.
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED PROMISE REJECTION (continuing to serve):', reason);
});

process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION (exiting for supervisor restart):', err);
  process.exitCode = 1;
  // Give the log a tick to flush, then let the process end.
  setTimeout(() => process.exit(1), 100).unref();
});

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
