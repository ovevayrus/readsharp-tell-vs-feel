#!/usr/bin/env node
// A small static server for a built ReadSharp site (dist-site/), for local end-to-end tests.
// It applies the site's Cloudflare Pages `_headers` file (so the real CSP is enforced, as on
// Pages), serves /name as name.html like Pages does, and can put a Flagsmith client-side key
// into the page in memory, from an environment variable, so the key never lands on disk.
//
//   node scripts/serve-dist.mjs --dir <dist-site> [--port 4173] [--inject-key-from FS_DEV_CLIENT_KEY]
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const TYPES = {
	'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
	'.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
	'.webp': 'image/webp', '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.vtt': 'text/vtt', '.txt': 'text/plain; charset=utf-8',
	'.xml': 'application/xml', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2',
};

/** Parses a Cloudflare Pages _headers file into [{ pattern, headers: [[name, value]] }]. */
export function parseHeaders(text) {
	const rules = [];
	for (const raw of text.split(/\r?\n/)) {
		if (!raw.trim() || raw.trim().startsWith('#')) continue;
		if (!/^\s/.test(raw)) {
			rules.push({ pattern: raw.trim(), headers: [] });
		} else if (rules.length) {
			const at = raw.indexOf(':');
			if (at > 0) rules.at(-1).headers.push([raw.slice(0, at).trim(), raw.slice(at + 1).trim()]);
		}
	}
	return rules;
}

/** Cloudflare-style path match: "*" matches any run of characters (splat). */
export function matches(pattern, path) {
	const re = new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
	return re.test(path);
}

export function headersFor(rules, path) {
	const out = new Map();
	for (const rule of rules) if (matches(rule.pattern, path)) for (const [k, v] of rule.headers) out.set(k, v);
	return out;
}

/** Candidate files for a URL path, Pages-style: /a → a.html, /a/ → a/index.html. */
export function candidates(urlPath) {
	const clean = decodeURIComponent(urlPath.split('?')[0]);
	if (clean.endsWith('/')) return [`${clean}index.html`];
	return extname(clean) ? [clean] : [`${clean}.html`, `${clean}/index.html`, clean];
}

/** Puts the key into data-flagsmith-env="" attributes, in memory only. */
export function injectKey(html, key) {
	return key ? html.replaceAll('data-flagsmith-env=""', `data-flagsmith-env="${key.replace(/[^A-Za-z0-9_.-]/g, '')}"`) : html;
}

export async function startServer({ dir, port = 4173, key = '' }) {
	const root = resolve(dir);
	let rules = [];
	try { rules = parseHeaders(await readFile(join(root, '_headers'), 'utf8')); } catch { rules = []; }
	const server = createServer(async (req, res) => {
		const urlPath = new URL(req.url, 'http://local').pathname;
		for (const candidate of candidates(urlPath)) {
			const file = normalize(join(root, candidate));
			if (!file.startsWith(root + sep) && file !== root) break;
			try {
				if (!(await stat(file)).isFile()) continue;
			} catch { continue; }
			let body = await readFile(file);
			const type = TYPES[extname(file)] ?? 'application/octet-stream';
			if (type.startsWith('text/html')) body = Buffer.from(injectKey(body.toString('utf8'), key));
			const headers = headersFor(rules, urlPath);
			res.writeHead(200, { ...Object.fromEntries(headers), 'Content-Type': type, 'Cache-Control': 'no-store' });
			res.end(body);
			return;
		}
		res.writeHead(404, { 'Content-Type': 'text/plain' });
		res.end('Not found');
	});
	await new Promise((ok) => server.listen(port, '127.0.0.1', ok));
	return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	const arg = (name, fallback) => {
		const at = process.argv.indexOf(name);
		return at > -1 ? process.argv[at + 1] : fallback;
	};
	const keyVar = arg('--inject-key-from', '');
	const key = keyVar ? process.env[keyVar] ?? '' : '';
	if (keyVar && !key) console.error(`${keyVar} is not set; serving without a Flagsmith key`);
	const port = Number(arg('--port', '4173'));
	await startServer({ dir: arg('--dir', 'dist-site'), port, key });
	console.log(`serving on http://127.0.0.1:${port}${key ? ' (Flagsmith key injected in memory)' : ''}`);
}
