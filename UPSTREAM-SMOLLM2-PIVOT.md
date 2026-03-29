# Pivot: SmolLM2 1.7B as Default Model

## Context

The upstream `thinkhere` repo currently runs **Gemma 3n E2B** as its single model via **MediaPipe LLM / LiteRT**. This document describes the changes needed to pivot to **SmolLM2 1.7B** via **WebLLM** as the default (and only) model for anonymous/free users. Gemma becomes available only when the user is logged in.

---

## What Changes

| Area | Current (Gemma) | Target (SmolLM2) |
|------|-----------------|-------------------|
| Runtime | MediaPipe GenAI | WebLLM (MLC) |
| Import | `@mediapipe/tasks-genai` | `@mlc-ai/web-llm` |
| Model ID | `gemma-3n-E2B` | `SmolLM2-1.7B-Instruct-q4f16_1-MLC` |
| Download | Manual fetch → Cache API → blob | WebLLM handles download + caching |
| Inference | `mpInference.generateResponse()` | `engine.chat.completions.create()` (OpenAI-compatible) |
| Prompt format | Custom Gemma `<start_of_turn>` | Handled by WebLLM tokenizer |
| Multimodal | Yes (images) | No (text only) |
| Model size | ~3 GB | ~1 GB |
| Min RAM | 6 GB | 4 GB |

---

## File-by-file Changes

### `js/app.js`

#### 1. Replace imports

```diff
- import { FilesetResolver, LlmInference } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-genai/genai_bundle.mjs";
+ import * as webllm from "https://esm.run/@mlc-ai/web-llm";
  import { marked } from "https://esm.run/marked";
```

#### 2. Replace MODEL constant

```diff
- const MEDIAPIPE_WASM_PATH = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-genai/wasm";
- const MEDIAPIPE_CACHE_NAME = "thinkhere-mediapipe-models";
-
- const MODEL = {
-   id: "gemma-3n-E2B",
-   name: "Gemma 3n E2B",
-   desc: "Google's multimodal model...",
-   modelFile: "gemma-3n-E2B-it-int4-Web.litertlm",
-   hfRepo: "Volko76/gemma-3n-E2B-it-litert-lm",
-   ...
- };
+ const MODEL = {
+   id: "SmolLM2-1.7B-Instruct-q4f16_1-MLC",
+   name: "SmolLM2 1.7B",
+   desc: "Fast, lightweight chat model.",
+   tech: "WebLLM · MLC · WebGPU",
+   size: "~1 GB",
+   sizeMB: 1000,
+   time: "~1 – 3 min",
+   minRAM_GB: 4,
+ };
```

#### 3. Replace engine variable

```diff
- let mpInference = null;
+ let webllmEngine = null;
```

#### 4. Remove MediaPipe-specific code

Delete these functions entirely — WebLLM handles its own caching and downloading:

- `mediapipeCacheKey()`
- `getMediaPipeCachedBlob()`
- `downloadMediaPipeModel()`
- `downloadViaSW()`
- `downloadDirect()`
- `formatGemmaPrompt()` — WebLLM handles prompt formatting

Also delete the service worker registration related to MediaPipe caching.

#### 5. Rewrite `loadModel()`

The current `loadModel()` manually downloads the model blob, stores it in Cache API, and initialises MediaPipe. Replace with WebLLM's built-in engine creation which handles download, caching, and compilation automatically:

```js
window.loadModel = async function () {
  // ... keep existing safety checks (iPhone, WebGPU) ...

  // Hide intro, show loading
  if (introSection) introSection.style.display = "none";
  loadScreen.classList.add("active");
  document.getElementById("loadingModelName").textContent = MODEL.name;

  // ... keep existing timer/tip UI code, update tips text ...

  setPhase("download");

  try {
    webllmEngine = new webllm.MLCEngine();

    webllmEngine.setInitProgressCallback((report) => {
      const pct = Math.round(report.progress * 100);
      bar.style.width = `${pct}%`;
      statProgress.textContent = `${pct}%`;
      label.textContent = report.text;

      // Phase transitions based on progress text
      if (report.text.includes("Loading model")) setPhase("download");
      if (report.text.includes("Compiling")) setPhase("compile");
    });

    await webllmEngine.reload(MODEL.id);

    // Done — transition to chat
    clearInterval(timerInterval);
    clearInterval(tipInterval);
    setPhase("ready");
    label.textContent = "Ready!";
    bar.style.width = "100%";
    statProgress.textContent = "100%";

    await new Promise(r => setTimeout(r, 600));
    loadScreen.classList.remove("active");
    loadScreen.style.display = "none";
    document.getElementById("chatContainer").classList.add("active");
    document.getElementById("modelLabel").textContent = MODEL.name;
    document.getElementById("headerStatus").textContent = MODEL.name;
    document.getElementById("sendBtn").disabled = false;
    document.getElementById("userInput").focus();
    updateTokenCount();

  } catch (err) {
    // ... keep existing error handling UI ...
  }
};
```

