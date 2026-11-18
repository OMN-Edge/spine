import { PDFDocument, rgb, type PDFFont } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import QRCode from 'qrcode';

/**
 * A sheet for a share link (the owner's request): one A4 page with the link as text and as a code to scan, who shared, why, until when and what the reader can and cannot do, for the owner to
 * print or send. It is made on the device from the link the owner just made, in the language of the link (the doctor's) where it has one, else the owner's; nothing is sent anywhere. The
 * address carries the key after `#`, so the sheet is as private as the link is: whoever holds it can open the records, and it says so.
 */
export type SheetLanguage = 'en' | 'ro' | 'fr' | 'de';

interface Words { title: string; by: string; why: string; open: string; scan: string; until: string; readOnly: string; approval: string; anyone: string; footer: string }

const WORDS: Record<SheetLanguage, Words> = {
  en: { title: 'Medical records shared with you', by: 'Shared by {name}', why: 'Why', open: 'Open this link', scan: 'Scan the code with a phone camera, or type the link into a browser.', until: 'Open until {date}', readOnly: 'You can read it and ask for nothing to be changed. Opening it is recorded for the person who shared it: the time, the country and which document you open.', approval: 'The person who shared it approves each browser first: ask for access on the page, and read them the code you are shown.', anyone: 'Anyone who has this link or code can read the records until it ends. Keep the sheet as private as the records.', footer: 'Shared securely via Spine' },
  ro: { title: 'Documente medicale partajate cu tine', by: 'Partajat de {name}', why: 'De ce', open: 'Deschide acest link', scan: 'Scanează codul cu camera telefonului sau scrie linkul într-un browser.', until: 'Deschis până la {date}', readOnly: 'Le poți citi, dar nu poți schimba nimic. Deschiderea este înregistrată pentru persoana care le-a partajat: ora, țara și documentul pe care îl deschizi.', approval: 'Persoana care le-a partajat aprobă mai întâi fiecare browser: cere acces pe pagină și citește-i codul care ți se arată.', anyone: 'Oricine are acest link sau cod poate citi documentele până la expirare. Păstrează foaia la fel de privată ca documentele.', footer: 'Partajat în siguranță prin Spine' },
  fr: { title: 'Dossier médical partagé avec vous', by: 'Partagé par {name}', why: 'Pourquoi', open: 'Ouvrir ce lien', scan: 'Scannez le code avec l’appareil photo d’un téléphone, ou saisissez le lien dans un navigateur.', until: 'Ouvert jusqu’au {date}', readOnly: 'Vous pouvez le lire, sans rien pouvoir modifier. L’ouverture est enregistrée pour la personne qui l’a partagé : l’heure, le pays et le document que vous ouvrez.', approval: 'La personne qui l’a partagé approuve d’abord chaque navigateur : demandez l’accès sur la page et lisez-lui le code affiché.', anyone: 'Toute personne qui a ce lien ou ce code peut lire le dossier jusqu’à son expiration. Gardez cette feuille aussi privée que le dossier.', footer: 'Partagé en toute sécurité via Spine' },
  de: { title: 'Mit Ihnen geteilte Krankenunterlagen', by: 'Geteilt von {name}', why: 'Warum', open: 'Diesen Link öffnen', scan: 'Scannen Sie den Code mit der Kamera eines Telefons oder geben Sie den Link in einen Browser ein.', until: 'Offen bis {date}', readOnly: 'Sie können die Unterlagen lesen, aber nichts ändern. Das Öffnen wird für die Person festgehalten, die sie geteilt hat: Zeit, Land und welches Dokument Sie öffnen.', approval: 'Die Person, die sie geteilt hat, gibt zuerst jeden Browser frei: Fragen Sie auf der Seite nach Zugang und lesen Sie ihr den angezeigten Code vor.', anyone: 'Jeder, der diesen Link oder Code hat, kann die Unterlagen bis zum Ablauf lesen. Bewahren Sie das Blatt so privat auf wie die Unterlagen.', footer: 'Sicher geteilt über Spine' },
};

export interface SheetInput {
  url: string;
  language: SheetLanguage;
  /** When the link ends (ISO). */
  expiresAt: string;
  /** Whose records, if the owner chose to say; and a note for the doctor. */
  by?: string | null;
  note?: string | null;
  /** The owner approves each browser: the address carries no key. */
  needsApproval: boolean;
}

