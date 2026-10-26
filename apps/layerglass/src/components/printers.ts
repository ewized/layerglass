import type { CameraInfo } from '../../../backend-contracts/src/index.js';
interface PrinterRowState {
  camera: CameraInfo;
  selected: boolean;
  busy: boolean;
  editing: boolean;
}
import { eventElement } from '../dom.js';
import { PlayerElement } from './base.js';
import { printerTemplate, accessCodeTemplate } from './templates.js';

let inputSequence = 0;

export class PrinterItem extends PlayerElement {
  declare form: HTMLFormElement;
  declare message: HTMLElement;
  declare input: HTMLInputElement;
  declare model: PrinterRowState | undefined;

  static override template = printerTemplate;
  inputId = `printer-code-${++inputSequence}`;

  override connectedCallback() {
    super.connectedCallback();
    this.classList.add('printer-row');
    this.form = this.required<HTMLFormElement>('form');
    this.message = this.required('.printer-error');
    this.message.id = `${this.inputId}-error`;
    this.listen(this, 'click', (event) => {
      const button = eventElement(event).closest<HTMLButtonElement>('[data-printer-action]');
      if (!button || button.disabled || this.state?.busy) return;
      const action = button.dataset.printerAction;
      this.emit(action === 'access' ? 'printer-edit' : `printer-${action}`, {
        cameraId: this.state!.camera.id,
      });
    });
    this.listen(this.form, 'submit', (event) => {
      event.preventDefault();
      if (this.form.hidden || this.state?.busy) return;
      this.emit('printer-save', { cameraId: this.state!.camera.id, code: this.input.value });
    });
    this.updatePresentation();
  }

  set state(value: PrinterRowState | undefined) {
    this.model = value;
    if (this.isConnected && this.rendered) this.updatePresentation();
  }
  get state(): PrinterRowState | undefined {
    return this.model;
  }

  updatePresentation() {
    if (!this.model) return;
    const { camera, selected, busy, editing } = this.model;
    const direct = camera.setup?.type === 'direct';
    this.hidden = !direct && camera.setup?.type !== 'access_code';
    if (this.hidden) return;
    const select = this.required<HTMLButtonElement>('.printer-select');
    const access = this.required<HTMLButtonElement>('.printer-access');
    const forget = this.required<HTMLButtonElement>('.printer-forget');
    this.dataset.cameraId = camera.id;
    select.setAttribute('aria-pressed', String(selected));
    select.setAttribute('aria-label', `View ${camera.name}`);
    select.title = camera.name;
    select.disabled = busy || !camera.configured;
    this.required('.printer-name').textContent = camera.name;
    this.required('.printer-address').textContent = camera.port
      ? `${camera.host}:${camera.port}`
      : camera.host || '';
    this.required('.printer-state').toggleAttribute('hidden', !selected || !camera.configured);
    if (direct) {
      // Direct camera admission belongs to the controller's webcam settings.
      // No access-code or forget action is sent to this printer/controller.
      access.hidden = true;
      forget.hidden = true;
      this.form.hidden = true;
      return;
    }
    forget.hidden = false;
    if (!this.input) {
      this.form.innerHTML = accessCodeTemplate;
      this.input = this.form.querySelector('input')!;
      for (const input of this.form.querySelectorAll('input')) {
        input.id = `${this.inputId}-${input.name}`;
        input.setAttribute('aria-describedby', this.message.id);
        const label = input.closest('label') || this.form.querySelector('label');
        label!.htmlFor = input.id;
      }
    }
    const save = this.required<HTMLButtonElement>('.printer-code-save');
    const open = editing && !camera.configured;
    const wasEditing = !this.form.hidden;
    access.hidden = camera.configured || open;
    const action = 'Access code';
    access.setAttribute('aria-label', `${action} for ${camera.name}`);
    access.title = action;
    access.querySelector('use')!.setAttribute('href', '#i-key');
    this.form.hidden = !open;
    this.form.setAttribute('aria-label', `Access code for ${camera.name}`);
    this.form.querySelector('label')!.textContent = `LAN access code for ${camera.name}`;
    save.setAttribute('aria-label', `Save and connect to ${camera.name}`);
    forget.setAttribute('aria-label', `Forget ${camera.name}`);
    forget.title = 'Forget printer';
    for (const control of [access, ...this.form.querySelectorAll('input'), save, forget])
      control.disabled = busy;
    if (!open) {
      for (const input of this.form.querySelectorAll('input')) input.value = '';
      if (wasEditing) this.error = '';
    }
  }

  set error(value: string) {
    this.message.textContent = value;
    this.message.hidden = !value;
  }
  set saving(value: boolean) {
    this.form.setAttribute('aria-busy', String(value));
  }
}

export class PrinterList extends PlayerElement {
  declare model: { cameras: CameraInfo[]; selectedCamera: string | null; busy: boolean } | undefined;

  rows = new Map<string, PrinterItem>();
  editingCamera: string | null = null;
  editorRevision = 0;

  override connectedCallback() {
    super.connectedCallback();
    this.listen(this, 'printer-edit', (event) => {
      this.editorRevision++;
      this.editingCamera = event.detail.cameraId;
      this.renderRows();
      this.rows.get(this.editingCamera!)?.input.focus();
    });
    this.listen(this, 'keydown', (event) => {
      if (event.key !== 'Escape' || !this.editingCamera || this.model?.busy) return;
      const key = this.editingCamera;
      this.closeEditor();
      this.rows.get(key)?.querySelector<HTMLButtonElement>('.printer-access')?.focus({ preventScroll: true });
      event.preventDefault();
      event.stopPropagation();
    });
    this.renderRows();
  }

  setPrinters(cameras: CameraInfo[], selectedCamera: string | null, busy = false) {
    this.model = {
      cameras: cameras.filter((camera) => ['access_code', 'direct'].includes(camera.setup?.type)),
      selectedCamera,
      busy,
    };
    if (this.isConnected && this.rendered) this.renderRows();
  }

  renderRows() {
    if (!this.model) return;
    const { cameras, selectedCamera, busy } = this.model;
    const ids = new Set(cameras.map((camera) => camera.id));
    if (!ids.has(this.editingCamera || '')) this.editingCamera = null;
    for (const [id, row] of this.rows) {
      if (!ids.has(id)) {
        row.remove();
        this.rows.delete(id);
      }
    }
    cameras.forEach((camera, index) => {
      let row = this.rows.get(camera.id);
      if (!row) {
        // Create upgraded rows in the application's component registry.
        row = document.createElement('printer-item');
        this.rows.set(camera.id, row);
      }
      row.state = {
        camera,
        selected: camera.id === selectedCamera,
        busy,
        editing: this.editingCamera === camera.id,
      };
      if (this.children[index] !== row) {
        const next = this.children[index] || null;
        if (row.parentElement === this && this.moveBefore) this.moveBefore(row, next);
        else this.insertBefore(row, next);
      }
    });
  }

  closeEditor() {
    this.editorRevision++;
    this.editingCamera = null;
    for (const row of this.rows.values()) row.error = '';
    this.renderRows();
  }

  row(key: string) {
    return this.rows.get(key);
  }

  focusNearest(index: number) {
    const next = this.children[Math.min(index, this.children.length - 1)];
    const target =
      next &&
      [...next.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')].find(
        (button) => button.getClientRects().length,
      );
    target?.focus({ preventScroll: true });
    return Boolean(target);
  }
}
