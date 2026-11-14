import type { ServerResponse } from 'node:http';
export function respondBehaviorFixture(input: any, response: ServerResponse, options?: { skip?: boolean; fail?: boolean }): boolean;

export function fixturePhase(input: any): string | undefined;
