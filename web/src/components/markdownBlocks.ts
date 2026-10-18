/** Markdown lines into paragraphs and lists, for `Markdown.tsx`. Pure, so it can be checked on its own. */
export type Block =
  | { kind: 'p'; text: string }
  | { kind: 'ul' | 'ol'; items: Array<{ text: string; indent: number }> };

const BULLET = /^(\s*)[*\-•]\s+(.*)$/;
const NUMBER = /^(\s*)\d+[.)]\s+(.*)$/;

/** Lines into paragraphs and lists. A heading line becomes a bold paragraph; a blank line ends a block. */
export function blocksOf(text: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = () => { if (paragraph.length) { blocks.push({ kind: 'p', text: paragraph.join('\n') }); paragraph = []; } };
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const bullet = BULLET.exec(line); const number = bullet ? null : NUMBER.exec(line);
    const match = bullet ?? number;
    if (match) {
      flush();
      const kind = bullet ? 'ul' : 'ol';
      const last = blocks[blocks.length - 1];
      const item = { text: match[2], indent: match[1].length >= 2 ? 1 : 0 };
      if (last && last.kind === kind) last.items.push(item); else blocks.push({ kind, items: [item] });
    } else if (!line.trim()) {
      flush();
    } else if (/^#{1,4}\s+/.test(line)) {
      flush();
      blocks.push({ kind: 'p', text: `**${line.replace(/^#{1,4}\s+/, '').replace(/\*\*/g, '')}**` });
    } else if (blocks[blocks.length - 1] && blocks[blocks.length - 1]!.kind !== 'p' && /^\s{2,}\S/.test(line)) {
      // A wrapped continuation of the last list item.
      const list = blocks[blocks.length - 1] as Extract<Block, { items: unknown }>;
      list.items[list.items.length - 1].text += ` ${line.trim()}`;
    } else {
      paragraph.push(line);
    }
  }
  flush();
  return blocks;
}

