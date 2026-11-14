"use client";

// In-page QR scanner: camera permission handling, camera selection, torch
// (only when the camera reports it), and live decoding. Decoding uses the
// browser's BarcodeDetector when present and falls back to jsQR on a canvas.

import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, CameraOff, Flashlight, FlashlightOff, Loader2 } from "lucide-react";
import { Alert, Button, Select } from "@/components/ui";

type Phase = "idle" | "starting" | "scanning" | "denied" | "unavailable" | "error";
type Detector = { detect: (source: CanvasImageSource) => Promise<Array<{ rawValue: string }>> };
type TorchCapabilities = MediaTrackCapabilities & { torch?: boolean };

export function cameraErrorMessage(name: string): { phase: Phase; text: string } {
  if (name === "NotAllowedError" || name === "SecurityError")
    return { phase: "denied", text: "Camera access was blocked. Allow the camera for this site in your browser settings, or type the pairing code instead." };
  if (name === "NotFoundError" || name === "OverconstrainedError")
    return { phase: "unavailable", text: "No camera was found on this device. Type the pairing code instead." };
  if (name === "NotReadableError") return { phase: "error", text: "The camera is in use by another app. Close it and try again." };
  return { phase: "error", text: "The camera could not be started. Try again or type the pairing code instead." };
}

export function QrScanner({ onResult, paused = false }: { onResult: (text: string) => void; paused?: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const frameRef = useRef(0);
  const resultRef = useRef(onResult);
  resultRef.current = onResult;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState("");
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [cameraId, setCameraId] = useState("");
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);

  const stop = useCallback(() => {
    cancelAnimationFrame(frameRef.current);
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setTorchOn(false);
    setTorchSupported(false);
  }, []);

  const start = useCallback(async (deviceId?: string) => {
    stop();
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setPhase("unavailable");
      setMessage(window.isSecureContext ? "This browser cannot use the camera. Type the pairing code instead." : "The camera only works on a secure (https) page. Type the pairing code instead.");
      return;
    }
    setPhase("starting");
    setMessage("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: "environment" } },
      });
      streamRef.current = stream;
      const track = stream.getVideoTracks()[0];
      const caps = (track.getCapabilities?.() ?? {}) as TorchCapabilities;
      setTorchSupported(Boolean(caps.torch));
      setCameraId(track.getSettings().deviceId ?? deviceId ?? "");
      // Labels are only available after permission is granted.
      const all = await navigator.mediaDevices.enumerateDevices();
      setCameras(all.filter((item) => item.kind === "videoinput"));
      const video = videoRef.current;
      if (!video) { stop(); return; }
      video.srcObject = stream;
      await video.play();
      setPhase("scanning");

      const Native = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => Detector }).BarcodeDetector;
      let detector: Detector | null = null;
      try { detector = Native ? new Native({ formats: ["qr_code"] }) : null; } catch { detector = null; }
      const jsQR = detector ? null : (await import("jsqr")).default;
      let busy = false;
      let last = 0;
      const tick = async (time: number) => {
        if (!streamRef.current) return;
        frameRef.current = requestAnimationFrame((t) => void tick(t));
        if (busy || pausedRef.current || time - last < 160 || video.readyState < 2 || !video.videoWidth) return;
        busy = true;
        last = time;
        try {
          let value = "";
          if (detector) {
            value = (await detector.detect(video))[0]?.rawValue ?? "";
          } else if (jsQR) {
            const canvas = (canvasRef.current ??= document.createElement("canvas"));
            const scale = Math.min(1, 640 / video.videoWidth);
            canvas.width = Math.round(video.videoWidth * scale);
            canvas.height = Math.round(video.videoHeight * scale);
            const ctx = canvas.getContext("2d", { willReadFrequently: true });
            if (ctx) {
              ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
              const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
              value = jsQR(image.data, image.width, image.height, { inversionAttempts: "dontInvert" })?.data ?? "";
            }
          }
          if (value) resultRef.current(value);
        } catch {
          // A single unreadable frame is normal; keep scanning.
        } finally {
          busy = false;
        }
      };
      frameRef.current = requestAnimationFrame((t) => void tick(t));
    } catch (error) {
      stop();
      const info = cameraErrorMessage(error instanceof DOMException ? error.name : "");
      setPhase(info.phase);
      setMessage(info.text);
    }
  }, [stop]);

  useEffect(() => stop, [stop]);

  async function toggleTorch() {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    try {
      await track.applyConstraints({ advanced: [{ torch: !torchOn } as MediaTrackConstraintSet] });
      setTorchOn((on) => !on);
    } catch {
      setTorchSupported(false);
    }
  }

  const live = phase === "scanning" || phase === "starting";
  return (
    <div className="space-y-3">
      <div className="relative mx-auto aspect-square w-full max-w-xs overflow-hidden rounded-2xl border border-border bg-black">
        <video ref={videoRef} playsInline muted className={live ? "h-full w-full object-cover" : "hidden"} aria-label="Camera preview for scanning the Parent QR code" />
        {phase === "scanning" ? <div aria-hidden className="pointer-events-none absolute inset-8 rounded-xl border-2 border-accent/80" /> : null}
        {phase === "starting" ? (
          <div className="absolute inset-0 flex items-center justify-center text-white/80"><Loader2 className="animate-spin" size={22} /></div>
        ) : null}
        {!live ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-4 text-center text-white/70">
            {phase === "idle" ? <Camera size={26} /> : <CameraOff size={26} />}
            <Button onClick={() => void start(cameraId || undefined)}>{phase === "idle" ? "Start camera" : "Try again"}</Button>
          </div>
        ) : null}
      </div>
      <div aria-live="polite">{message ? <Alert tone={phase === "denied" || phase === "error" ? "danger" : "warning"}>{message}</Alert> : null}</div>
      {live ? (
        <div className="flex flex-wrap items-center justify-center gap-2">
          {cameras.length > 1 ? (
            <Select aria-label="Camera" value={cameraId} onChange={(event) => { setCameraId(event.target.value); void start(event.target.value); }} className="!w-auto max-w-[14rem]">
              {cameras.map((camera, index) => (
                <option key={camera.deviceId} value={camera.deviceId}>{camera.label || `Camera ${index + 1}`}</option>
              ))}
            </Select>
          ) : null}
          {torchSupported ? (
            <Button variant="outline" onClick={() => void toggleTorch()} aria-pressed={torchOn}>
              {torchOn ? <FlashlightOff size={14} /> : <Flashlight size={14} />} {torchOn ? "Light off" : "Light on"}
            </Button>
          ) : null}
          <Button variant="ghost" onClick={() => { stop(); setPhase("idle"); }}>Stop camera</Button>
        </div>
      ) : null}
    </div>
  );
}
