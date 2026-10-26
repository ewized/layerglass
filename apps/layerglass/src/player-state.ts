import type Hls from 'hls.js';
import type {
  CameraInfo,
  DiscoveryInfo,
  PrinterTelemetry,
  StreamStatus,
} from '../../backend-contracts/src/index.js';
import type { PageReplay } from './replay.js';
import type { PlayerVideoStream } from './video-stream.js';
import type { PreviewHistory } from './preview-history.js';
import type { PrinterHistory } from './printer-history.js';

export interface PlayerState {
  camera?: CameraInfo;
  printer?: PrinterTelemetry | null;
  server: StreamStatus | null;
  printerHistory: PrinterHistory;
  previewHistory: PreviewHistory;
  discovery?: DiscoveryInfo;
  replay: PageReplay;
  hls: Hls | null;
  videoStream: PlayerVideoStream | null;
  videoCodec: string | null;
}
export type ReadPlayerState = () => PlayerState;
export interface PlayerIdentity {
  model: string;
  id: string;
}
