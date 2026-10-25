---
title: Video color diffusion
tags: [technical]
---

# Video color diffusion

[Vault home](index.md)

The unused space around a contained video uses a CSS gradient derived from the
displayed frame. The native video stays sharp and uses the same decoder. There
are no additional streams or image requests.

## Spatial color sampling

Every 2.2 seconds during playback, copy the current frame into a detached canvas
with a longest side of 32 pixels. Four sample regions use normalized centers
`(0.1, 0.1)`, `(0.9, 0.1)`, `(0.1, 0.9)`, and `(0.9, 0.9)`. For thumbnail pixel
`i` at normalized coordinates `(x_i, y_i)`, the weight for region `p` is:

```text
w_p(i) = alpha_i × exp(-((x_i - x_p)² + (y_i - y_p)²) / (2σ²))
σ = 0.28
C_p = encode_sRGB(Σ_i w_p(i) × decode_sRGB(pixel_i) / Σ_i w_p(i))
```

This adapts the normalized Gaussian weighting described by
[OpenCV's Gaussian kernel documentation](https://docs.opencv.org/4.13.0/d4/d86/group__imgproc__filter.html).
It averages the thumbnail's RGB channels in linear light using the
[sRGB transfer functions in CSS Color 4](https://www.w3.org/TR/css-color-4/#color-conversion-code),
then converts back to sRGB. This avoids making a mixture of light and dark
samples artificially dark. The thumbnail itself uses the browser's downsampling.
Gaussian weights are reused while sample dimensions remain the same.

Each regional color supplies one broad corner radial gradient, fading to
transparent over an alpha-weighted whole-thumbnail average. This approximates
the broad arrangement of colors; it does not extrapolate additional video detail.

## Slow transitions

Two CSS gradient layers crossfade over 1.8 seconds with `ease-in-out`. The base
stays opaque while the next layer transitions from zero to full opacity. At the
end, that gradient becomes the base and the next layer resets while invisible.
Identical palettes do not start a transition. A seek during a fade keeps only the
latest pending palette, so an in-progress transition is not abruptly replaced.

Only opacity animates. This follows
[web.dev's guidance on compositing animations](https://web.dev/articles/animations-guide#animate_at_the_composite_stage)
and avoids animating full-viewport blur or repainting gradient colors on every
animation frame. The browser decides how to composite the layers; the app does
not force permanent GPU layers or run an animation callback per video frame.

The first frame appears immediately. Seek, source and viewport changes can
refresh the colors sooner than the regular sampling interval. Sampling stops
when the document is hidden or the video fills the viewport. Paused video does
not run a background sampling timer. Reduced motion uses a still gradient and
updates it without a fade after a seek, resize or source change. Emptying the
video, showing a loading screen, or disconnecting the component clears pending
transitions. Native video PiP keeps this background on the main page.
