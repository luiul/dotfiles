#!/usr/bin/env node
/** A deadline before readiness must leave no private server or fixture root. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { RexTestDriver } from './rex-test-driver.mjs';
let failure;
try { await RexTestDriver.start({ deadlineMs: 1000 }); }
catch (error) { failure = error; }
assert(failure, 'Short startup deadline unexpectedly completed');
assert(failure.fixtureRoot, 'Failed startup must identify its owned root');
assert(!fs.existsSync(failure.fixtureRoot), 'Failed startup retained its unresolved root');
console.log('PASS deadline during startup requests verified cleanup before returning');
