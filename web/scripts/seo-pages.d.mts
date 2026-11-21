export interface SeoPage { path: string; title: string; description: string; when?: string }
export function pageHtml(shell: string, page: SeoPage, body?: string): string;
export function writePages(dir: string, pages: SeoPage[], bodies?: Record<string, string>): string[];
