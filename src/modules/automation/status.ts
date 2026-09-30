export const AUTOMATION_STATUSES = ['PENDING', 'RUNNING', 'SUCCEEDED', 'SKIPPED', 'FAILED', 'UNCERTAIN'] as const;
export type AutomationStatus = typeof AUTOMATION_STATUSES[number];
/** UNCERTAIN is terminal: never blindly retry an ambiguous Discord side effect. */
const transitions: Readonly<Record<AutomationStatus, readonly AutomationStatus[]>> = {
  PENDING: ['RUNNING', 'SKIPPED'],
  // RUNNING -> PENDING is permitted ONLY by bounded recovery/defer with proof no action-run started.
  RUNNING: ['PENDING', 'SUCCEEDED', 'SKIPPED', 'FAILED', 'UNCERTAIN'],
  SUCCEEDED: [], SKIPPED: [], FAILED: ['PENDING'], UNCERTAIN: [],
};
export function canTransitionAutomationStatus(from: AutomationStatus, to: AutomationStatus): boolean {
  return Object.hasOwn(transitions, from) && transitions[from].includes(to);
}
export function assertAutomationStatusTransition(from: AutomationStatus, to: AutomationStatus): void {
  if (!canTransitionAutomationStatus(from, to)) throw new Error(`Invalid automation status transition: ${from} -> ${to}`);
}
