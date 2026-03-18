/**
 * Risk classifier for agent tool calls.
 * Classifies each tool use as green (read-only), yellow (modifying),
 * or red (dangerous/irreversible) and provides a short explanation.
 */
export type RiskLevel = 'green' | 'yellow' | 'red';
export interface RiskResult {
    level: RiskLevel;
    reason: string;
}
/**
 * Classify a tool call by risk level.
 */
export declare function classifyRisk(toolName: string, toolInput: unknown): RiskResult;
//# sourceMappingURL=risk-classifier.d.ts.map