const fill = (text: string, values: Record<string, string>) => text.replace(/\{(\w+)\}/g, (_, k: string) => values[k] ?? '');
const day = (iso: string, language: SheetLanguage) => new Intl.DateTimeFormat({ en: 'en-GB', ro: 'ro-RO', fr: 'fr-FR', de: 'de-DE' }[language], language === 'en' ? { day: 'numeric', month: 'short', year: 'numeric' } : { day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(iso));

/** A line broken into lines that fit a width, at spaces where there are any and anywhere for a long address. */
export function wrap(text: string, face: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    let current = '';
    for (const word of raw.split(/(\s+)/)) {
      for (const piece of face.widthOfTextAtSize(word, size) > width ? word.match(new RegExp(`.{1,${Math.max(8, Math.floor(width / (face.widthOfTextAtSize('0', size) || 6)))}}`, 'g')) ?? [word] : [word]) {
        if (current && face.widthOfTextAtSize((current + piece).trimEnd(), size) > width) { out.push(current.trimEnd()); current = piece.trimStart(); } else current += piece;
      }
    }
    out.push(current.trimEnd());
  }
  return out;
}

export async function makeShareSheet(input: SheetInput, fonts: { regular: ArrayBuffer | Uint8Array; bold?: ArrayBuffer | Uint8Array }): Promise<Uint8Array> {
  const w = WORDS[input.language];
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const face = await doc.embedFont(fonts.regular, { subset: true });
  const bold = fonts.bold ? await doc.embedFont(fonts.bold, { subset: true }) : face;
  const page = doc.addPage([595.28, 841.89]);
  const M = 56;
  const width = 595.28 - 2 * M;
  const ink = rgb(0.11, 0.1, 0.09), muted = rgb(0.47, 0.44, 0.42), accent = rgb(0.06, 0.46, 0.43);
  let y = 841.89 - M;
  const write = (text: string, size: number, font: PDFFont, color = ink, gap = 6) => {
    for (const line of wrap(text, font, size, width)) {
      y -= size * 1.25;
      if (line) page.drawText(line, { x: M, y, size, font, color });
    }
    y -= gap;
  };
  write(w.title, 22, bold, ink, 8);
  if (input.by) write(fill(w.by, { name: input.by }), 12, face, muted, 4);
  write(fill(w.until, { date: day(input.expiresAt, input.language) }), 12, face, muted, 14);
  if (input.note) { write(w.why, 9, bold, accent, 0); write(input.note, 12, face, ink, 14); }

  const qr = await doc.embedPng(await QRCode.toDataURL(input.url, { margin: 1, width: 520, errorCorrectionLevel: 'M' }));
  const side = 200;
  y -= side;
  page.drawImage(qr, { x: M, y, width: side, height: side });
  page.drawText(w.open, { x: M + side + 24, y: y + side - 14, size: 14, font: bold, color: accent });
  let sy = y + side - 14;
  for (const line of wrap(w.scan, face, 11, width - side - 24)) { sy -= 15; page.drawText(line, { x: M + side + 24, y: sy, size: 11, font: face, color: ink }); }
  y -= 22;
  write(input.url, 9.5, face, ink, 14);
  write(input.needsApproval ? w.approval : w.anyone, 10.5, face, ink, 8);
  write(w.readOnly, 10.5, face, muted, 8);
  page.drawText(w.footer, { x: M, y: M - 8, size: 9, font: face, color: muted });
  return doc.save();
}

/** The language a sheet is written in: the link's own where the screens are written in it, else the owner's, else English. */
export function sheetLanguage(link: string | null | undefined, owner: string | null | undefined): SheetLanguage {
  const ok = (l: string | null | undefined): l is SheetLanguage => l === 'ro' || l === 'fr' || l === 'de' || l === 'en';
  return ok(link) ? link : ok(owner) ? owner : 'en';
}

let fontFile: Promise<ArrayBuffer> | null = null;
/** DejaVu Sans, served from this origin (the font has the accents of all four languages). */
export const sheetFonts = async (): Promise<{ regular: ArrayBuffer }> => ({ regular: await (fontFile ??= fetch(`${import.meta.env?.BASE_URL ?? '/'}fonts/DejaVuSans.ttf`).then(r => r.arrayBuffer())) });
