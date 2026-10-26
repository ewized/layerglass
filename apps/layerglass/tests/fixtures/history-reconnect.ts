import fixture from './history-reconnect.json' with { type: 'json' };
import { installCastFixture } from '../cast-fixture.ts';
import { testDouble } from '../test-doubles.ts';
import '/static/components/index.js';
import { required } from '/static/dom.js';
import { PageReplay } from '/static/replay.js';
import type { RemoteReplay } from '/static/replay.js';
import type { PlayerState } from '/static/player-state.js';
import { PrinterHistory } from '/static/printer-history.js';
import { GoogleCastSender } from '/static/cast-sender.js';
import { PlayerUpdates } from '/static/updates.js';

const player = required<HTMLElementTagNameMap['printer-player']>(document, '#player');
const video = required<HTMLVideoElement>(player, 'video');
const image = required<HTMLImageElement>(player, '#jpeg');
const stats = required<HTMLElementTagNameMap['printer-stats']>(player, '#player-stats');
const replay: InstanceType<typeof PageReplay> = new PageReplay(video, image, () => 170);
if (fixture.before.replay.kind !== 'hls') throw new Error('Expected the HLS history fixture');
replay.session = { ...fixture.before.replay, kind: fixture.before.replay.kind };
const history = new PrinterHistory(() => stats.renderStats());
history.setSession(replay.session);
stats.configure({
  player,
  video,
  image,
  readState: () =>
    testDouble<PlayerState>({
      replay,
      printerHistory: history,
      camera: { id: fixture.camera, model_name: 'Generated fixture printer' },
      discovery: { state: 'done' },
    }),
});

let sender: GoogleCastSender | RemoteReplay;
let move: (time: number) => void;
let castEligible: boolean;
if (document.body.dataset.engine === 'chromium') {
  const sdk = installCastFixture(window);
  sdk.range = { start: 0, end: replay.session!.end_seconds };
  const cast = new GoogleCastSender(
    video,
    replay,
    () => ({ model: 'Fixture', id: fixture.camera }),
    () => {},
  );
  sender = cast;
  cast.setSource(`/replay/${fixture.session}/live.m3u8`);
  await cast.initializing;
  if (!cast.ready) throw new Error('The Chromium fixture requires the supported Cast sender.');
  await cast.request();
  move = (current) => {
    sdk.range.end = replay.session!.end_seconds;
    sdk.advance(current, true);
  };
  castEligible = cast.eligible;
} else {
  castEligible = new GoogleCastSender(
    video,
    replay,
    testDouble<ConstructorParameters<typeof GoogleCastSender>[2]>(() => ({})),
    () => {},
  ).eligible;
  if (castEligible) throw new Error('WebKit must remain Cast-ineligible.');
  let current = 20;
  sender = testDouble<RemoteReplay>({
    paused: true,
    bounds: () => ({ start: 0, end: replay.session!.end_seconds, current }),
    seek: (value) => {
      current = value;
      replay.position = value;
    },
    togglePause() {},
  });
  replay.setRemote(sender);
  move = (value) => {
    current = value;
    replay.position = value;
    replay.render();
  };
}
export const app = {
  player,
  video,
  stats,
  replay,
  history,
  sender,
  move,
  castEligible,
  states: 0,
  unavailable: 0,
  replayEvents: 0,
  nativeSeeks: 0,
  updates: null as PlayerUpdates | null,
};
window.app = app;
window.addEventListener('replaypositionchange', () => app.replayEvents++);
video.addEventListener('seeked', () => app.nativeSeeks++);
const updates = (app.updates = new PlayerUpdates(
  (state) => {
    app.states++;
    if (Object.hasOwn(state, 'replay')) replay.updateMetadata(state.session_id!, state.replay!);
    if (state.telemetry) history.apply(state.telemetry, false);
  },
  () => app.unavailable++,
));
updates.subscribe(fixture.camera, fixture.session);
window.ready = true;
