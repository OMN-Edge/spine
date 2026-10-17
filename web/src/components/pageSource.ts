import { msg } from '../i18n';

/** How a page's text was read: the label shown beside it. */
export const SOURCE_LABEL: Record<string, string> = {
  native_text: msg('text layer'),
  ocr: msg('OCR'),
  mixed: msg('text layer and OCR'),
  multimodal: msg('AI'),
  unread: msg('not read'),
};

export const sourceLabel = (source: string | null | undefined) => (source ? SOURCE_LABEL[source] ?? source : msg('unknown'));

/** The chip beside a page: how its text was read, in a word, with what that means on hover. */
export const SOURCE_CHIP: Record<string, { text: string; style: string; hint: string }> = {
  native_text: { text: msg('Text layer'), style: 'bg-gray-100 text-gray-600', hint: msg('The text was in the PDF itself: exact, and positions can be highlighted.') },
  ocr: { text: msg('OCR'), style: 'bg-amber-100 text-amber-700', hint: msg('Read by local OCR. It can misread, especially handwriting.') },
  mixed: { text: msg('Text layer + OCR'), style: 'bg-gray-100 text-gray-600', hint: msg('Part of the text was in the PDF and part was read by OCR.') },
  multimodal: { text: msg('AI'), style: 'bg-purple-100 text-purple-700', hint: msg('Read by an AI model. It gives the text, not where on the page it is, so nothing is highlighted.') },
  unread: { text: msg('Not read'), style: 'bg-red-100 text-red-700', hint: msg('Nothing could read this page. Use Read again to try once more.') },
};
