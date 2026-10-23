/** `fileURLToPath` for code that asks where its own file is: in a worker that is an http address, and its path is as good an answer. */
export const fileURLToPath = (url: string | URL): string => new URL(String(url)).pathname;
export const pathToFileURL = (path: string): URL => new URL(`file://${path}`);
export default { fileURLToPath, pathToFileURL };
