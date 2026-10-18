import { Fragment, type ReactNode } from 'react';
import { blocksOf } from './markdownBlocks';

/**
 * The small part of Markdown a model's answer uses: paragraphs, bulleted and numbered lists, **bold**, *italic*, `code`, and
 * the citations we ask it to write ([D1.results]), which the caller turns into links. Rendered as React elements, never as
 * HTML, so nothing in an answer can inject markup. Anything else stays as the text it is.
 */
const INLINE = /(\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\s][^*\n]*\*|`[^`\n]+`|\[[DTCS]\d+(?:\.[a-z]+)?\])/g;
const CITATION = /^\[([DTCS]\d+(?:\.[a-z]+)?)\]$/;

export function inline(text: string, cite: (label: string) => ReactNode, depth = 0): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    if (!part) return null;
    const citation = CITATION.exec(part);
    if (citation) return <Fragment key={i}>{cite(citation[1])}</Fragment>;
    if (depth < 2 && /^(\*\*|__)[\s\S]+\1$/.test(part)) return <strong key={i} className="font-semibold">{inline(part.slice(2, -2), cite, depth + 1)}</strong>;
    if (depth < 2 && /^\*[^*\s][^*\n]*\*$/.test(part)) return <em key={i}>{inline(part.slice(1, -1), cite, depth + 1)}</em>;
    if (/^`[^`\n]+`$/.test(part)) return <code key={i} className="rounded bg-gray-100 px-1 text-[0.85em]">{part.slice(1, -1)}</code>;
    return <Fragment key={i}>{part}</Fragment>;
  });
}

export default function Markdown({ text, cite }: { text: string; cite: (label: string) => ReactNode }) {
  return (
    <div className="space-y-2 break-words leading-relaxed">
      {blocksOf(text).map((block, i) => {
        if (block.kind === 'p') return <p key={i} className="whitespace-pre-line">{inline(block.text, cite)}</p>;
        const Tag = block.kind === 'ul' ? 'ul' : 'ol';
        return (
          <Tag key={i} className={`${block.kind === 'ul' ? 'list-disc' : 'list-decimal'} space-y-1 pl-5`}>
            {block.items.map((item, n) => <li key={n} className={item.indent ? 'ml-4' : undefined}>{inline(item.text, cite)}</li>)}
          </Tag>
        );
      })}
    </div>
  );
}
