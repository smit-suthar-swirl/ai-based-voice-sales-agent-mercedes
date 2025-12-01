// services/ttsService.js
import fetch from "node-fetch";
import { logError } from "../utils/logger.js";

const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const DEEPGRAM_TTS_URL = "https://api.deepgram.com/v1/speak";

if (!DEEPGRAM_API_KEY) {
  logError(
    "Deepgram TTS init error:",
    new Error("DEEPGRAM_API_KEY is not set in environment")
  );
}

/**
 * Pick a Deepgram Aura model based on language.
 * Extend this as you add more languages/voices.
 */
function getTtsModelForLang(lang = "en") {
  switch (lang.toLowerCase()) {
    case "en":
    default:
      // Aura-2 voice (update to whichever you like)
      return "aura-2-vesta-en";
  }
}

/**
 * Low-level helper: call Deepgram TTS REST and get a Buffer with audio.
 * We request WAV (container=wav, encoding=linear16).
 */
async function synthesizeToBuffer(text, lang = "en") {
  const trimmed = (text || "").trim();
  if (!trimmed) return Buffer.alloc(0);

  const model = getTtsModelForLang(lang);

  const params = new URLSearchParams({
    model,
    encoding: "linear16", // PCM 16-bit
    container: "wav", // valid variants: wav, ogg, none
      speech_rate: "1.7",
  });

  const url = `${DEEPGRAM_TTS_URL}?${params.toString()}`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Token ${DEEPGRAM_API_KEY}`,
        "Content-Type": "application/json",
        Accept: "audio/wav",
      },
      body: JSON.stringify({ text: trimmed }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      const err = new Error(
        `Deepgram TTS error: ${response.status} ${response.statusText} - ${errorText}`
      );
      logError("synthesizeToBuffer HTTP error:", err);
      throw err;
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (err) {
    logError("synthesizeToBuffer fatal error:", err);
    throw err;
  }
}

/**
 * Optional: old helper, still here if you need the full audio at once.
 * Now implemented using Deepgram instead of gTTS.
 * Returns base64-encoded WAV.
 */
export async function textToSpeechBase64(text, lang = "en") {
  try {
    const audioBuffer = await synthesizeToBuffer(text, lang);
    if (!audioBuffer.length) return "";
    return audioBuffer.toString("base64");
  } catch (err) {
    logError("textToSpeechBase64 error:", err);
    throw err;
  }
}

/**
 * Simple sentence splitter – you can tune this as needed.
 */
function splitIntoSentences(text) {
  return (text || "")
    .split(/(?<=[.!?])\s+/) // split after ., ?, !
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Stream TTS to the client in chunks, sentence by sentence.
 * Emits:
 *  - "agent_audio_chunk": {
 *        audioBase64,
 *        sentenceIndex,
 *        chunkIndex,
 *        isLastChunkOfSentence,
 *        isLastSentence
 *    }
 *  - "agent_audio_end": when all sentences are done

 */
export async function streamTextToSpeechChunks({
  socket,
  text,
  lang = "en",
}) {
  try {
    const sentences = splitIntoSentences(text);
    if (!sentences.length) return;

    // Smaller chunks → more frequent updates → feels smoother.
    // You can bump this to 8192/16384 if events feel too many.
    const CHUNK_SIZE_BYTES = 4096;

    let nextBufferPromise = null;

    for (
      let sentenceIndex = 0;
      sentenceIndex < sentences.length;
      sentenceIndex++
    ) {
      const sentence = sentences[sentenceIndex];
      if (!sentence) continue;

      try {
        let audioBuffer;

        if (sentenceIndex === 0) {
          // First sentence: just synthesize it
          audioBuffer = await synthesizeToBuffer(sentence, lang);

          // Start preparing the next sentence *while* we stream this one
          if (sentenceIndex + 1 < sentences.length) {
            const nextSentence = sentences[sentenceIndex + 1];
            nextBufferPromise = synthesizeToBuffer(nextSentence, lang);
          }
        } else {
          // For later sentences: we already kicked off synthesizeToBuffer
          // in the previous iteration, so we just await that promise.
          audioBuffer = await nextBufferPromise;

          // And immediately start the next one (if exists)
          if (sentenceIndex + 1 < sentences.length) {
            const nextSentence = sentences[sentenceIndex + 1];
            nextBufferPromise = synthesizeToBuffer(nextSentence, lang);
          } else {
            nextBufferPromise = null;
          }
        }

        let chunkIndex = 0;

        // If Deepgram returned an empty buffer, still emit the "end-of-sentence" marker
        if (audioBuffer && audioBuffer.length) {
          for (
            let offset = 0;
            offset < audioBuffer.length;
            offset += CHUNK_SIZE_BYTES
          ) {
            const chunk = audioBuffer.subarray(
              offset,
              Math.min(offset + CHUNK_SIZE_BYTES, audioBuffer.length)
            );
            const base64 = chunk.toString("base64");

            socket.emit("agent_audio_chunk", {
              audioBase64: base64,
              sentenceIndex,
              chunkIndex,
              isLastSentence: false, // actual last is marked in end-event
              isLastChunkOfSentence: false,
            });

            chunkIndex++;
          }
        }

        // Notify that this sentence is complete.
        // Because next sentence's buffer is already being prepared,
        // the gap between this and the next sentence on the client side
        // should be much smaller now.
        socket.emit("agent_audio_chunk", {
          audioBase64: null, // or omit on the client
          sentenceIndex,
          chunkIndex: -1,
          isLastSentence: sentenceIndex === sentences.length - 1,
          isLastChunkOfSentence: true,
        });
      } catch (err) {
        // Log per-sentence TTS error and notify client
        logError("streamTextToSpeechChunks Deepgram sentence error:", err);

        socket.emit("agent_audio_error", {
          message: "TTS failed for sentence",
          sentenceIndex,
          details: err?.message || String(err),
        });

        // You can `continue` instead to try the next sentence
        break;
      }
    }

    // all sentences completed (or aborted)
    socket.emit("agent_audio_end");
  } catch (err) {
    logError("streamTextToSpeechChunks fatal error:", err);
    socket.emit("agent_audio_error", {
      message: "TTS failed",
      details: err?.message || String(err),
    });
  }
}
