# Voice Sales Agent Server

Tech stack:
- Node.js + Express
- Socket.io (WebSocket)
- Google Gemini (`@google/generative-ai`)
- gTTS (Google Text-to-Speech, unofficial Node wrapper)
- ChromaDB Cloud (`chromadb`, `@chroma-core/default-embed`)

## Features

- JWT-based auth hook (simple, replace with your own logic)
- Rate limiting (HTTP + Socket level)
- RAG service backed by ChromaDB Cloud
- LLM service using Gemini
- TTS service using gTTS
- Socket.io flow:
  - `user_message` → server
  - server: RAG → LLM → TTS
  - emits:
    - `agent_text` (final text)
    - `agent_audio` (base64-encoded MP3)

## Getting started

```bash
npm install
cp .env.example .env
# fill in env vars
npm run dev
```

Server listens on `PORT` (default 4000).

You can connect from React via Socket.io client:

```ts
import { io } from "socket.io-client";

const socket = io("http://localhost:4000", {
  auth: { token: "YOUR_JWT_TOKEN" },
});

socket.on("connect", () => {
  console.log("connected");
});

socket.emit("user_message", { text: "Tell me about product X" });

socket.on("agent_text", (payload) => {
  console.log("Agent:", payload.text);
});

socket.on("agent_audio", (payload) => {
  const audioBase64 = payload.audioBase64;
  // convert to Blob + play with Audio element / AudioContext
});
```# mercedes-sales-agent
