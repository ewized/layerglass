import { backendPickerTemplate } from '../../../apps/layerglass/src/components/backend-template.ts';

/** Public, deterministic SSR only. No printer addresses, preferences or credentials. */
export function renderAppShell(html: string, renderer: 'static' | 'edge', demo = false): string {
  const mode = `<meta name="layerglass-renderer" content="${renderer}">`;
  let output = /<meta name="layerglass-renderer"/.test(html)
    ? html.replace(/<meta name="layerglass-renderer"[^>]*>/, mode)
    : html.replace('</head>', `  ${mode}\n</head>`);
  output = output.replace(
    /<printer-backend-picker\b([^>]*)>[\s\S]*?<\/printer-backend-picker>/,
    (_match: string, attributes: string) => {
      const clean = attributes.replace(/\s(?:hidden|data-ssr)(?:="[^"]*")?/g, '');
      return `<printer-backend-picker${clean} data-ssr${demo ? ' hidden' : ''}>${backendPickerTemplate}</printer-backend-picker>`;
    },
  );
  return output.replace(/<printer-player\b([^>]*)>/, (_match: string, attributes: string) => {
    const clean = attributes.replace(/\shidden(?:="[^"]*")?/g, '');
    return `<printer-player${clean}${demo ? '' : ' hidden'}>`;
  });
}
