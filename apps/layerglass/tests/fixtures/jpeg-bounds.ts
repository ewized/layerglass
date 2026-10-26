import { required } from '/static/dom.js';
import { PreviewHistory, PreviewCapture } from '/static/preview-history.js';
import { PageReplay } from '/static/replay.js';
import type { PrinterScrubPreview } from '/static/components/scrub-preview.js';
import type { PreviewFrame } from '/static/preview-types.js';
import type { ClockPoint, JpegFrame, ReplaySession } from '../../../backend-contracts/src/index.js';
import type { TestDouble } from '../test-doubles.ts';

export type JpegFixtureSession = ReplaySession & {
  kind: 'jpeg';
  jpeg_frame: JpegFrame;
  clock: [ClockPoint, ...ClockPoint[]];
};
export interface JpegBoundsFixture {
  preview: PrinterScrubPreview;
  history: PreviewHistory;
  capture: PreviewCapture;
  replay: PageReplay;
  image: HTMLImageElement;
  reads: string[];
  url?: string;
  before?: { frame: PreviewFrame; cold: boolean; disk: boolean; metadata: ReplaySession };
}

export async function closeJpegBounds() {
  const fixture = window.jpegBounds;
  if (!fixture) return;
  fixture.capture.close();
  fixture.preview.reset();
  const token = fixture.history.token!;
  fixture.history.setSession(null);
  await fixture.history.disk!.removeSession(token);
  if (fixture.url) URL.revokeObjectURL(fixture.url);
  fixture.image.remove();
  window.jpegBounds = null;
}

export async function setupJpegBounds(metadata: JpegFixtureSession, captureFrame = true) {
  await closeJpegBounds();
  const preview = required<PrinterScrubPreview>(document, 'printer-scrub-preview');
  const video = window.originalVideo;
  const session = structuredClone(metadata);
  const precise = metadata.jpeg_frame.start;
  const image = document.createElement('img');
  document.body.append(image);
  const history = new PreviewHistory({ maxBytes: captureFrame ? 1 : 32 * 1024 * 1024 });
  const replay: InstanceType<typeof PageReplay> = Object.assign(
    Object.create(PageReplay.prototype) as PageReplay,
    {
      session,
      video,
      image,
      version: 0,
      backend: { id: 'python' },
      paused: true,
      followLive: false,
      position: precise,
      imageFrame: null,
      imageLoading: false,
      timeline: { edge: session.end_seconds + 5 },
    } satisfies TestDouble<PageReplay>,
  );
  const capture = new PreviewCapture(history, video, image, () => replay);
  preview.configure(() => replay, history, capture);
  preview.slider!.min = '0';
  preview.slider!.max = '30';
  preview.slider!.disabled = false;
  const fixture: JpegBoundsFixture = { preview, history, capture, replay, image, reads: [] };
  window.jpegBounds = fixture;
  if (captureFrame) {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 180;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Missing fixture canvas context');
    context.fillStyle = '#0000ff';
    context.fillRect(0, 0, 320, 180);
    const blob = (await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg')))!;
    if (!blob) throw new Error('Missing fixture JPEG');
    fixture.url = URL.createObjectURL(blob);
    image.src = fixture.url;
    await image.decode();
    replay.imageFrame = {
      position: precise,
      time: metadata.clock[0].time + precise - metadata.clock[0].position,
      url: fixture.url,
      source: image.currentSrc || image.src,
      session: session.session_id,
      camera: session.camera_id,
      version: replay.version,
    };
    image.dispatchEvent(new Event('replayimagechange'));
    const deadline = performance.now() + 3000;
    while (!history.assets.get('frame:10')?.persisted || history.writes.size) {
      if (performance.now() > deadline) throw new Error('Owned native JPEG did not persist');
      await new Promise(requestAnimationFrame);
    }
    fixture.before = {
      frame: { ...history.frames.get(10)! },
      cold: !history.assets.get('frame:10')!.blob,
      disk: Boolean(await history.disk!.get(history.token!, 'frame:10')),
      metadata: structuredClone(session),
    };
    Object.defineProperty(history, 'maxBytes', { value: 32 * 1024 * 1024 });
  }
  const get = history.disk!.get.bind(history.disk);
  history.disk!.get = (...args) => {
    fixture.reads.push(args[1]);
    return get(...args);
  };
}

export async function readJpegBounds() {
  const fixture = window.jpegBounds;
  if (!fixture) throw new Error('The JPEG fixture has not been initialized');
  const { preview, history, replay, before, reads } = fixture;
  return {
    before,
    metadata: structuredClone(replay.session!),
    point: preview.point?.time,
    sheet: preview.sheet,
    displayed: preview.displayed,
    hidden: preview.hidden,
    clock: preview.clock!.textContent,
    pixel: [...preview.context!.getImageData(160, 90, 1, 1).data],
    frames: [...history.frames.values()],
    captured: history.assets.has('frame:10'),
    disk: Boolean(await history.disk!.get(history.token!, 'frame:10')),
    reads: [...reads],
    bytes: history.bytes,
    limit: history.maxBytes,
    decodedBytes: preview.bitmapBytes,
  };
}

window.closeJpegBounds = closeJpegBounds;
window.setupJpegBounds = setupJpegBounds;
window.readJpegBounds = readJpegBounds;
