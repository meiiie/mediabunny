const variants = [];
const hash = async buffer => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer)), byte => byte.toString(16).padStart(2, '0')).join('');
const backing = target => [...new Set([target.buffer, target._buffer, target._bytes.buffer])].map(buffer => buffer.byteLength);
const draw = variant => {
	const card = document.getElementById(variant.name);
	const lengths = backing(variant.target);
	card.querySelector('.state').textContent = variant.output.state === 'finalizing' ? 'onFinalize is waiting' : 'Finalized';
	card.querySelector('.metric').textContent = lengths.reduce((sum, length) => sum + length, 0).toLocaleString('en-US');
	card.querySelector('.detail').textContent = `Output: ${variant.target.buffer.byteLength.toLocaleString('en-US')} bytes\nDistinct buffers: ${lengths.length}\nBacking lengths: ${lengths.join(' + ')}\nSHA-256: ${variant.sha256}`;
};
const start = async () => {
	document.getElementById('run').disabled = true;
	document.getElementById('result').textContent = 'Reading the fixture and converting...';
	const fixture = await (await fetch('/fixture.ts')).arrayBuffer();
	for (const [name, api] of [['baseline', Baseline], ['candidate', Candidate]]) {
		let enter;
		let release;
		const entered = new Promise(resolve => { enter = resolve; });
		const wait = new Promise(resolve => { release = resolve; });
		const target = new api.BufferTarget({ onFinalize: async () => { enter(); await wait; } });
		const input = new api.Input({ source: new api.BufferSource(fixture), formats: api.ALL_FORMATS });
		const previousNow = Date.now;
		let output;
		try {
			Date.now = () => 1700000000000;
			output = new api.Output({ target, format: new api.Mp4OutputFormat() });
		} finally { Date.now = previousNow; }
		const conversion = await api.Conversion.init({ input, output, copy: { mode: 'forced' } });
		if (!conversion.isValid) { throw new Error(`${name}: invalid conversion`); }
		const execution = conversion.execute();
		await entered;
		const variant = { name, target, input, output, release, execution, sha256: await hash(target.buffer) };
		variants.push(variant);
		draw(variant);
	}
	const [before, after] = variants;
	const bytesEqual = before.target.buffer.byteLength === after.target.buffer.byteLength
		&& new Uint8Array(before.target.buffer).every((byte, index) => byte === new Uint8Array(after.target.buffer)[index]);
	if (!bytesEqual) { throw new Error('Output bytes differ'); }
	const saved = backing(before.target).reduce((a, b) => a + b, 0) - backing(after.target).reduce((a, b) => a + b, 0);
	document.getElementById('result').textContent = `${(saved / 1024 / 1024).toFixed(0)} MiB less retained backing storage. Output bytes match.`;
	document.getElementById('release').disabled = false;
	window.demoResult = { phase: 'callbacks-pending', fixtureBytes: fixture.byteLength, fixtureSha256: await hash(fixture), bytesEqual, savedBytes: saved, variants: variants.map(v => ({ name: v.name, state: v.output.state, outputBytes: v.target.buffer.byteLength, backingLengths: backing(v.target), outputSha256: v.sha256 })) };
};
const finish = async () => {
	document.getElementById('release').disabled = true;
	for (const variant of variants) { variant.release(); }
	await Promise.all(variants.map(v => v.execution));
	for (const variant of variants) { draw(variant); variant.input.dispose(); }
	window.demoResult.phase = 'finalized';
	window.demoResult.finalStates = variants.map(v => v.output.state);
};
const fail = error => { document.getElementById('result').textContent = `Failed: ${error.message}`; window.demoError = error.message; };
document.getElementById('run').onclick = () => { start().catch(fail); };
document.getElementById('release').onclick = () => { finish().catch(fail); };
