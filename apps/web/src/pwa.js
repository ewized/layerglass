// No install banner or extra player controls: installation uses browser UI.
export async function registerPWA() {
  if (!window.isSecureContext || !('serviceWorker' in navigator)) return null;
  try {
    const registration = await navigator.serviceWorker.register('/service-worker.js', {
      type: 'module', scope: '/', updateViaCache: 'none',
    });
    return registration;
  } catch (error) {
    console.warn('[Layerglass] App registration unavailable', error.name);
    return null;
  }
}

if (document.readyState === 'complete') registerPWA();
else window.addEventListener('load', registerPWA, { once: true });
