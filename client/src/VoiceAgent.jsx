import React, { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import { SOCKET_URL_ENDPOINT } from "./CONSTANTS";

// TODO: replace with your real token (same one that works with /me)
const SOCKET_URL = SOCKET_URL_ENDPOINT
const VoiceAgent = () => {
  const [isConnected, setIsConnected] = useState(false);
  const [agentState, setAgentState] = useState("idle"); // idle | listening | processing | speaking
  const [messages, setMessages] = useState([]); // {id, role: 'user'|'agent', text}
  const [partialTranscript, setPartialTranscript] = useState("");
  const [statusText, setStatusText] = useState("Click start to begin");
  const [inputText, setInputText] = useState("");

  const socketRef = useRef(null);
  const recognitionRef = useRef(null);
  const audioRef = useRef(null);

  const lastAgentTextRef = useRef("");
  const lastFinalTranscriptRef = useRef("");

  const shouldListenRef = useRef(false); // controls continuous listening
  const isStartingRef = useRef(false);

  // audio streaming helpers
  const audioQueueRef = useRef([]); // [{ url, sentenceIndex }]
  const sentenceChunksRef = useRef([]); // [Uint8Array, ...] for current sentence
  const agentStateRef = useRef(agentState);

  // NEW: ignore incoming audio chunks after barge-in
  const ignoreAudioRef = useRef(false);

  // chat container ref for auto-scroll
  const chatRef = useRef(null);

  useEffect(() => {
    agentStateRef.current = agentState;
  }, [agentState]);

  // Auto-scroll to bottom whenever messages update
  useEffect(() => {
    if (chatRef.current) {
      chatRef.current.scrollTop = chatRef.current.scrollHeight;
    }
  }, [messages]);

  // -------- Helpers --------

  const addMessage = (role, text) => {
    setMessages((prev) => [
      ...prev,
      { id: Date.now() + Math.random(), role, text },
    ]);
  };

  const normalizeText = (str = "") =>
    str.toLowerCase().replace(/[.,!?]/g, "").trim();

  const isEchoOfAgent = (userTranscript) => {
    const userNorm = normalizeText(userTranscript);
    const agentNorm = normalizeText(lastAgentTextRef.current);

    if (!userNorm || !agentNorm) return false;
    if (userNorm.length < 10) return false;

    return (
      agentNorm.includes(userNorm) || userNorm.includes(agentNorm.slice(0, 40))
    );
  };

  const decodeBase64ToBytes = (base64) => {
    const byteString = atob(base64);
    const bytes = new Uint8Array(byteString.length);
    for (let i = 0; i < byteString.length; i++) {
      bytes[i] = byteString.charCodeAt(i);
    }
    return bytes;
  };

  const playNextInQueue = () => {
    const audio = audioRef.current;
    if (!audio) return;

    const next = audioQueueRef.current[0];
    if (!next) {
      // queue empty -> done speaking
      setAgentState("idle");
      setStatusText("Listening...");
      return;
    }

    audio.src = next.url;
    setAgentState("speaking");
    setStatusText("Speaking...");

    audio.onended = () => {
      try {
        URL.revokeObjectURL(next.url);
      } catch (e) {
        console.warn("Error revoking URL:", e);
      }
      audioQueueRef.current.shift();
      playNextInQueue();
    };

    audio
      .play()
      .catch((err) => {
        console.error("[Audio play error]", err);
        setAgentState("idle");
        setStatusText("Error playing audio");
      });
  };

  const stopAudioPlayback = () => {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.currentTime = 0;
      audio.removeAttribute("src");
      audio.load();
    }

    // clear queue + chunks and revoke URLs
    audioQueueRef.current.forEach((item) => {
      try {
        URL.revokeObjectURL(item.url);
      } catch (e) {
        console.warn("Error revoking URL:", e);
      }
    });
    audioQueueRef.current = [];
    sentenceChunksRef.current = [];

    setAgentState("idle");
    setStatusText("Listening...");
  };

  const startListening = () => {
    const recognition = recognitionRef.current;
    if (!recognition) return;

    try {
      console.log("[STT] start()");
      recognition.start();
      setAgentState((prev) => (prev === "speaking" ? prev : "listening"));
      setStatusText("Listening...");
    } catch (err) {
      console.warn("[STT] start error (likely already started):", err.message);
    }
  };

  const stopListening = () => {
    const recognition = recognitionRef.current;
    if (!recognition) return;
    try {
      console.log("[STT] stop()");
      recognition.stop();
    } catch (err) {
      console.warn("[STT] stop error:", err.message);
    }
  };

  const sendUserMessage = (text) => {
    const trimmed = text.trim();
    console.log(socketRef.current, isConnected);

    if (!trimmed) return;

    socketRef.current.emit("user_message", { text: trimmed });
    setAgentState("processing");
    setStatusText("Thinking...");
  };

  // -------- Speech Recognition setup --------

  const initSpeechRecognition = () => {
    if (recognitionRef.current) return;

    const SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      console.warn("SpeechRecognition API not supported in this browser.");
      setStatusText("SpeechRecognition not supported in this browser");
      return;
    }

    console.log("[STT] Initializing SpeechRecognition");
    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-IN"; // change if needed

    recognition.onstart = () => {
      console.log("[STT] onstart");
      setAgentState((prev) => (prev === "speaking" ? prev : "listening"));
      setStatusText("Listening...");
    };

    recognition.onerror = (event) => {
      console.error("[STT Error]", event.error);
      setStatusText(`Mic error: ${event.error}`);
    };

    recognition.onend = () => {
      console.log("[STT] onend");
      if (shouldListenRef.current) {
        console.log("[STT] Auto-restart recognition");
        startListening();
      } else {
        setAgentState("idle");
        setStatusText("Stopped listening");
      }
    };

    recognition.onresult = (event) => {
      let interim = "";
      let final = "";

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        if (res.isFinal) {
          final += res[0].transcript;
        } else {
          interim += res[0].transcript;
        }
      }

      if (interim) {
        setPartialTranscript(interim);
      } else {
        setPartialTranscript("");
      }

      if (final) {
        const finalTrimmed = final.trim();
        console.log("[STT] final transcript:", finalTrimmed);

        if (!finalTrimmed) return;
        if (finalTrimmed === lastFinalTranscriptRef.current) {
          console.log("[STT] ignoring duplicate final transcript");
          return;
        }
        lastFinalTranscriptRef.current = finalTrimmed;

        if (isEchoOfAgent(finalTrimmed)) {
          console.log("[STT] Ignoring echo of agent:", finalTrimmed);
          return;
        }

        // ---- BARGE IN: user spoke while agent is speaking ----
        if (agentStateRef.current === "speaking") {
          console.log("[VoiceAgent] Barge-in detected, stopping audio");
          // Ignore any remaining audio chunks for this old answer
          ignoreAudioRef.current = true;
          // Tell backend (optional) so it can stop TTS generation
          if (socketRef.current) {
            socketRef.current.emit("cancel_tts");
          }
          // Stop current playback and clear queue
          stopAudioPlayback();
        }

        addMessage("user", finalTrimmed);
        sendUserMessage(finalTrimmed);
      }
    };

    recognitionRef.current = recognition;
  };

  // -------- Socket.io setup --------

  const initSocket = () => {
    if (socketRef.current) return;

    console.log("[Socket] initializing connection to", SOCKET_URL);
    const socket = io(SOCKET_URL);

    socket.on("connect", () => {
      console.log("[Socket] connected:", socket.id);
      setIsConnected(true);
      setStatusText("Connected. Listening...");
      shouldListenRef.current = true;
      startListening();
    });

    socket.on("connect_error", (err) => {
      console.error("[Socket] connect_error:", err.message);
      setStatusText(`Socket connect error: ${err.message}`);
    });

    socket.on("disconnect", (reason) => {
      console.log("[Socket] disconnect:", reason);
      setIsConnected(false);
      setStatusText("Disconnected");
      shouldListenRef.current = false;
      stopListening();
      stopAudioPlayback();
    });

    socket.on("agent_text", (payload) => {
      const text = payload?.text || "";
      console.log("[Socket] agent_text:", text);
      lastAgentTextRef.current = text;
      addMessage("agent", text);

      // New answer is starting → allow audio again
      ignoreAudioRef.current = false;
    });

    // Streaming audio chunks per sentence
    socket.on("agent_audio_chunk", (payload) => {
      // If we've barged in and are ignoring old audio, drop all chunks
      if (ignoreAudioRef.current) {
        return;
      }

      const {
        audioBase64,
        sentenceIndex,
        isLastChunkOfSentence,
        isLastSentence,
      } = payload || {};

      // If we have actual audio data, store it as bytes for current sentence
      if (audioBase64) {
        const bytes = decodeBase64ToBytes(audioBase64);
        sentenceChunksRef.current.push(bytes);
      }

      // When a sentence stream ends, build a Blob and enqueue it
      if (isLastChunkOfSentence) {
        if (sentenceChunksRef.current.length > 0) {
          const totalLength = sentenceChunksRef.current.reduce(
            (sum, arr) => sum + arr.length,
            0
          );
          const merged = new Uint8Array(totalLength);
          let offset = 0;
          sentenceChunksRef.current.forEach((arr) => {
            merged.set(arr, offset);
            offset += arr.length;
          });

          // Deepgram is returning WAV → use audio/wav
          const blob = new Blob([merged], { type: "audio/wav" });
          const url = URL.createObjectURL(blob);

          audioQueueRef.current.push({ url, sentenceIndex });
          sentenceChunksRef.current = [];

          // If not already speaking, start playback immediately
          if (agentStateRef.current !== "speaking") {
            playNextInQueue();
          }
        }

        if (isLastSentence) {
          console.log("[Socket] Last sentence completed");
        }
      }
    });

    socket.on("agent_audio_end", () => {
      console.log("[Socket] agent_audio_end");
    });

    socket.on("error_message", (payload) => {
      console.error("[Socket error_message]", payload);
      setStatusText(`Error: ${payload?.error || "Unknown error"}`);
    });

    socketRef.current = socket;
  };

  // -------- Start / Stop controls --------

  const handleStart = () => {
    if (isStartingRef.current) return;
    isStartingRef.current = true;

    console.log("[VoiceAgent] Start clicked");
    initSpeechRecognition();
    initSocket();
  };

  const handleStop = () => {
    console.log("[VoiceAgent] Stop clicked");
    shouldListenRef.current = false;
    ignoreAudioRef.current = true; // ignore any trailing audio
    stopListening();
    stopAudioPlayback();
    if (socketRef.current) {
      socketRef.current.disconnect();
      socketRef.current = null;
    }
    setAgentState("idle");
    setIsConnected(false);
    setStatusText("Stopped");
    isStartingRef.current = false;
  };

  const handleSendText = () => {
    if (!inputText.trim()) return;
    addMessage("user", inputText.trim());
    sendUserMessage(inputText);
    setInputText("");
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      shouldListenRef.current = false;
      ignoreAudioRef.current = true;
      stopListening();
      stopAudioPlayback();
      if (socketRef.current) {
        socketRef.current.disconnect();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isListening = agentState === "listening";
  const isSpeaking = agentState === "speaking";
  const isProcessing = agentState === "processing";

  // -------- UI --------

  return (
    <>
      {/* Component-scoped styles */}
      <style>{`
        .va-root {
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 24px;
          background: radial-gradient(circle at top left, #111827 0%, #020617 40%, #000000 100%);
          color: #e5e7eb;
          position: relative;
          overflow: hidden;
        }

        .va-root::before {
          content: "";
          position: absolute;
          inset: -20%;
          background-image: url("/mercedes-logo.png");
          background-repeat: no-repeat;
          background-position: center;
          background-size: 420px;
          opacity: 0.04;
          filter: grayscale(1);
          pointer-events: none;
        }

        .va-card {
          position: relative;
          width: 100%;
          max-width: 780px;
          border-radius: 28px;
          background: linear-gradient(135deg, rgba(15,23,42,0.92), rgba(15,23,42,0.75));
          border: 1px solid rgba(148,163,184,0.4);
          box-shadow: 0 24px 80px rgba(0,0,0,0.6);
          padding: 22px 22px 18px;
          backdrop-filter: blur(18px);
          z-index: 1;
        }

        .va-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 10px;
        }

        .va-badge {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 4px 10px;
          border-radius: 999px;
          background: rgba(15,23,42,0.95);
          border: 1px solid rgba(148,163,184,0.4);
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: #e5e7eb;
        }

        .va-status-dot {
          width: 7px;
          height: 7px;
          border-radius: 999px;
          background: #22c55e;
        }

        .va-status-dot.offline {
          background: #ef4444;
        }

        .va-status-text {
          font-size: 13px;
          color: #9ca3af;
          margin-left: 4px;
        }

        .va-controls {
          display: flex;
          align-items: center;
          gap: 10px;
          margin: 10px 0 14px;
        }

        .va-mic-wrap {
          position: relative;
          width: 64px;
          height: 64px;
          border-radius: 999px;
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          border: 1px solid rgba(148,163,184,0.4);
          overflow: visible;
        }

        .va-mic-inner {
          width: 46px;
          height: 46px;
          border-radius: 999px;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 22px;
          background: radial-gradient(circle at 30% 0, #e5e7eb, #6b7280);
          color: #020617;
          box-shadow: 0 0 20px rgba(59,130,246,0.45);
        }

        .va-mic-ring-listening::before,
        .va-mic-ring-speaking::before {
          content: "";
          position: absolute;
          width: 96px;
          height: 96px;
          border-radius: 999px;
          border: 1px solid rgba(56,189,248,0.4);
          animation: va-pulse-soft 1.1s ease-out infinite;
        }

        .va-mic-ring-speaking::before {
          border-color: rgba(59,130,246,0.7);
          animation-duration: 1.4s;
        }

        .va-pill {
          padding: 7px 14px;
          border-radius: 999px;
          border: 1px solid rgba(148,163,184,0.45);
          background: rgba(15,23,42,0.85);
          font-size: 12px;
          display: inline-flex;
          align-items: center;
          gap: 6px;
          color: #e5e7eb;
        }

        .va-pill-dot {
          width: 6px;
          height: 6px;
          border-radius: 99px;
          background: #22c55e;
        }

        .va-pill-dot.processing {
          background: #facc15;
        }

        .va-pill-dot.speaking {
          background: #60a5fa;
        }

        .va-icon-spinner {
          width: 13px;
          height: 13px;
          border-radius: 999px;
          border: 2px solid rgba(148,163,184,0.5);
          border-top-color: #e5e7eb;
          animation: va-spin 0.8s linear infinite;
        }

        .va-button {
          padding: 8px 16px;
          border-radius: 999px;
          border: 1px solid rgba(148,163,184,0.5);
          font-size: 13px;
          cursor: pointer;
          background: rgba(15,23,42,0.9);
          color: #e5e7eb;
          display: inline-flex;
          align-items: center;
          gap: 6px;
          transition: all 0.16s ease-out;
        }

        .va-button.primary {
          background: linear-gradient(to right, #22c55e, #16a34a);
          border-color: rgba(34,197,94,0.85);
          color: #022c22;
        }

        .va-button.primary:disabled {
          opacity: 0.55;
          cursor: default;
        }

        .va-button.primary:not(:disabled):hover {
          transform: translateY(-1px);
          box-shadow: 0 15px 35px rgba(34,197,94,0.3);
        }

        .va-button.danger {
          background: transparent;
          border-color: rgba(239,68,68,0.9);
          color: #fecaca;
        }

        .va-button.danger:hover {
          background: rgba(248,113,113,0.08);
        }

        .va-input-row {
          display: flex;
          gap: 10px;
          margin-bottom: 12px;
          margin-top: 2px;
        }

        .va-input {
          flex: 1;
          padding: 9px 12px;
          border-radius: 999px;
          border: 1px solid rgba(148,163,184,0.5);
          background: rgba(15,23,42,0.9);
          color: #e5e7eb;
          font-size: 14px;
          outline: none;
        }

        .va-input::placeholder {
          color: #6b7280;
        }

        .va-chat {
          height: 280px;
          overflow-y: auto;
          border-radius: 18px;
          border: 1px solid rgba(30,64,175,0.6);
          padding: 12px;
          background: radial-gradient(circle at top, rgba(15,23,42,0.96), rgba(15,23,42,0.92));
        }

        .va-chat-empty {
          font-size: 13px;
          color: #9ca3af;
          text-align: center;
          padding-top: 32px;
        }

        .va-msg-row {
          margin-bottom: 10px;
          display: flex;
        }

        .va-msg-row.user {
          justify-content: flex-end;
        }

        .va-msg-bubble {
          max-width: 80%;
          padding: 7px 11px;
          border-radius: 14px;
          font-size: 14px;
          line-height: 1.4;
          box-shadow: 0 10px 30px rgba(0,0,0,0.35);
          transform-origin: bottom;
          animation: va-pop 0.18s ease-out;
        }

        .va-msg-bubble.user {
          background: linear-gradient(to right bottom, #2563eb, #1d4ed8);
          color: white;
          border-bottom-right-radius: 4px;
        }

        .va-msg-bubble.agent {
          background: rgba(15,23,42,0.96);
          color: #e5e7eb;
          border: 1px solid rgba(55,65,81,0.9);
          border-bottom-left-radius: 4px;
        }

        .va-msg-label {
          font-size: 11px;
          text-transform: uppercase;
          opacity: 0.7;
          margin-bottom: 2px;
        }

        .va-partial {
          font-size: 13px;
          color: #e5e7eb;
          padding: 7px 11px;
          border-radius: 999px;
          background: rgba(15,23,42,0.9);
          border: 1px dashed rgba(148,163,184,0.7);
          margin-top: 10px;
          display: inline-flex;
          align-items: center;
          gap: 8px;
        }

        .va-dots {
          display: inline-flex;
          gap: 3px;
        }

        .va-dot {
          width: 4px;
          height: 4px;
          border-radius: 999px;
          background: #e5e7eb;
          opacity: 0.6;
          animation: va-bounce 1.1s infinite;
        }

        .va-dot:nth-child(2) {
          animation-delay: 0.15s;
        }
        .va-dot:nth-child(3) {
          animation-delay: 0.3s;
        }

        @keyframes va-spin {
          to { transform: rotate(360deg); }
        }

        @keyframes va-pulse-soft {
          0% {
            transform: scale(0.7);
            opacity: 0.7;
          }
          100% {
            transform: scale(1.25);
            opacity: 0;
          }
        }

        @keyframes va-pop {
          from {
            transform: translateY(2px) scale(0.97);
            opacity: 0;
          }
          to {
            transform: translateY(0) scale(1);
            opacity: 1;
          }
        }

        @keyframes va-bounce {
          0%, 80%, 100% { transform: translateY(0); opacity: 0.4; }
          40% { transform: translateY(-3px); opacity: 1; }
        }

        @media (max-width: 640px) {
          .va-card {
            padding: 18px 14px 14px;
            border-radius: 22px;
          }
          .va-chat {
            height: 260px;
          }
        }
      `}</style>

      <div className="va-root">
        <div className="va-card">
          <div className="va-header">
            <div>
              <div className="va-badge">
                <span
                  className={
                    "va-status-dot" + (isConnected ? "" : " offline")
                  }
                />
                Mercedes Voice Lounge
              </div>
            </div>

            <div className="va-pill">
              {isProcessing ? (
                <span className="va-icon-spinner" />
              ) : (
                <span
                  className={
                    "va-pill-dot " +
                    (isSpeaking
                      ? "speaking"
                      : isListening
                      ? ""
                      : "processing")
                  }
                />
              )}
              <span>
                {isSpeaking
                  ? "Agent is speaking"
                  : isProcessing
                  ? "Analyzing your question"
                  : isListening
                  ? "Listening"
                  : "Idle"}
              </span>
            </div>
          </div>

          {/* Controls row */}
          <div className="va-controls">
            {/* Mic / state button */}
            <div
              className={
                "va-mic-wrap " +
                (isListening ? "va-mic-ring-listening" : "") +
                (isSpeaking ? " va-mic-ring-speaking" : "")
              }
              onClick={isConnected ? undefined : handleStart}
            >
              <div className="va-mic-inner">
                {isSpeaking ? "🔊" : isListening ? "🎙️" : "🎚️"}
              </div>
            </div>

            {/* Start / Stop buttons */}
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={handleStart}
                disabled={isConnected}
                className="va-button primary"
              >
                {isConnected ? "Connected" : "Start chatting"}
              </button>
              {isConnected && (
                <button onClick={handleStop} className="va-button danger">
                  ⏹ Stop
                </button>
              )}
            </div>
          </div>

          {/* Chat window */}
          <div className="va-chat" ref={chatRef}>
            {messages.length === 0 ? (
              <div className="va-chat-empty">
                Your private Mercedes-Benz consultant is ready. Say
                &quot;Hello&quot; or ask about a model, feature, or offer.
              </div>
            ) : (
              messages.map((m) => (
                <div
                  key={m.id}
                  className={
                    "va-msg-row " + (m.role === "user" ? "user" : "agent")
                  }
                >
                  <div
                    className={
                      "va-msg-bubble " +
                      (m.role === "user" ? "user" : "agent")
                    }
                  >
                    <div className="va-msg-label">
                      {m.role === "user" ? "You" : "Mercedes Expert Agent"}
                    </div>
                    <div>{m.text}</div>
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Partial speech preview */}
          {partialTranscript && (
            <div className="va-partial">
              <span>Listening:</span>
              <span>{partialTranscript}</span>
              <span className="va-dots">
                <span className="va-dot" />
                <span className="va-dot" />
                <span className="va-dot" />
              </span>
            </div>
          )}

          {/* Hidden audio element for playing agent TTS */}
          <audio ref={audioRef} />
        </div>
      </div>
    </>
  );
};

export default VoiceAgent;
