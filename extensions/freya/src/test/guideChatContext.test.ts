import 'mocha';
import * as assert from 'assert';
import { GUIDE_STOP, formatUserPromptWithContext } from '../guidePrompt.js';

suite('Guide-chatt: kontext och loopskydd', () => {
	test('formatUserPromptWithContext returnerar prompten som den ar utan kontext', () => {
		const result = formatUserPromptWithContext("Vad ar klockan?");
		assert.strictEqual(result, "Vad ar klockan?");
	});

	test('formatUserPromptWithContext bygger aktiv filkontext nar snippet finns', () => {
		const result = formatUserPromptWithContext("Vad gor denna kod?", {
			fileName: "index.js",
			languageId: "javascript",
			snippet: "console.log('hello');",
		});
		assert.ok(result.includes('[Active File: index.js (javascript)]'));
		assert.ok(result.includes("console.log('hello');"));
		assert.ok(result.includes("Question: Vad gor denna kod?"));
	});

	test('GUIDE_STOP innehaller stoppsekvenser for alla vanliga modellmallar', () => {
		assert.ok(GUIDE_STOP.includes('<|im_end|>'));
		assert.ok(GUIDE_STOP.includes('</s>'));
		assert.ok(GUIDE_STOP.includes('<|endoftext|>'));
		assert.ok(GUIDE_STOP.includes('\nQuestion:'));
		assert.ok(GUIDE_STOP.includes('\nSystem:'));
	});
});
