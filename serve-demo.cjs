const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const [baselineArg, candidateArg, flag] = process.argv.slice(2);
if (!baselineArg || !candidateArg) {
	console.error('Usage: node serve-demo.cjs <baseline-checkout> <patched-checkout> [--check]');
	process.exit(2);
}
const baseline = path.resolve(baselineArg);
const candidate = path.resolve(candidateArg);
const assets = path.join(__dirname, '.demo-assets');
const start = async () => {
	const baselineTarget = fs.readFileSync(path.join(baseline, 'src/target.ts'), 'utf8').replace(/\r\n/g, '\n');
	const candidateTarget = fs.readFileSync(path.join(candidate, 'src/target.ts'), 'utf8').replace(/\r\n/g, '\n');
	assert.equal(sha(baselineTarget), '5c85d8a8c587aef208775302183e8865e51d46a3b540542e98a49d9494ab64db', 'Baseline target differs from the recorded source');
	assert.equal(sha(candidateTarget), 'c8bcdcc76048640a8e915dbce237898af3d8b7472a7fb9d7d6c0780df5a428d6', 'Candidate target differs from the recorded source');
	const esbuild = createRequire(path.join(candidate, 'package.json'))('esbuild');
	fs.mkdirSync(assets, { recursive: true });
	const inputs = {};
	for (const [name, repo, globalName] of [['baseline', baseline, 'Baseline'], ['candidate', candidate, 'Candidate']]) {
		const build = await esbuild.build({ absWorkingDir: repo, entryPoints: ['src/index.ts'], outfile: path.join(assets, `${name}.js`), bundle: true, platform: 'browser', format: 'iife', globalName, target: 'es2021', minify: true, legalComments: 'none', metafile: true, logLevel: 'silent', logOverride: { 'import-is-undefined': 'silent' } });
		assert(Object.keys(build.metafile.inputs).includes('(disabled):src/node'));
		inputs[name] = Object.fromEntries(Object.keys(build.metafile.inputs).filter(file => !file.startsWith('(disabled):')).map(file => [file, sha(fs.readFileSync(path.join(repo, file), 'utf8').replace(/\r\n/g, '\n'))]));
	}
	assert.deepEqual(Object.keys(inputs.baseline).sort(), Object.keys(inputs.candidate).sort());
	for (const file of Object.keys(inputs.baseline)) {
		if (file !== 'src/target.ts') { assert.equal(inputs.baseline[file], inputs.candidate[file], `Another bundled input differs: ${file}`); }
	}
	const fixture = path.join(baseline, 'test/public/trim-buck-bunny-ffmpeg.ts');
	assert.equal(sha(fs.readFileSync(fixture)), '6b7574cf5dee534b3c4e9940576286d716f2f05504dd34e3e4b62560770ecb18');
	if (flag === '--check') { console.log('PASS: sources, browser builds and fixture match the recorded comparison.'); return; }
	const routes = new Map([
		['/', path.join(__dirname, 'index.html')],
		['/demo.js', path.join(__dirname, 'demo.js')],
		['/baseline.js', path.join(assets, 'baseline.js')],
		['/candidate.js', path.join(assets, 'candidate.js')],
		['/fixture.ts', fixture],
	]);
	const server = http.createServer((request, response) => {
		const file = routes.get(request.url);
		if (!file) { response.writeHead(404).end(); return; }
		response.setHeader('Content-Type', file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
		fs.createReadStream(file).pipe(response);
	});
	server.listen(0, '127.0.0.1', () => { console.log(`Open http://127.0.0.1:${server.address().port}/ and click Run both conversions, then Release callbacks.`); });
	process.once('SIGINT', () => { server.close(); });
};
start().catch(error => { console.error(error.message); process.exitCode = 1; });
