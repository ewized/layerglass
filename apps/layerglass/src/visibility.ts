// Playback follows the visible player document or the browser's native video
// PiP surface or cast receiver, including when the original tab is in the background.
let playerDocument: Document | null = null;
let nativePictureInPicture = false;
let remotePlayback = false;
const changed = () => window.dispatchEvent(new Event('playerviewchange'));

export function playerVisible() {
  return nativePictureInPicture || remotePlayback || !(playerDocument || document).hidden;
}

export function setRemotePlayback(active: boolean) {
  active = Boolean(active);
  if (remotePlayback === active) return;
  remotePlayback = active;
  changed();
}

export function setNativePictureInPicture(active: boolean) {
  active = Boolean(active);
  if (nativePictureInPicture === active) return;
  nativePictureInPicture = active;
  changed();
}

export function setPlayerDocument(next: Document | null) {
  playerDocument?.removeEventListener('visibilitychange', changed);
  playerDocument = next === document ? null : next;
  playerDocument?.addEventListener('visibilitychange', changed);
  changed();
}
