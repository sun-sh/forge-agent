import type { ServerResponse } from 'node:http';
export const behaviorFixtureSource: Readonly<{ path: string; baseline: string; implemented: string }>;
export function seedBehaviorFixture(project: string): Promise<void>;
export function behaviorFixtureWrite(input: any): { name: 'write'; arguments: { path: string; content: string } } | undefined;
export function implementBehaviorFixture(project: string, input: any): Promise<boolean>;
export function respondBehaviorFixture(input: any, response: ServerResponse, options?: { skip?: boolean; fail?: boolean }): boolean;

export function fixturePhase(input: any): string | undefined;
