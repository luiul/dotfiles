#!/usr/bin/env node
/** JSONL bridge for Python/shell tests. EOF and signals dispose the owned server. */
import readline from 'node:readline';
import { RexTestDriver } from './rex-test-driver.mjs';
const driver = await RexTestDriver.start({ deadlineMs: Number(process.argv[2] ?? 480000) });
const input = readline.createInterface({ input: process.stdin });
process.once('SIGTERM', () => input.close());
process.once('SIGINT', () => input.close());
try {
  for await (const line of input) {
    let request;
    try {
      request = JSON.parse(line);
      const a = request.args ?? {};
      let result;
      switch (request.operation) {
        case 'create': result = driver.create(a); break;
        case 'capture': result = driver.capture(a.host, a.options); break;
        case 'text': result = driver.text(a.host, a.data); break;
        case 'key': result = driver.key(a.host, a.key); break;
        case 'resize': result = driver.resize(a.host, a.columns, a.rows); break;
        case 'process': result = driver.process(a.host); break;
        case 'pid': result = driver.pid(a.host); break;
        case 'close': result = driver.close(a.host); break;
        case 'stop': result = await driver.stop(); break;
        default: throw new Error('Unknown fixture operation');
      }
      process.stdout.write(JSON.stringify({ id: request.id, result: result ?? null }) + '\n');
      if (request.operation === 'stop') break;
    } catch (error) {
      process.stdout.write(JSON.stringify({ id: request?.id, error: String(error) }) + '\n');
    }
  }
} finally { await driver.stop(); }
