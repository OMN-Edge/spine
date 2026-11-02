/**
 * Which of the files a person chose go to Scan and which are uploaded as they are. There is one way in (the Upload area, or the chat's
 * paperclip): a picture goes to Scan, where the page is found and straightened, and everything else is uploaded. A picture this browser
 * cannot draw (an iPhone's HEIC photo in Chrome) cannot be scanned here, so it is uploaded and the server turns it into a JPEG.
 */
const HEIC = /\.(heic|heif)$/i;

const isPicture = (f: File) => f.type.startsWith('image/') || HEIC.test(f.name);

/** Whether this browser can draw the picture (Safari draws HEIC; Chrome and Firefox do not). */
export async function canDraw(file: Blob): Promise<boolean> {
  try {
    const bitmap = await createImageBitmap(file);
    bitmap.close();
    return true;
  } catch {
    return false;
  }
}

export async function routeFiles(files: File[], draws: (f: File) => Promise<boolean> = canDraw): Promise<{ scan: File[]; upload: File[] }> {
  const scan: File[] = [];
  const upload: File[] = [];
  for (const f of files) {
    // JPEG and PNG every browser draws; anything else that is a picture is tried.
    const easy = f.type === 'image/jpeg' || f.type === 'image/png';
    if (isPicture(f) && (easy || (await draws(f)))) scan.push(f);
    else upload.push(f);
  }
  return { scan, upload };
}

/**
 * How Scan first treats a picture. A camera saves JPEG or HEIC; a screenshot, or an image made on a computer (a portal's page, an image a
 * clinic sent), is PNG or GIF. That is a surer sign than looking for the page: a screenshot's header bar is found as a page's edge.
 *  - A picture made on a screen is the page as it is: the whole of it, not cleaned up (there are no paper edges to straighten, and
 *    cleaning flattens a screen's colours), and no corners are asked for.
 *  - A photo with a page found in it has its corners shown to check, and is cleaned up (shadows and fading).
 *  - A photo with no page found is shown with corners to place, as before: it is still a photo of paper.
 */
export const madeOnScreen = (picture: Blob) => picture.type === 'image/png' || picture.type === 'image/gif';

export function firstLook({ onScreen }: { onScreen: boolean }): { askCorners: boolean; filter: 'clean' | 'original' } {
  return onScreen ? { askCorners: false, filter: 'original' } : { askCorners: true, filter: 'clean' };
}
