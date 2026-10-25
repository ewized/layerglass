// Gaussian spatial averages preserve the frame's broad color arrangement.
// Average in linear-light sRGB so bright areas do not become artificially dark.
// Formula and references: docs/video-diffusion.md.
export const DIFFUSION_SAMPLE_INTERVAL = 2200;
const anchors = [[0.1, 0.1], [0.9, 0.1], [0.1, 0.9], [0.9, 0.9]];
const linear = Float64Array.from({ length: 256 }, (_, byte) => {
  const value = byte / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
});
const srgb = value => Math.round(255 * (value <= 0.0031308 ?
  12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055));
let kernel;

export function diffusionSampleSize(width, height) {
  return {
    width: Math.max(1, Math.round(32 * Math.min(1, width / height))),
    height: Math.max(1, Math.round(32 * Math.min(1, height / width))),
  };
}

function weightsFor(width, height) {
  if (kernel?.width === width && kernel.height === height) return kernel.weights;
  const weights = anchors.map(([cx, cy]) => Float64Array.from({ length: width * height }, (_, i) => {
    const x = (i % width + 0.5) / width - cx;
    const y = (Math.floor(i / width) + 0.5) / height - cy;
    return Math.exp(-(x * x + y * y) / (2 * 0.28 ** 2));
  }));
  kernel = { width, height, weights };
  return weights;
}

export function diffusionPalette({ data, width, height }) {
  const weights = weightsFor(width, height);
  const sums = Array.from({ length: 5 }, () => [0, 0, 0, 0]);
  for (let i = 0; i < width * height; i++) {
    const alpha = data[i * 4 + 3] / 255;
    for (let region = 0; region < sums.length; region++) {
      const weight = alpha * (region === 4 ? 1 : weights[region][i]);
      for (let channel = 0; channel < 3; channel++) sums[region][channel] += linear[data[i * 4 + channel]] * weight;
      sums[region][3] += weight;
    }
  }
  return sums.map(([red, green, blue, total]) => total ?
    [red, green, blue].map(value => srgb(value / total)) : [0, 0, 0]);
}

export function diffusionGradient(palette) {
  const positions = ['0% 0%', '100% 0%', '0% 100%', '100% 100%'];
  const gradients = positions.map((position, index) => {
    const color = palette[index].join(' ');
    return `radial-gradient(ellipse at ${position}, rgb(${color}) 0%, rgb(${color} / 0) 70%)`;
  });
  return `${gradients.join(', ')}, rgb(${palette[4].join(' ')})`;
}
