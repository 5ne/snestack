import { loadAllDomainApis } from "../domainRegistry";
import { buildCoreRoutes } from "./coreRoutes";
import { ApiRouter } from "./router";

/**
 * Construct a complete `ApiRouter` with all domain-agnostic core routes and
 * every registered domain's `apiModule` routes mounted.
 */
export async function createApiRouter(): Promise<ApiRouter> {
  const router = new ApiRouter();
  router.registerMany(buildCoreRoutes(() => router), "core");
  const domainApis = await loadAllDomainApis();
  for (const [domain, mod] of Object.entries(domainApis)) {
    router.registerMany(mod.routes, domain);
  }
  return router;
}
