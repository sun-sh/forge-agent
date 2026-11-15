export function calibrationHash(value: string | Uint8Array): string;
export const controlReceiptSchema: import('zod').ZodType<any>;
export function prepareCalibration(bytes: Uint8Array, spec: any, expected: any, request: string, parsePlan: typeof import('../src/task/behavior.js').parseBehaviorPlan): { plan: import('../src/task/behavior.js').BehaviorPlan | null; reason: string | null };
export function compareCalibration(plan: import('../src/task/behavior.js').BehaviorPlan, baseline: any, candidate: any): Array<{checkId:string;kind:string;commandSha256:string;baseline:string;candidate:string;outcome:string;sameOutput:boolean;concreteDefectClaimed:boolean}>;
