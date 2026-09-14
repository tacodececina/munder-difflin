/** Visual taxonomy only: tool names are observations, not proof of execution. */
export type StationKind = 'shelf' | 'terminal' | 'web' | 'board' | 'mailbox' | 'mcp' | 'desk';
export type ToolGlyph = 'Read' | 'Edit' | 'Write' | 'Bash' | 'WebFetch' | 'WebSearch' | 'Grep' | 'Glob' | 'TodoWrite' | 'MCP';
const TOOLS: Record<string, { station: StationKind; carry?: ToolGlyph }> = {
  Read: { station: 'shelf', carry: 'Read' },
  Edit: { station: 'desk', carry: 'Edit' }, Write: { station: 'desk', carry: 'Write' },
  MultiEdit: { station: 'desk', carry: 'Edit' },
  Bash: { station: 'terminal', carry: 'Bash' }, BashOutput: { station: 'terminal', carry: 'Bash' },
  Grep: { station: 'shelf', carry: 'Grep' }, Glob: { station: 'shelf', carry: 'Glob' },
  WebFetch: { station: 'web', carry: 'WebFetch' }, WebSearch: { station: 'web', carry: 'WebSearch' },
  TodoWrite: { station: 'board', carry: 'TodoWrite' }, TaskCreate: { station: 'board', carry: 'TodoWrite' },
  TaskUpdate: { station: 'board', carry: 'TodoWrite' }, Task: { station: 'mailbox', carry: 'TodoWrite' }
};
export function stationForTool(tool: string): { station: StationKind; carry?: ToolGlyph } {
  if (Object.hasOwn(TOOLS, tool)) return TOOLS[tool];
  if (tool.startsWith('mcp__')) return { station: 'mcp', carry: 'MCP' };
  const name = tool.toLowerCase();
  if (/command|bash|shell|exec|terminal|run_/.test(name)) return { station: 'terminal', carry: 'Bash' };
  if (/web|fetch|browser|http|url/.test(name)) return { station: 'web', carry: 'WebFetch' };
  if (/write|edit|create|patch|replace|apply/.test(name)) return { station: 'desk', carry: 'Write' };
  if (/read|list|view|dir|glob|grep|search|find|file|cat|\bls\b/.test(name)) return { station: 'shelf', carry: 'Read' };
  return { station: 'desk' };
}
