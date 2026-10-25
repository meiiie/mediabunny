const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');

const [baselineArg, candidateArg, side, temporaryArg] = process.argv.slice(2);
assert(baselineArg && candidateArg, 'Usage: node reproduce.cjs <baseline-checkout> <candidate-checkout>');
const baseline = path.resolve(baselineArg);
const candidate = path.resolve(candidateArg);
const esbuild = createRequire(path.join(baseline, 'package.json'))('esbuild');
const sha256 = data => createHash('sha256').update(data).digest('hex');
const fixture = fs.readFileSync(path.join(baseline, 'test/public/trim-buck-bunny-ffmpeg.ts'));
const temporary = temporaryArg || fs.mkdtempSync(path.join(os.tmpdir(), 'mediabunny-buffer-repro-'));
const backingBytes = target => [...new Set([target.buffer, target._buffer, target._bytes.buffer])]
	.reduce((sum, buffer) => sum + buffer.byteLength, 0);

const run = async (name, root) => {
	const bundle = path.join(temporary, `${name}.cjs`);
	await esbuild.build({
		entryPoints: [path.join(root, 'src/index.ts')], outfile: bundle,
		bundle: true, platform: 'node', target: 'es2021', format: 'iife', globalName: 'Mediabunny',
		legalComments: 'none', footer: { js: 'Object.assign(module.exports, Mediabunny);' },
	});
	const api = require(bundle);
	let callbackBytes;
	const target = new api.BufferTarget({ onFinalize: async () => {
		callbackBytes = backingBytes(target);
		await Promise.resolve();
	} });
	const input = new api.Input({ source: new api.BufferSource(fixture), formats: api.ALL_FORMATS });
	let output;
	const now = Date.now;
	try {
		Date.now = () => 1_700_000_000_000;
		output = new api.Output({ target, format: new api.Mp4OutputFormat() });
	} finally { Date.now = now; }
	try {
		const conversion = await api.Conversion.init({ input, output, showWarnings: false, copy: { mode: 'forced' } });
		assert(conversion.isValid);
		assert.equal(conversion.discardedTracks.length, 0);
		await conversion.execute();
	} finally { input.dispose(); }
	assert.equal(output.state, 'finalized');
	const bytes = Buffer.from(target.buffer);
	return { name, commit: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
		targetSourceSha256: sha256(fs.readFileSync(path.join(root, 'src/target.ts'), 'utf8').replace(/\r\n/g, '\n')),
		outputBytes: bytes.length, outputSha256: sha256(bytes),
		retainedInCallbackBytes: callbackBytes, retainedAfterFinalizeBytes: backingBytes(target), bytes };
};

(async () => {
	if (side) {
		assert(['baseline', 'candidate'].includes(side));
		const { bytes, ...result } = await run(side, side === 'baseline' ? baseline : candidate);
		fs.writeFileSync(path.join(temporary, `${side}.mp4`), bytes);
		console.log(JSON.stringify(result));
		return;
	}
	const [before, after] = ['baseline', 'candidate'].map(name => JSON.parse(execFileSync(process.execPath,
		[__filename, baseline, candidate, name, temporary], { encoding: 'utf8' })));
	assert(fs.readFileSync(path.join(temporary, 'baseline.mp4'))
		.equals(fs.readFileSync(path.join(temporary, 'candidate.mp4'))), 'Output bytes must match exactly');
	assert.equal(after.retainedInCallbackBytes, after.outputBytes);
	assert.equal(after.retainedAfterFinalizeBytes, after.outputBytes);
	assert(before.retainedInCallbackBytes > after.retainedInCallbackBytes);
	console.log(JSON.stringify({ node: process.version, fixture: 'test/public/trim-buck-bunny-ffmpeg.ts',
		fixtureSha256: sha256(fixture), byteIdentical: true,
		retainedReductionBytes: before.retainedInCallbackBytes - after.retainedInCallbackBytes,
		results: [before, after] }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
	if (side) { return; }
	for (const name of ['baseline.cjs', 'candidate.cjs', 'baseline.mp4', 'candidate.mp4']) {
		fs.rmSync(path.join(temporary, name), { force: true });
	}
	fs.rmdirSync(temporary);
});
