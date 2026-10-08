/**
 * A context tool fetches one named piece of context (e.g. "quote", "brain")
 * for a subject (e.g. a ticker). A domain registers its own map of these —
 * core/ never knows what "quote" or "fundamentals" actually means.
 */
export type ContextTool = (subject: string) => Promise<unknown>;
export type ContextToolMap = Record<string, ContextTool>;

/**
 * Optional: a domain's facts for deciding whether a skill is worth running now
 * (see core/gate.ts). Exported next to `contextTools` from the domain's module.
 */
export type GateFactsFn = (skillName: string, subject: string) => Promise<import("./gate").GateFacts>;
