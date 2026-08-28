/** Deterministic color per agent name, so the same sub-agent always reads the same color. */
const AGENT_COLORS = ["cyan", "magenta", "green", "yellow", "blue"] as const;

export function colorForAgent(agent: string): string {
  let hash = 0;
  for (let i = 0; i < agent.length; i++) hash = (hash * 31 + agent.charCodeAt(i)) >>> 0;
  return AGENT_COLORS[hash % AGENT_COLORS.length] ?? "white";
}
