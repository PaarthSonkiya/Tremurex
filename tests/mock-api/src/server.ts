/** Standalone entry for demos: pnpm --filter @tremurex/mock-api start */
import { startMockApi } from './mock-api.js';

const port = Number(process.env.MOCK_API_PORT ?? 5050);
const api = await startMockApi(port);
console.log(`mock-api listening on ${api.url}`);
console.log(`  GET ${api.url}/api/widget`);
console.log(`  PUT ${api.url}/__control/response  (mutate to manufacture drift)`);
