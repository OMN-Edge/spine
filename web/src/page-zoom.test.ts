import { describe, expect, it } from 'vitest';
import { clampZoom, lockedViewport, scrollForAnchor, ZOOM_MAX } from './page-zoom';

describe('the installed app does not zoom the page', () => {
  it('holds the viewport at its own size, keeping what it said', () => {
    expect(lockedViewport('width=device-width, initial-scale=1.0')).toBe('width=device-width, initial-scale=1.0, maximum-scale=1, user-scalable=no');
  });

  it('replaces a scale the viewport set already, instead of saying it twice', () => {
    expect(lockedViewport('width=device-width,maximum-scale=3, user-scalable=yes')).toBe('width=device-width, maximum-scale=1, user-scalable=no');
  });
});

describe("zooming a document's scan", () => {
  it('stays between fitting the column and five times that', () => {
    expect(clampZoom(0.4)).toBe(1);
    expect(clampZoom(2.5)).toBe(2.5);
    expect(clampZoom(40)).toBe(ZOOM_MAX);
  });

  it('keeps the spot under the fingers under them as the scan grows', () => {
    // The middle of a 400 by 600 scan, held 100 px from the viewer's left and 150 px from its top; at twice the size it is at 400, 600.
    expect(scrollForAnchor({ fx: 0.5, fy: 0.5, x: 100, y: 150 }, 800, 1200)).toEqual({ left: 300, top: 450 });
  });
});
