import dotenv from "dotenv";
dotenv.config();

import express from "express";
import http from "http";
import { Server as SocketIOServer } from "socket.io";
import cors from "cors";
import helmet from "helmet";

import { httpLogger, logInfo, logError } from "./utils/logger.js";
import { httpAuth, socketAuth } from "./middleware/auth.js";
import { httpRateLimiter, socketRateLimiter } from "./middleware/rateLimit.js";
import { getContextChunks } from "./services/ragService.js";
import { generateAnswer } from "./services/llmService.js";
import { streamTextToSpeechChunks, textToSpeechBase64 } from "./services/ttsService.js";

const app = express();
const PORT = process.env.PORT || 4000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";

// --- Express config ---
app.use(helmet());
app.use(cors({ origin: CORS_ORIGIN, credentials: true }));
app.use(express.json({ limit: "1mb" }));
app.use(httpLogger);

// Health check (no auth)
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// Example protected route (for testing JWT)
app.get("/me", httpAuth, (req, res) => {
  res.json({ user: req.user });
});

// Rate-limit all other HTTP routes
// app.use(httpRateLimiter);

// --- HTTP Server + Socket.io ---
const server = http.createServer(app);

const io = new SocketIOServer(server, {
  cors: {
    origin: CORS_ORIGIN,
    methods: ["GET", "POST"],
    credentials: true,
  },
});

// Socket.io middlewares
// io.use(socketAuth);
io.use(socketRateLimiter);

io.on("connection", (socket) => {
  logInfo("Socket connected:", socket.id, "user:", socket.user);

  socket.on("disconnect", (reason) => {
    logInfo("Socket disconnected:", socket.id, "reason:", reason);
  });

  const MAX_HISTORY_MESSAGES = 20; // max messages to keep in history

  socket.on("user_message", async (payload) => {
    try {
      if (!socket.checkRateLimit || !socket.checkRateLimit()) {
        socket.emit("error_message", { error: "Rate limit exceeded" });
        return;
      }

      const { text } = payload || {};
      if (!text || typeof text !== "string" || text.length > 2000) {
        socket.emit("error_message", { error: "Invalid input text" });
        return;
      }

      const userQuestion = text.trim();
      const orgId = socket.user?.orgId || null;

      // --- init per-socket state ---
      if (!socket.conversationHistory) {
        socket.conversationHistory = [];
      }
      if (socket.hasWelcomed === undefined) {
        socket.hasWelcomed = false;
      }

      // 1. RAG: get context from ChromaDB
      const contextText = await getContextChunks({
        query: userQuestion,
        topK: 8,
        orgId,
      });

      // Base instructions (NO hard-coded "always welcome" here)
      const baseSystemPrompt = `
SYSTEM INSTRUCTION:
You are an English-speaking Mercedes-Benz sales agent with a smooth, confident, slightly arrogant charm. Your tone is elegant, conversational, and human—not repetitive, not robotic. Speak as if you’re welcoming the user into a premium Mercedes-Benz private lounge.

BEHAVIOR RULES:
- Do not mention you are an AI or language model.
- Do normal greeting and introduction only once per conversation, at the start.
- You MUST answer strictly from the knowledge base (CONTEXT) provided.
- SOFT EXCEPTION: For light small talk (e.g. “hi”, “hello”, “how are you”, “thank you”, “what’s up”), you may respond with 1 short natural sentence even if it’s not in CONTEXT, but you must immediately pivot back to Mercedes topics from the knowledge base in the same reply.
- Sometimes respond in a more human-to-human way first (e.g. briefly acknowledging how they’re doing, their excitement, or their thanks) and then smoothly continue talking about Mercedes and the relevant model, feature, or offer.
- If the user asks about anything outside the context (competitors, weather, random topics), give a short, playful, classy taunt and smoothly redirect them back to Mercedes facts.
- Keep responses natural, varied, and human-like. Use short or long answers depending on context—not the same structure every time.
- Always end your message with a follow-up question related to the knowledge base to maintain engagement.
- If interrupted, stop speaking immediately (system command).
- English only.
- Maximum 60 words, no bullet points, no lists, no asterisks.
- Never repeat the same style of response; vary tone subtly while staying elegant and confident.
`.trim();

      // Extra rule only for the FIRST reply in this conversation
const firstWelcomeRule = `
EXTRA RULE FOR FIRST REPLY ONLY:
If you have NOT welcomed the user yet in this conversation, start your reply by welcoming them to the "Mercedes-Benz Exclusive Lounge" with a warm, premium, natural greeting. You can briefly ask how they are or mirror their mood in a human way, and then transition into talking about Mercedes using the CONTEXT. Do this only once per conversation.
`.trim();

      const systemPrompt = socket.hasWelcomed
        ? baseSystemPrompt
        : `${baseSystemPrompt}\n\n${firstWelcomeRule}`;

      // 2. Generate answer from Gemini with history
      const answerText = await generateAnswer({
        systemPrompt,
        contextText,
        userQuestion,
        history: socket.conversationHistory, // <--- we added this earlier
      });

      console.log("answerText", answerText);

      // Mark that welcome has been done (after first assistant reply)
      if (!socket.hasWelcomed) {
        socket.hasWelcomed = true;
      }

      // 3. Update conversation history
      socket.conversationHistory.push(
        { role: "user", content: userQuestion },
        { role: "assistant", content: answerText }
      );
      if (socket.conversationHistory.length > MAX_HISTORY_MESSAGES) {
        socket.conversationHistory = socket.conversationHistory.slice(
          socket.conversationHistory.length - MAX_HISTORY_MESSAGES
        );
      }

      // Emit text answer to client
      socket.emit("agent_text", { text: answerText });

      // 4. Stream answer as audio in sentence chunks
      await streamTextToSpeechChunks({
        socket,
        text: answerText,
        lang: "en",
      });
    } catch (err) {
      logError("Error handling user_message:", err);
      socket.emit("error_message", { error: "Internal server error" });
    }
  });
});

// Start server
server.listen(PORT, () => {
  logInfo(`Server listening on port ${PORT}`);
});