// Starts the HTTP app (src/app.ts) on PORT. DEMO_MODE=1 runs the hosted multi-visitor demo instead of
// the single-user app (see deploy/README-demo.md).

import { createServer } from "node:http";
import { createApp } from "./app.ts";

const app = createApp();
const { config } = app;
const server = createServer({ maxHeaderSize: app.demo ? 16 * 1024 : undefined }, app.handle);
if (app.demo) {
  // A public endpoint: slow or idle clients must not hold sockets. (The answer stream itself is capped by
  // DEMO_STREAM_TIMEOUT_MS; these limits cover receiving the request.)
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.maxConnections = 512;
}

server.listen(config.port, config.host, () => {
  console.log(`minimi-agent running at http://${config.host === "0.0.0.0" ? "localhost" : config.host}:${config.port}`);
  for (const line of app.startupLines()) console.log(line);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    server.close();
    app.close().finally(() => process.exit(0));
  });
}
