/** Standalone entry for demos: pnpm --filter @tremurex/mock-api start */
import { startMockApi } from './mock-api.js';
import type { MockApi } from './mock-api.js';

const port = Number(process.env.MOCK_API_PORT ?? 5050);

let api: MockApi;
try {
  api = await startMockApi(port);
} catch (err) {
  if (err instanceof Error && 'code' in err && err.code === 'EADDRINUSE') {
    console.error(
      `mock-api: port ${String(port)} is already in use — another mock-api is probably ` +
        `still running.\n` +
        `  Find it:  lsof -nP -iTCP:${String(port)} -sTCP:LISTEN\n` +
        `  Or run on another port:  MOCK_API_PORT=5060 pnpm --filter @tremurex/mock-api start`,
    );
    process.exit(1);
  }
  throw err;
}

console.log(`mock-api listening on ${api.url}`);
console.log(`  GET ${api.url}/api/widget`);
console.log(`  PUT ${api.url}/__control/response  (mutate to manufacture drift)`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void api.close().finally(() => {
      process.exit(0);
    });
  });
}
