import { promises } from './fs';
export const { readFile, writeFile, readdir, rm, mkdir, mkdtemp, stat } = promises;
export default promises;
