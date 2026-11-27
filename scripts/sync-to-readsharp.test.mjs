import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_WORKTREE, WEB_DIR, moduleFiles, sha256, syncTo } from './sync-to-readsharp.mjs';

test('only the shipped modules are synced (no tests)', () => {
	assert.deepEqual(moduleFiles(), ['eligibility.js', 'experiment.js', 'feel-reader.js']);
});

test('synced files are byte-identical to web/ and the manifest hashes match', (t) => {
	const dir = mkdtempSync(join(tmpdir(), 'sync-'));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const manifest = syncTo(dir);
	for (const name of moduleFiles()) {
		const source = readFileSync(join(WEB_DIR, name));
		assert.ok(source.equals(readFileSync(join(dir, name))), `${name} differs`);
		assert.equal(manifest.files[name], sha256(source));
	}
	assert.deepEqual(JSON.parse(readFileSync(join(dir, 'SYNCED.json'), 'utf8')), manifest);
});

test('the ReadSharp worktree copies, when that private worktree is present, are byte-identical', () => {
	const dir = join(DEFAULT_WORKTREE, 'site', 'experiment');
	// Public clones have no private ReadSharp worktree; there is nothing to compare there.
	if (!existsSync(dir)) return;
	for (const name of moduleFiles()) {
		assert.ok(readFileSync(join(WEB_DIR, name)).equals(readFileSync(join(dir, name))), `${name} is out of sync: run node scripts/sync-to-readsharp.mjs`);
	}
});
