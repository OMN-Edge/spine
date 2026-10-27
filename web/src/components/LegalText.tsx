import { Fragment, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

/**
 * The small Markdown of the legal texts: headings, paragraphs, bullet lists, tables, **bold** and links. Rendered as elements, never
 * as HTML. A link to a page of the app (`/terms`) is a router link; any other opens in a new tab with no referrer.
 */
const INLINE = /(\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^)\s]+\))/g;

function inline(text: string): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    if (!part) return null;
    const bold = /^\*\*([^*\n]+)\*\*$/.exec(part);
    if (bold) return <strong key={i} className="font-semibold">{bold[1]}</strong>;
    const link = /^\[([^\]\n]+)\]\(([^)\s]+)\)$/.exec(part);
    if (link) {
      return link[2].startsWith('/')
        ? <Link key={i} to={link[2]} className="text-brand-600 hover:underline">{link[1]}</Link>
        : <a key={i} href={link[2]} target="_blank" rel="noopener noreferrer" className="text-brand-600 hover:underline">{link[1]}</a>;
    }
    return <Fragment key={i}>{part}</Fragment>;
  });
}

export default function LegalText({ markdown }: { markdown: string }) {
  const blocks = markdown.trim().split(/\n{2,}/);
  return (
    <div className="space-y-3 text-sm text-gray-700 leading-relaxed">
      {blocks.map((block, i) => {
        const lines = block.split('\n');
        const heading = /^(#{1,3})\s+(.*)$/.exec(lines[0]);
        if (heading && lines.length === 1) {
          const level = heading[1].length;
          return level === 1
            ? <h1 key={i} className="text-2xl font-semibold text-gray-900">{heading[2]}</h1>
            : <h2 key={i} className="text-base font-semibold text-gray-900 pt-2">{heading[2]}</h2>;
        }
        if (lines.every(l => l.startsWith('- '))) {
          return <ul key={i} className="list-disc pl-5 space-y-1">{lines.map((l, n) => <li key={n}>{inline(l.slice(2))}</li>)}</ul>;
        }
        if (lines.length >= 2 && lines.every(l => l.startsWith('|'))) {
          const rows = lines.map(l => l.replace(/^\||\|$/g, '').split('|').map(c => c.trim()));
          const [head, , ...body] = rows;
          return (
            <div key={i} className="overflow-x-auto">
              <table className="w-full text-xs border-collapse">
                <thead><tr>{head.map((c, n) => <th key={n} className="text-left font-medium text-gray-900 border-b border-gray-200 py-1.5 pr-3 align-top">{inline(c)}</th>)}</tr></thead>
                <tbody>{body.map((r, n) => <tr key={n}>{r.map((c, m) => <td key={m} className="border-b border-gray-100 py-1.5 pr-3 align-top">{inline(c)}</td>)}</tr>)}</tbody>
              </table>
            </div>
          );
        }
        return <p key={i}>{inline(lines.join(' '))}</p>;
      })}
    </div>
  );
}
