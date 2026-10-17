/** How much real text a page has, by non-whitespace characters, so a scan whose only text is a stray page number does not count as having a text layer. */
export const textCharsOf = (page: { elements: Array<{ text: string }> } | undefined): number =>
  (page?.elements ?? []).reduce((sum, element) => sum + element.text.replace(/\s+/g, '').length, 0);
