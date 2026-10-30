export const HASHES_FILE: string;
export function listFiles(dir: string, base?: string): string[];
export function addIntegrity(html: string, dir: string): string;
export function hashLines(dir: string): string[];
export function buildPathLeaks(dir: string, root: string): string[];
export function sealBuild(dir: string, root: string): string[];
