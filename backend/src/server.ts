import { createApp } from "./app";
import { config } from "./config";
import { initDb } from "./db";
import { startPipeline } from "./services/pipeline";

initDb();
const app = createApp();

app.listen(config.port, () => {
  console.log(`Impact Registry API listening on http://localhost:${config.port}`);
  console.log(`Chain:    ${config.rpcUrl} (chainId ${config.chainId})`);
  console.log(`Registry: ${config.registryAddress ?? (config.chain.impactRegistry || "not deployed yet")}`);
  console.log(`EAS:      ${config.easAddress ?? (config.chain.eas || "not deployed yet")}`);
});

startPipeline();
