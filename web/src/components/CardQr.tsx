import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

/**
 * A QR code drawn dark on white whatever the theme (a scanner needs that), from text. `snow` is white in both themes. The code is made
 * here, in the page, and what it holds goes nowhere else.
 */
export default function CardQr({ text, level = 'M', label }: { text: string; level?: 'L' | 'M' | 'Q'; label: string }) {
  const [svg, setSvg] = useState('');
  useEffect(() => {
    let live = true;
    QRCode.toString(text, { type: 'svg', margin: 2, errorCorrectionLevel: level }).then(s => live && setSvg(s)).catch(() => live && setSvg(''));
    return () => { live = false; };
  }, [text, level]);
  return svg ? <div role="img" aria-label={label} className="w-48 h-48 bg-snow p-1 rounded [&>svg]:w-full [&>svg]:h-full" dangerouslySetInnerHTML={{ __html: svg }} /> : null;
}
