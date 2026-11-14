export const replaySha256: (value: string | Buffer) => string;
export const frozenCaseSchema: import('zod').ZodType<any>;
export function prepareFrozenReplay(spec: any, source: any, grade: any, patchBytes: Buffer, snapshotBytes: Buffer, request: any, officialBytes: Buffer): {worker: any; originalTaskId: string; entries: any[]};
