// Pinned SWE-bench Multilingual regression; see ../README.md for provenance.
import { spawn } from 'node:child_process';
const child = spawn(process.execPath, ["node_modules/mocha/bin/_mocha","-R","tap","test/unit/regression/bugs.js"], { cwd: process.argv[2], stdio: 'inherit', windowsHide: true });
child.once('error', (error) => { console.error(error); process.exitCode = 2; });
child.once('exit', (code, signal) => { process.exitCode = code ?? 2; if(signal) console.error('terminated: ' + signal); });
