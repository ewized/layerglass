import manifest from '../package.json' with { type: 'json' };

console.info(manifest.devDependencies.playwright);
