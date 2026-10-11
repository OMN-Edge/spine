/** How a page's text was read: the label shown beside it. */
export const SOURCE_LABEL: Record<string, string> = {
  native_text: 'text layer',
  ocr: 'OCR',
  mixed: 'text layer and OCR',
  multimodal: 'AI',
};

export const sourceLabel = (source: string | null | undefined) => (source ? SOURCE_LABEL[source] ?? source : 'unknown');
