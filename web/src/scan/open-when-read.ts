/**
 * From "Take a photo" to the letter in the reader's language with no screen between the scan and the document (T-27): the Upload page follows the scan it was sent from, and when that upload
 * has been read as one document, with nothing left to check, it opens it. Several documents, or one still being read or waiting for the model, stay on the Upload page as before.
 */
export interface UploadStatus { status: string; reading?: boolean; waiting?: unknown; grouping_confirmed?: boolean; documents?: Array<{ id: string }> }

export function documentToOpen(status: UploadStatus): string | null {
  if (status.status !== 'done' || status.reading || status.waiting) return null;
  if (status.grouping_confirmed === false) return null;
  return status.documents?.length === 1 ? status.documents[0]!.id : null;
}
