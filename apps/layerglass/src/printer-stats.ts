import type { CameraInfo, PrinterTelemetry } from '../../backend-contracts/src/index.js';
export type StatRow = [label: string, value: string | number | null | undefined, key?: string];
import { isFiniteNumber, isRecord } from '../../backend-contracts/src/index.js';
// The quick panel selects useful readings; labels still follow their keys.
const acronyms = new Map(
  Object.entries({
    id: 'ID',
    ip: 'IP',
    sn: 'SN',
    ams: 'AMS',
    hms: 'HMS',
    rfid: 'RFID',
    mqtt: 'MQTT',
    ota: 'OTA',
    mc: 'MC',
    hw: 'HW',
    sw: 'SW',
    cpu: 'CPU',
    nfc: 'NFC',
    wifi: 'Wi-Fi',
    gcode: 'G-code',
    ctc: 'CTC',
    rtsp: 'RTSP',
    usb: 'USB',
    sd: 'SD',
  }),
);

export function prettyStatKey(key: unknown) {
  return String(key)
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/[_\-\s]+/g, ' ')
    .trim()
    .split(' ')
    .map(
      (word) =>
        acronyms.get(word.toLowerCase()) || word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
    )
    .join(' ');
}

const number = (value: number) =>
  Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)));
const temperature = (value: number) => `${number(value)} °C (${number((value * 9) / 5 + 32)} °F)`;

function duration(seconds: number) {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  return `${hours ? `${hours}h ` : ''}${Math.floor(total / 60) % 60}m ${total % 60}s`;
}

export function printerStatValue(path: string[], value: unknown) {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  const key = path.at(-1) || '';
  const normalized = path.length === 1;
  const measuredTemperature = normalized
    ? /^(?:nozzle(?:_\d+)?|bed|chamber)(?:_target)?$/.test(key)
    : key !== 'temp' && /(?:^|_)(?:temper|temperature|temp)(?:_|$)/i.test(key);
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value.trim())
        ? Number(value)
        : NaN;
  if (measuredTemperature && isFiniteNumber(numeric) && numeric >= -100 && numeric <= 1000)
    return temperature(numeric);
  if (typeof value !== 'number') return String(value);
  if (!isFiniteNumber(value)) return '—';
  // Native packed `temp` bitfields remain literal numbers. Decoded temperatures
  // above retain their units; explicitly named native temperature fields do too.
  if (normalized && (key === 'elapsed_seconds' || key === 'remaining_minutes')) {
    return duration(key === 'remaining_minutes' ? value * 60 : value);
  }
  if (normalized && (key === 'progress' || key === 'speed_percent' || /_fan$/.test(key)))
    return `${number(value)}%`;
  if (normalized && key === 'updated_at') {
    const date = new Date(value * 1000);
    if (isFiniteNumber(date.getTime())) return date.toISOString();
  }
  return String(value);
}

export function printerStatRows(
  camera: CameraInfo | null | undefined,
  printer: PrinterTelemetry | null | undefined,
): StatRow[] {
  const rows: StatRow[] = [];
  const add = (key: string, value: unknown, formatted = false) => {
    if (value !== undefined)
      rows.push([prettyStatKey(key), formatted ? String(value) : printerStatValue([key], value), key]);
  };
  add('camera_ip', camera?.host);
  add('camera_port', camera?.port);
  if (!printer) return rows;
  for (const key of ['model', 'firmware', 'connection', 'print_state', 'job', 'progress'])
    add(key, printer[key]);
  if (isFiniteNumber(printer.layer))
    add(
      'layer',
      `${printer.layer}${isFiniteNumber(printer.total_layers) ? ` / ${printer.total_layers}` : ''}`,
      true,
    );
  for (const key of ['elapsed_seconds', 'remaining_minutes']) add(key, printer[key]);
  const pair = (current: unknown, target: unknown) => {
    if (!isFiniteNumber(current) && !isFiniteNumber(target)) return '—';
    const values = (convert: (value: number) => number) =>
      `${isFiniteNumber(current) ? number(convert(current)) : '—'}${
        target !== undefined && target !== null
          ? ` / ${isFiniteNumber(target) ? number(convert(target)) : '—'}`
          : ''
      }`;
    return `${values((value) => value)} °C (${values((value) => (value * 9) / 5 + 32)} °F)`;
  };
  const dual = isFiniteNumber(printer.nozzle_count) && printer.nozzle_count > 1;
  if (dual || 'nozzle_1' in printer || 'nozzle_1_target' in printer) {
    add('nozzle_1', pair(printer.nozzle_1, printer.nozzle_1_target), true);
  } else if ('nozzle' in printer || 'nozzle_target' in printer)
    add('nozzle', pair(printer.nozzle, printer.nozzle_target), true);
  if (dual || 'nozzle_2' in printer || 'nozzle_2_target' in printer) {
    add('nozzle_2', pair(printer.nozzle_2, printer.nozzle_2_target), true);
    add('active_nozzle', printer.active_nozzle);
  }
  for (const key of ['bed', 'chamber']) {
    if (key in printer || key + '_target' in printer)
      add(key, pair(printer[key], printer[key + '_target']), true);
  }
  const speed = [
    isFiniteNumber(printer.speed_percent) ? `${number(printer.speed_percent)}%` : null,
    printer.speed_mode,
  ].filter(Boolean);
  if (speed.length) add('speed', speed.join(' · '), true);
  const fans = ['part_fan', 'aux_fan', 'exhaust_fan', 'heatbreak_fan'].filter((key) =>
    isFiniteNumber(printer[key]),
  );
  if (fans.length)
    add(
      'fans',
      fans
        .map((key) => `${prettyStatKey(key.replace('_fan', ''))} ${number(printer[key] as number)}%`)
        .join(' · '),
      true,
    );
  for (const key of ['wifi', 'error']) add(key, printer[key]);
  const alerts = printer.alerts;
  if (Array.isArray(alerts) && alerts.length) {
    add(
      'alerts',
      alerts
        .slice(0, 3)
        .map((alert) =>
          isRecord(alert)
            ? [alert.code, alert.attr].filter((value) => value !== undefined).join(' / ') ||
              JSON.stringify(alert)
            : String(alert),
        )
        .join(' · ') + (alerts.length > 3 ? ` · +${alerts.length - 3}` : ''),
      true,
    );
  }
  return rows;
}
