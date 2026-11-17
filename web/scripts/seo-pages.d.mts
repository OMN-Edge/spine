export interface SeoPage { path: string; title: string; description: string; when?: string }
export function pageHtml(shell: string, page: SeoPage): string;
export function writePages(dir: string, pages: SeoPage[]): string[];
