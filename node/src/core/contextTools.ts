/**
 * A context tool fetches one named piece of context (e.g. "quote", "brain")
 * for a subject (e.g. a ticker). A domain registers its own map of these —
 * core/ never knows what "quote" or "fundamentals" actually means.
 */
export type ContextTool = (subject: string) => Promise<unknown>;
export type ContextToolMap = Record<string, ContextTool>;