#### 6. Rewrite `sendMessage()` inference

Replace `mpInference.generateResponse()` with WebLLM's OpenAI-compatible chat completions API:

```diff
- // Build multimodal input if attachments present
- let mpInput = prompt;
- if (pendingAttachments.length > 0) { ... }
-
- const genPromise = new Promise((resolve, reject) => {
-   mpInference.generateResponse(mpInput, (chunk, done) => {
-     ...
-   });
- });

+ const messages = [...chatHistory];
+ const completion = await webllmEngine.chat.completions.create({
+   messages,
+   temperature: 0.7,
+   max_tokens: 2048,
+   stream: true,
+ });
+
+ for await (const chunk of completion) {
+   if (shouldStop) break;
+   const delta = chunk.choices[0]?.delta?.content || "";
+   fullResponse += delta;
+   tokenCount++;
+   renderStreamingMarkdown(bubble, fullResponse);
+   scrollToBottom();
+ }
```

Key difference: WebLLM uses the standard OpenAI `messages` array format (`[{role, content}]`) directly — no need for `formatGemmaPrompt()`.

#### 7. Rewrite `generateConversationLabel()` (auto-title)

Same pattern — replace `mpInference.generateResponse()` with:

```js
const result = await webllmEngine.chat.completions.create({
  messages: [{ role: "user", content: summaryPrompt }],
  temperature: 0.3,
  max_tokens: 60,
  stream: false,
});
const label = result.choices[0].message.content.trim();
```

#### 8. Update `freeMemoryAndRetry()`

Replace MediaPipe cache cleanup with WebLLM cache cleanup:

```diff
- const cache = await caches.open(MEDIAPIPE_CACHE_NAME);
- await cache.delete(mediapipeCacheKey(MODEL.modelFile));
+ const cacheNames = await caches.keys();
+ for (const name of cacheNames) {
+   if (name.includes("webllm") || name.includes("mlc")) {
+     await caches.delete(name);
+   }
+ }
```

#### 9. Remove multimodal code

SmolLM2 is text-only. Remove:
- `handleImageUpload()` and related image attachment logic
- `pendingAttachments` array and processing
- The multimodal input building block in `sendMessage()`
- Image preview rendering in user bubbles

Keep `pendingFiles` (text file context) — that works with any model.

---

### `index.html`

1. **Remove multimodal UI** — Hide or remove the image upload button (`mmImageBtn`) and related input. Keep the text file attachment button.

2. **Update loading tips** — Change Gemma-specific text:
   - `"Gemma 3n supports text and image input"` → remove or replace
   - `"MediaPipe uses WebGPU"` → `"WebLLM uses WebGPU for fast on-device inference"`

3. **Update model description text** — Any hardcoded references to "Gemma 3n E2B", "~3 GB", "MediaPipe" in the intro/landing section should reference SmolLM2 1.7B (~1 GB).

4. **Remove service worker** — The `sw.js` file was used for MediaPipe cache serving. WebLLM manages its own caching. Remove the `<script>` that registers `sw.js`, and delete `sw.js`.

---

### `sw.js`

**Delete this file.** It was a MediaPipe-specific cache-serving service worker. WebLLM doesn't need it.

---

## Gemma: Auth-Gated in `app.thinkhere.ai`

Gemma does **not** need to be re-added to this upstream repo. The model journey is:

1. **`thinkhere.ai`** (this repo) — SmolLM2 1.7B only, no auth required. Users can try AI chat immediately.
2. When users sign up / convert, they're redirected to **`app.thinkhere.ai`** (the `thinkhere-app` repo) which has auth, multiple models, and Gemma behind the login gate.

So this upstream repo stays simple — one model, one backend, no auth. Gemma and other models are handled entirely in the `thinkhere-app` codebase.

---

## Summary of Deleted Code

| What | Why |
|------|-----|
| `mediapipeCacheKey()` | WebLLM manages its own cache |
| `getMediaPipeCachedBlob()` | WebLLM manages its own cache |
| `downloadMediaPipeModel()` | WebLLM manages its own download |
| `downloadViaSW()` / `downloadDirect()` | WebLLM manages its own download |
| `formatGemmaPrompt()` | WebLLM handles prompt formatting |
| `sw.js` | MediaPipe cache serving, not needed |
| Multimodal image code | SmolLM2 is text-only |
| Service worker registration | Not needed |
