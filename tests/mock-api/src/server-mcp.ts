/** Standalone entry for demos: pnpm --filter @tremurex/mock-api start:mcp */
import { startMockMcp } from './mock-mcp.js';

const port = Number(process.env.MOCK_MCP_PORT ?? 5051);
const mcp = await startMockMcp(port);
console.log(`mock-mcp listening — MCP endpoint: ${mcp.url}`);
console.log(`  PUT http://127.0.0.1:${String(mcp.port)}/__control/tools  (mutate the catalog)`);
