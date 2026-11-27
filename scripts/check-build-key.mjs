#!/usr/bin/env node
// Confirms that a built ReadSharp site carries exactly the expected Flagsmith client key before
// it is uploaded, so a Development build can never go to Production (or the other way round).
//
//   node scripts/check-build-key.mjs <built site dir> <ENV_VAR holding the expected key>
//
// Exit 0 only if every data-flagsmith-env attribute on the speed test page equals that variable's
// value. Keys are compared in memory and never printed.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Problems with the embedded keys (empty when the page carries exactly `expected`). Pure. */
export function keyProblems(html, expected) {
	if (!expected) return ['the expected key is empty'];
	const embedded = [...html.matchAll(/data-flagsmith-env="([^"]*)"/g)].map((m) => m[1]);
	if (!embedded.length) return ['the speed test page carries no Flagsmith key (the experiment would be off)'];
	if (embedded.some((value) => value !== expected)) return ['the speed test page carries a different Flagsmith key'];
	return [];
}

export function main([dir, variable] = process.argv.slice(2)) {
	if (!dir || !variable) {
		console.error('Usage: node scripts/check-build-key.mjs <built site dir> <ENV_VAR>');
		return 2;
	}
	let html;
	try {
		html = readFileSync(join(dir, 'reading-speed-test.html'), 'utf8');
	} catch {
		console.error(`No reading-speed-test.html in ${dir}`);
		return 1;
	}
	const problems = keyProblems(html, process.env[variable]);
	if (problems.length) {
		console.error(`NOT OK (${variable}): ${problems.join('; ')}. Do not upload this build.`);
		return 1;
	}
	console.log(`OK: the build carries the key in ${variable}.`);
	return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main();
