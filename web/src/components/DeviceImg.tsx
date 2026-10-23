import { useEffect, useState, type ImgHTMLAttributes } from 'react';
import { deviceObjectUrl } from '../core/client';

/** An `<img>` for a picture the device holds (a page of an upload): fetched from the core, shown once it is there. */
export default function DeviceImg({ src, ...rest }: ImgHTMLAttributes<HTMLImageElement> & { src: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setUrl(null);
    deviceObjectUrl(src).then(u => { if (live) setUrl(u); }).catch(() => undefined);
    return () => { live = false; };
  }, [src]);
  // No address until the picture is here (a placeholder as a data: address would need the page's policy to allow data:).
  // eslint-disable-next-line jsx-a11y/alt-text -- the caller gives the alt text in `rest`
  return <img {...rest} src={url ?? undefined} />;
}
