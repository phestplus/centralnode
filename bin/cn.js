#!/usr/bin/env node
process.removeAllListeners('warning');
const { main } = await import('../dist/cli.js');
process.exitCode = await main(process.argv.slice(2));
