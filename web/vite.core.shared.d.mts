export const REPLACED: Record<string, string>;
export const coreAliases: Array<{ find: RegExp; replacement: string }>;
export function corePlugins(options?: { inNode?: boolean }): unknown[];
export function nodeModules(): unknown;
export function coreAssets(): unknown;
