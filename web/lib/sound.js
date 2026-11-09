let context;

const TONES = {
	review: [660, 880],
	question: [740, 990],
	conflict: [520, 440],
	error: [440, 330],
	test_fail: [494, 370],
	done: [784, 1046],
	message: [698, 932],
	pr: [587, 784],
};

export function chime(kind = "message") {
	try {
		context ??= new AudioContext();
		const [a, b] = TONES[kind] ?? TONES.message;
		const now = context.currentTime;
		[a, b].forEach((freq, i) => {
			const osc = context.createOscillator();
			const gain = context.createGain();
			osc.type = "sine";
			osc.frequency.value = freq;
			const start = now + i * 0.12;
			gain.gain.setValueAtTime(0.0001, start);
			gain.gain.exponentialRampToValueAtTime(0.12, start + 0.02);
			gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.35);
			osc.connect(gain).connect(context.destination);
			osc.start(start);
			osc.stop(start + 0.4);
		});
	} catch {}
}
