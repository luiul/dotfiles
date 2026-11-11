/** Deterministic terminal protocol fixture. No network or user state. */
import fs from 'node:fs';
const log = process.argv[2];
const record = event => fs.appendFileSync(log, JSON.stringify(event) + '\n');
const paint = () => {
  process.stdout.write('\x1b[2J\x1b[H\x1b[1;31mRED_BOLD\x1b[0m\nUNICODE: café 界 🙂\n');
  process.stdout.write(`GRID:${process.stdout.columns}x${process.stdout.rows}\nREADY\n`);
};
record({ type: 'ready', pid: process.pid, columns: process.stdout.columns, rows: process.stdout.rows,
  secretsPresent: Boolean(process.env.AWS_SECRET_ACCESS_KEY || process.env.SSH_AUTH_SOCK || process.env.API_KEY) });
process.stdout.write('PRIMARY_BEFORE_ALT\n\x1b[?1049h\x1b[?1002h\x1b[?1006h');
process.stdin.setRawMode(true);
process.stdin.resume();
paint();
process.on('SIGWINCH', () => { record({ type: 'resize', columns: process.stdout.columns, rows: process.stdout.rows }); paint(); });
process.stdin.on('data', data => {
  record({ type: 'input', hex: data.toString('hex') });
  if (data.includes(0x71)) {
    process.stdout.write('\x1b[?1002l\x1b[?1006l\x1b[?1049lAFTER_ALT\n');
    process.stdin.setRawMode(false);
    process.exit(7);
  }
});
setTimeout(() => { record({ type: 'deadline' }); process.exit(99); }, 45_000);
