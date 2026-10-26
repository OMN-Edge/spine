import { describe, it, expect, afterEach, vi } from 'vitest';
import { NATIVE_TOOL_NAMES, nativeTools, useNativeTools, type NativeTools } from '../native-tools.js';
import { rasterizePdf } from '../ingestion/rasterize.js';
import { ocrPage } from '../parser/ocr.js';
import { rotateImage } from '../ingestion/image-ops.js';
import { readSignatures } from '../ingestion/signatures.js';
import { ZipReader, ZipTooLarge } from '../archive/zip-read.js';
import { newZip } from '../archive/zip-write.js';
import { countryOf } from '../geo.js';

/**
 * The shared package asks the host for what it cannot do itself. The files that used to hold the Node versions keep their names and
 * signatures, so the callers did not change; here they are held to passing the call on, and to failing in words when there is nobody to ask.
 */
afterEach(() => useNativeTools(null));

const fakeTools = (): NativeTools & Record<string, ReturnType<typeof vi.fn>> => Object.fromEntries(NATIVE_TOOL_NAMES.map(name => [name, vi.fn(async () => name)])) as never;

describe('the native tools', () => {
  it('say what is missing, in words, when no host has brought any', () => {
    expect(() => nativeTools()).toThrow(/no native tools have been registered/);
    expect(() => rasterizePdf('id', '/x.pdf')).toThrow(/no native tools have been registered/);
  });

  it('are asked, with the same arguments, by the files that kept their names', async () => {
    const tools = fakeTools();
    useNativeTools(tools);
    await rasterizePdf('upload-1', '/data/a.pdf');
    await ocrPage('/p.png', 3, 'ron+eng');
    await rotateImage('/in.png', '/out.png', 90);
    await readSignatures('/a.pdf', [2, 3], 5000);
    await ZipReader.open('/a.zip', 7);
    newZip();
    await countryOf('203.0.113.9', { SPINE_GEOIP_DB: 'x' } as NodeJS.ProcessEnv);
    expect(tools.rasterizePdf).toHaveBeenCalledWith('upload-1', '/data/a.pdf');
    expect(tools.ocrPage).toHaveBeenCalledWith('/p.png', 3, 'ron+eng');
    expect(tools.rotateImage).toHaveBeenCalledWith('/in.png', '/out.png', 90);
    expect(tools.readSignatures).toHaveBeenCalledWith('/a.pdf', [2, 3], 5000);
    expect(tools.openZip).toHaveBeenCalledWith('/a.zip', 7);
    expect(tools.newZip).toHaveBeenCalledTimes(1);
    expect(tools.countryOf).toHaveBeenCalledWith('203.0.113.9', { SPINE_GEOIP_DB: 'x' });
  });

  it('are listed once each, and the list is the interface', () => {
    expect(new Set(NATIVE_TOOL_NAMES).size).toBe(NATIVE_TOOL_NAMES.length);
  });

  it('share one error for a zip entry that is too large, whichever host read the zip', () => {
    expect(new ZipTooLarge()).toBeInstanceOf(Error);
    expect(new ZipTooLarge().name).toBe('ZipTooLarge');
  });
});
