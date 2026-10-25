// Retain device preferences from installations predating the generic identity.
// Only compatibility code keeps the previous storage keys.
const cameraKey = 'printer-camera';
const legacyCameraKey = 'bambu-camera';
export const reloadKey = 'printerCameraReload';
export const legacyReloadKey = 'bambuPlayerReload';

export function readCamera() {
  try {
    const current = localStorage.getItem(cameraKey);
    const previous = localStorage.getItem(legacyCameraKey);
    if (current || previous) writeCamera(current || previous);
    return current || previous;
  } catch (_) { return null; }
}

export function writeCamera(id) {
  try {
    if (id) localStorage.setItem(cameraKey, id);
    else localStorage.removeItem(cameraKey);
    localStorage.removeItem(legacyCameraKey);
  } catch (_) { /* Device preferences are optional. */ }
}
