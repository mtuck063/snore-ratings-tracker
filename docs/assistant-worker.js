// WebLLM worker — all GPU work (weight loading + inference) happens here so
// the dashboard never janks. One worker per engine; assistant.js spawns them.
import { WebWorkerMLCEngineHandler } from "https://esm.run/@mlc-ai/web-llm";

const handler = new WebWorkerMLCEngineHandler();
self.onmessage = (msg) => handler.onmessage(msg);
