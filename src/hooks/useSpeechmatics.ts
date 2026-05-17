"use client";

import { useCallback, useRef, useState } from "react";
import type { Utterance } from "@/lib/types";

type Status = "idle" | "connecting" | "listening" | "error";

interface SmWord {
  type: string;
  alternatives?: { content: string; speaker?: string }[];
  is_eos?: boolean;
}

/**
 * Captures the mic, streams 16 kHz PCM to Speechmatics' real-time API, and
 * emits finalized speaker utterances. We segment on end-of-sentence punctuation
 * or a speaker change so the collision engine reasons over whole statements,
 * not word fragments.
 */
export function useSpeechmatics(onUtterance: (u: Utterance) => void) {
  const [status, setStatus] = useState<Status>("idle");
  const [partial, setPartial] = useState("");
  const [error, setError] = useState<string | null>(null);

  const clientRef = useRef<any>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const bufRef = useRef<{ speaker: string; text: string }>({
    speaker: "Speaker 1",
    text: "",
  });

  const flush = useCallback(() => {
    const b = bufRef.current;
    const text = b.text.trim();
    if (text.length < 2) {
      b.text = "";
      return;
    }
    onUtterance({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      speaker: b.speaker,
      text,
      at: Date.now(),
    });
    b.text = "";
  }, [onUtterance]);

  const ingest = useCallback(
    (results: SmWord[], isFinal: boolean) => {
      if (!isFinal) {
        setPartial(
          results
            .map((r) => r.alternatives?.[0]?.content ?? "")
            .join(" ")
            .replace(/\s+([.,!?])/g, "$1"),
        );
        return;
      }
      setPartial("");
      for (const r of results) {
        const alt = r.alternatives?.[0];
        if (!alt) continue;
        const speaker = alt.speaker
          ? `Speaker ${alt.speaker.replace(/^S/, "")}`
          : bufRef.current.speaker;

        if (speaker !== bufRef.current.speaker && bufRef.current.text.trim()) {
          flush();
        }
        bufRef.current.speaker = speaker;

        if (r.type === "punctuation") {
          bufRef.current.text += alt.content;
          if (/[.!?]/.test(alt.content)) flush();
        } else {
          bufRef.current.text += (bufRef.current.text ? " " : "") + alt.content;
        }
        if (r.is_eos) flush();
      }
    },
    [flush],
  );

  const start = useCallback(async () => {
    setError(null);
    setStatus("connecting");
    try {
      const { RealtimeClient } = await import("@speechmatics/real-time-client");

      const tokenRes = await fetch("/api/speechmatics-token");
      const tokenJson = await tokenRes.json();
      if (!tokenRes.ok) throw new Error(tokenJson.error || "token error");
      const jwt: string = tokenJson.jwt;

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      streamRef.current = stream;

      const ctx = new AudioContext();
      ctxRef.current = ctx;
      await ctx.audioWorklet.addModule("/pcm-worklet.js");
      const source = ctx.createMediaStreamSource(stream);
      const worklet = new AudioWorkletNode(ctx, "pcm-downsampler");

      const client = new RealtimeClient();
      clientRef.current = client;

      client.addEventListener("receiveMessage", ({ data }: any) => {
        if (data.message === "AddPartialTranscript") {
          ingest(data.results ?? [], false);
        } else if (data.message === "AddTranscript") {
          ingest(data.results ?? [], true);
        } else if (data.message === "Error") {
          setError(data.reason || "Speechmatics error");
          setStatus("error");
        }
      });

      worklet.port.onmessage = (e: MessageEvent) => {
        try {
          client.sendAudio(e.data as ArrayBuffer);
        } catch {
          /* socket not ready yet — drop the frame */
        }
      };

      await client.start(jwt, {
        transcription_config: {
          language: "en",
          operating_point: "enhanced",
          enable_partials: true,
          max_delay: 2,
          diarization: "speaker",
        },
        audio_format: {
          type: "raw",
          encoding: "pcm_s16le",
          sample_rate: 16000,
        },
      });

      source.connect(worklet);
      // Keep the graph alive without echoing mic to speakers.
      worklet.connect(ctx.destination);
      setStatus("listening");
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to start");
      setStatus("error");
    }
  }, [ingest]);

  const stop = useCallback(() => {
    flush();
    try {
      clientRef.current?.stopRecognition?.();
    } catch {
      /* ignore */
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    ctxRef.current?.close().catch(() => {});
    clientRef.current = null;
    streamRef.current = null;
    ctxRef.current = null;
    setStatus("idle");
    setPartial("");
  }, [flush]);

  return { status, partial, error, start, stop };
}
