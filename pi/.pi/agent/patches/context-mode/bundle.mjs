// Run only through the patch CLI with the pinned Bun version.
const result = await Bun.build({
  entrypoints: ['./build/server.js'],
  target: 'node',
  format: 'esm',
  packages: 'external',
  minify: false,
  sourcemap: 'none',
});
if (!result.success || result.outputs.length !== 1) throw new Error('Bundle build failed');
await Bun.write(process.argv[2], result.outputs[0]);
console.log('Bundle built');
