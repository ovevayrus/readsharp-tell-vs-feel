#!/usr/bin/env node
// Copies the public browser modules (web/*.js, tests excluded) byte-for-byte into the ReadSharp
// site, at <worktree>/site/experiment/, and writes SYNCED.json there with each file's SHA-256 so
// the ReadSharp side can check that nobody edited its copies.
//
//   node scripts/sync-to-readsharp.mjs [--to <readsharp worktree>]
//
// The default worktree is $READSHARP_WORKTREE, else C:/Users/oveva/readfast-worktrees/flagsmith-tell-vs-feel.
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'web');
export const DEFAULT_WORKTREE = process.env.READSHARP_WORKTREE || 'C:/Users/oveva/readfast-worktrees/flagsmith-tell-vs-feel';

/** The modules that ship: web/*.js without tests. */
export function moduleFiles(webDir = WEB_DIR) {
	return readdirSync(webDir).filter((name) => name.endsWith('.js') && !name.endsWith('.test.js')).sort();
}

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Copies the modules into <targetDir> and writes SYNCED.json. Returns the manifest. */
export function syncTo(targetDir, webDir = WEB_DIR) {
	mkdirSync(targetDir, { recursive: true });
	const files = {};
	for (const name of moduleFiles(webDir)) {
		copyFileSync(join(webDir, name), join(targetDir, name));
		files[name] = sha256(readFileSync(join(webDir, name)));
	}
	const manifest = { source: 'https://github.com/ovevayrus/readsharp-tell-vs-feel/tree/main/web', files };
	writeFileSync(join(targetDir, 'SYNCED.json'), `${JSON.stringify(manifest, null, 2)}\n`);
	return manifest;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	const at = process.argv.indexOf('--to');
	const worktree = at > -1 ? process.argv[at + 1] : DEFAULT_WORKTREE;
	const target = join(worktree, 'site', 'experiment');
	const manifest = syncTo(target);
	console.log(`synced ${Object.keys(manifest.files).join(', ')} -> ${target}`);
}
