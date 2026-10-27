// Verify native video PiP even when Document PiP is available on the origin.
process.env.VIEWER_URL ??= 'http://127.0.0.1:8080';
process.env.EXPECT_SECURE = '1';
await import('./browser-video-pip.ts');

export {};
