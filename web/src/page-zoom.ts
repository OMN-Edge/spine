/** Whether the page runs as the installed app (added to a home screen or installed from the browser), not in a browser tab. */
export function isInstalledApp(): boolean {
  const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return iosStandalone || (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches);
}

/** The viewport's content with the page held at its own size: no pinch zoom, and no zoom when a field is focused. */
export function lockedViewport(content: string): string {
  const kept = content.split(',').map(part => part.trim()).filter(part => part && !/^(maximum-scale|minimum-scale|user-scalable)\s*=/.test(part));
  return [...kept, 'maximum-scale=1', 'user-scalable=no'].join(', ');
}

/**
 * In the installed app the page itself does not zoom, as an app's screens do not: a pinch zooms only a document's scan
 * (PageImageOverlay), which takes the gesture first. In a browser tab the page still zooms, for small print. iOS ignores
 * user-scalable=no in places, so its own pinch events are stopped too; they are what Safari zooms the page with.
 */
export function lockPageZoomInInstalledApp(): void {
  if (!isInstalledApp()) return;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (meta) meta.content = lockedViewport(meta.content);
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(type, e => e.preventDefault(), { passive: false });
  }
}

/** How far a document's scan zooms: from fitting its column to five times that. */
export const ZOOM_MIN = 1;
export const ZOOM_MAX = 5;
export const clampZoom = (scale: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale));

/** A spot on the scan, as a share of its width and height, and where in the viewer it should sit. */
export interface ZoomAnchor { fx: number; fy: number; x: number; y: number }

/** The viewer's scroll that puts the anchor's spot of a scan `width` by `height` at its place in the viewer. */
export function scrollForAnchor(anchor: ZoomAnchor, width: number, height: number): { left: number; top: number } {
  return { left: anchor.fx * width - anchor.x, top: anchor.fy * height - anchor.y };
}
