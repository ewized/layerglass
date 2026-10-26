export interface PreviewSample {
  bucket: number;
  time: number;
  cell: number;
}
export interface PreviewFrame extends PreviewSample {
  asset: string;
  capture: boolean;
}
export interface PreviewAsset {
  key: string;
  blob: Blob | null;
  size: number;
  columns: number;
  rows: number;
  refs: Set<number>;
  owner: string;
  writing: boolean;
  persisted: boolean;
}
export interface PreviewMatch {
  frame: PreviewFrame;
  asset: PreviewAsset;
}
export interface PreviewRecord {
  session: string;
  key: string;
  blob: Blob;
  columns: number;
  rows: number;
  frames: PreviewSample[];
  owner: string;
}
export interface StoredPreview extends Omit<PreviewRecord, 'blob'> {
  blob?: Blob;
  data: ArrayBuffer;
  type: string;
  size: number;
  created: number;
}
export interface PreviewSheet {
  start: number;
  count: number;
  index?: number;
}
export type PreviewBitmap = ImageBitmap | (HTMLImageElement & { close?: () => void });
