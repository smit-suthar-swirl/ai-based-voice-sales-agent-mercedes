import dotenv from "dotenv";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { logError } from "../utils/logger.js";

dotenv.config();

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.warn("[WARN] GEMINI_API_KEY is not set. LLM calls will fail.");
}

const genAI = apiKey ? new GoogleGenerativeAI(apiKey) : null;

/**
 * Generate an answer from Gemini using:
 * - systemPrompt (as systemInstruction)
 * - optional conversation history
 * - current RAG context
 * - current user question
 *
 * history format: [{ role: "user" | "assistant", content: string }]
 */
export async function generateAnswer({
  systemPrompt,
  contextText,
  userQuestion,
  history = [],
}) {
  if (!genAI) {
    throw new Error("Gemini client not initialized - missing GEMINI_API_KEY");
  }

  console.log("contextText", contextText);

  // Build a model instance with systemInstruction for this call
  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash-lite",
    // put your Mercedes lounge instructions here so they are always applied
    systemInstruction: systemPrompt?.trim() || "",
  });

  // Convert your stored history to Gemini's roles
  const historyMessages = (history || []).map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  // Current turn: RAG context + latest question
  const currentTurnText = [
    "CONTEXT:",
    contextText || "(no context available)",
    "",
    "QUESTION:",
    userQuestion,
  ].join("\n");

  try {
    const result = await model.generateContent({
      contents: [
        ...historyMessages,
        {
          role: "user",
          parts: [{ text: currentTurnText }],
        },
      ],
    });

    const response = result.response;
    const text = response.text();
    return text?.trim() || "";
  } catch (err) {
    logError("Error in generateAnswer:", err);
    throw err;
  }
}
