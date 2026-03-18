/**
 * Risk classifier for agent tool calls.
 * Classifies each tool use as green (read-only), yellow (modifying),
 * or red (dangerous/irreversible) and provides a short explanation.
 */
// Patterns matched against Bash command strings
const RED_BASH_PATTERNS = [
    { pattern: /\brm\s+-[^\s]*r|rm\s+-rf\b|\brm\b.*\*/, reason: 'Recursive/bulk delete' },
    { pattern: /\bgit\s+push\b/, reason: 'Pushing to remote repository' },
    { pattern: /\bgit\s+reset\s+--hard\b/, reason: 'Hard reset — discards uncommitted changes' },
    { pattern: /\bgit\s+force-push\b|\bgit\s+push\s+.*--force\b/, reason: 'Force push — rewrites remote history' },
    { pattern: /\bchmod\b.*\b[0-7]{3,4}\b/, reason: 'Changing file permissions' },
    { pattern: /\bchown\b/, reason: 'Changing file ownership' },
    { pattern: /\bsudo\b/, reason: 'Elevated privileges' },
    { pattern: /\bkill\b|\bkillall\b|\bpkill\b/, reason: 'Killing processes' },
    { pattern: /\bcurl\b.*\|\s*(sh|bash)\b/, reason: 'Piping remote script to shell' },
    { pattern: /\bsystemctl\b.*\b(stop|restart|disable)\b/, reason: 'Modifying system services' },
    { pattern: /\bdocker\s+(rm|rmi|system\s+prune)\b/, reason: 'Removing Docker resources' },
    { pattern: /\.env\b/, reason: 'Accessing credentials file' },
    { pattern: /\b(password|secret|token|key|credential)s?\b/i, reason: 'Possible credential access' },
];
const YELLOW_BASH_PATTERNS = [
    { pattern: /\bmkdir\b/, reason: 'Creating directories' },
    { pattern: /\bnpm\s+(install|uninstall|update)\b/, reason: 'Modifying npm packages' },
    { pattern: /\bgit\s+(add|commit|merge|rebase|checkout|branch)\b/, reason: 'Git repository modification' },
    { pattern: /\bmv\b/, reason: 'Moving/renaming files' },
    { pattern: /\bcp\b/, reason: 'Copying files' },
    { pattern: /\btee\b|>>?\s/, reason: 'Writing to file via shell' },
    { pattern: /\bdocker\s+(build|run|stop|start)\b/, reason: 'Docker operations' },
];
/**
 * Classify a tool call by risk level.
 */
export function classifyRisk(toolName, toolInput) {
    const input = toolInput;
    // Bash tool — inspect the command
    if (toolName === 'Bash') {
        const command = String(input?.command || '');
        for (const { pattern, reason } of RED_BASH_PATTERNS) {
            if (pattern.test(command))
                return { level: 'red', reason };
        }
        for (const { pattern, reason } of YELLOW_BASH_PATTERNS) {
            if (pattern.test(command))
                return { level: 'yellow', reason };
        }
        return { level: 'green', reason: 'Read-only shell command' };
    }
    // File modification tools
    if (toolName === 'Write' || toolName === 'Edit') {
        const filePath = String(input?.file_path || '');
        if (/\.env\b|credential|secret|token/i.test(filePath)) {
            return { level: 'red', reason: `Modifying sensitive file: ${filePath}` };
        }
        return { level: 'yellow', reason: `Modifying file: ${filePath}` };
    }
    if (toolName === 'NotebookEdit') {
        return { level: 'yellow', reason: 'Editing notebook' };
    }
    // Read-only tools
    if (['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'ToolSearch'].includes(toolName)) {
        return { level: 'green', reason: 'Read-only operation' };
    }
    // Task management
    if (toolName === 'Task' || toolName === 'TaskOutput' || toolName === 'TaskStop') {
        return { level: 'green', reason: 'Task management' };
    }
    if (toolName === 'TodoWrite') {
        return { level: 'green', reason: 'Updating todo list' };
    }
    // MCP tools
    if (toolName.startsWith('mcp__nanoclaw__send_message')) {
        return { level: 'yellow', reason: 'Sending message to chat' };
    }
    if (toolName.startsWith('mcp__nanoclaw__register_group')) {
        return { level: 'red', reason: 'Registering a new group' };
    }
    if (toolName.startsWith('mcp__nanoclaw__')) {
        return { level: 'yellow', reason: 'NanoClaw MCP operation' };
    }
    if (toolName.startsWith('mcp__ollama__')) {
        return { level: 'green', reason: 'Local Ollama query' };
    }
    // Agent teams
    if (toolName === 'TeamCreate' || toolName === 'TeamDelete') {
        return { level: 'yellow', reason: 'Managing agent team' };
    }
    if (toolName === 'SendMessage') {
        return { level: 'yellow', reason: 'Sending message to user' };
    }
    // Skill invocation
    if (toolName === 'Skill') {
        return { level: 'yellow', reason: 'Invoking a skill' };
    }
    // Unknown — treat as yellow for safety
    return { level: 'yellow', reason: `Unknown tool: ${toolName}` };
}
//# sourceMappingURL=risk-classifier.js.map