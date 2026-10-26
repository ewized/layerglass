export const backendPickerTemplate = `
    <div class="backend-welcome">
      <p class="backend-brand"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5"/></svg>LayerGlass</p>
      <section data-backend-page="choose" aria-labelledby="backend-welcome-title">
        <h1 id="backend-welcome-title">Choose your backend</h1>
        <p class="backend-intro">Try the demo or connect to your own hardware.</p>
        <div class="backend-choices">
          <button type="button" class="backend-choice" data-backend-choice="demo">
            <svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-play"/></svg>
            <span><strong>Demo</strong><span>Sample video and printer data. No setup.</span></span>
            <svg class="backend-chevron" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-chevron"/></svg>
          </button>
          <button type="button" class="backend-choice" data-backend-choice="docker">
            <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01M12 6.5h5M12 17.5h5"/></svg>
            <span><strong>Docker backend</strong><span>Connect to LayerGlass on your hardware.</span></span>
            <svg class="backend-chevron" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-chevron"/></svg>
          </button>
          <button type="button" class="backend-choice" data-backend-choice="direct">
            <svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-printer"/></svg>
            <span><strong>Direct printer</strong><span>Klipper / Moonraker live camera. No rewind. Bambu printers need Docker.</span></span>
            <svg class="backend-chevron" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-chevron"/></svg>
          </button>
        </div>
      </section>
      <section data-backend-page="docker" aria-labelledby="backend-docker-title" hidden>
        <div class="backend-heading"><button type="button" class="icon-button" data-backend-back aria-label="Back to backend choices"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-back"/></svg></button><h1 id="backend-docker-title">Docker backend</h1></div>
        <p class="backend-intro" data-connection-intro>Enter the address of your LayerGlass container.</p>
        <form class="backend-connect-form">
          <label for="backend-connect-url">Backend address</label>
          <input id="backend-connect-url" name="url" type="text" inputmode="url" autocomplete="url" autocapitalize="none" spellcheck="false" placeholder="printer.example.com" required>
          <p class="backend-address-hint"></p>
          <p class="backend-connect-error" role="alert" hidden></p>
          <button type="submit" class="button primary"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-connection"/></svg><span>Connect</span><span class="loader" aria-hidden="true" hidden></span></button>
        </form>
      </section>
      <p class="backend-footnote">Your choice stays in this browser. Change it anytime in Settings → Backend.</p>
    </div>`;
