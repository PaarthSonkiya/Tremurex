/** Standalone entry for demos: pnpm --filter @tremurex/mock-api start:mcp */
import { startMockMcp } from './mock-mcp.js';
import type { MockMcp } from './mock-mcp.js';

const port = Number(process.env.MOCK_MCP_PORT ?? 5051);

let mcp: MockMcp;
try {
  mcp = await startMockMcp(port);
} catch (err) {
  if (err instanceof Error && 'code' in err && err.code === 'EADDRINUSE') {
    console.error(
      `mock-mcp: port ${String(port)} is already in use — another mock-mcp is probably ` +
        `still running.\n` +
        `  Find it:  lsof -nP -iTCP:${String(port)} -sTCP:LISTEN\n` +
        `  Or run on another port:  MOCK_MCP_PORT=5061 pnpm --filter @tremurex/mock-api start:mcp`,
    );
    process.exit(1);
  }
  throw err;
}

console.log(`mock-mcp listening — MCP endpoint: ${mcp.url}`);
console.log(`  PUT http://127.0.0.1:${String(mcp.port)}/__control/tools  (mutate the catalog)`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void mcp.close().finally(() => {
      process.exit(0);
    });
  });
}
