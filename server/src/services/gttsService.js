// services/ttsService.js
import gTTS from "gtts";
import { logError } from "../utils/logger.js";

/**
 * Optional: old helper, still here if you need the full MP3 at once.
 */
export function textToSpeechBase64(text, lang = "en") {
  return new Promise((resolve, reject) => {
    try {
      const gtts = new gTTS(text, lang);
      const chunks = [];

      const stream = gtts.stream();
      stream.on("data", (chunk) => {
        chunks.push(chunk);
      });

      stream.on("end", () => {
        const buffer = Buffer.concat(chunks);
        const base64 = buffer.toString("base64");
        resolve(base64);
      });

      stream.on("error", (err) => {
        logError("gTTS error:", err);
        reject(err);
      });
    } catch (err) {
      logError("textToSpeechBase64 error:", err);
      reject(err);
    }
  });
}

/**
 * Simple sentence splitter – you can tune this as needed.
 */
function splitIntoSentences(text) {
  return text
    .split(/(?<=[.!?])\s+/) // split after ., ?, !
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Stream TTS to the client in chunks, sentence by sentence.
 * Emits:
 *  - "agent_audio_chunk": { audioBase64, sentenceIndex, chunkIndex, isLastChunkOfSentence, isLastSentence }
 *  - "agent_audio_end":   when all sentences are done
 */
export async function streamTextToSpeechChunks({
  socket,
  text,
  lang = "en",
}) {
  const sentences = splitIntoSentences(text);
  if (!sentences.length) return;

  for (let sentenceIndex = 0; sentenceIndex < sentences.length; sentenceIndex++) {
    const sentence = sentences[sentenceIndex];
    if (!sentence) continue;

    await new Promise((resolve, reject) => {
      try {
        const gtts = new gTTS(sentence, lang);
        const stream = gtts.stream();
        let chunkIndex = 0;

        stream.on("data", (chunk) => {
          const base64 = chunk.toString("base64");
          socket.emit("agent_audio_chunk", {
            audioBase64: base64,
            sentenceIndex,
            chunkIndex,
            // we don't know if it's the last sentence yet; we mark last in "end"
            isLastSentence: false,
            // we don't know if this is last chunk of sentence yet; mark in "end"
            isLastChunkOfSentence: false,
          });
          chunkIndex++;
        });

        stream.on("end", () => {
          // notify that this sentence is complete
          socket.emit("agent_audio_chunk", {
            audioBase64: null, // or omit
            sentenceIndex,
            chunkIndex: -1,
            isLastSentence: sentenceIndex === sentences.length - 1,
            isLastChunkOfSentence: true,
          });
          resolve();
        });

        stream.on("error", (err) => {
          logError("gTTS stream error:", err);
          reject(err);
        });
      } catch (err) {
        logError("streamTextToSpeechChunks error:", err);
        reject(err);
      }
    });
  }

  // all sentences completed
  socket.emit("agent_audio_end");
}
