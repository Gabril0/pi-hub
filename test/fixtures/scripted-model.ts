import { fauxAssistantMessage, fauxText, fauxToolCall, registerFauxProvider } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const faux = registerFauxProvider({ provider: "scripted", tokensPerSecond: 100000 });
	faux.setResponses(
		Array.from({ length: 10 }, () => (context: any) => {
			const last = context.messages.at(-1);
			if (last?.role === "toolResult") {
				const text = last.content.map((c: any) => c.text).join("\n");
				return fauxAssistantMessage(fauxText(`Tool result was: ${text}`));
			}
			return fauxAssistantMessage(fauxToolCall("edit", { path: "app.py", edits: [{ oldText: '"hi "', newText: '"hello "' }] }), { stopReason: "toolUse" });
		}),
	);
	pi.registerProvider("scripted", {
		baseUrl: "http://scripted.local",
		apiKey: "scripted",
		api: faux.api,
		models: [{ id: "scripted-1", name: "Scripted", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4000 }],
	});
}
