import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { useLanguage } from "../../context/LanguageContext";
import "./AddProduct.css";

interface LiveCameraCaptureProps {
  onCapture: (blob: Blob) => void;
}

type CameraState = "starting" | "ready" | "unavailable";

function CameraIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="13" r="3.5" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

export function LiveCameraCapture({ onCapture }: LiveCameraCaptureProps) {
  const { t } = useLanguage();
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [state, setState] = useState<CameraState>("starting");

  useEffect(() => {
    let cancelled = false;

    async function start() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setState("unavailable");
        return;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });

        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
        setState("ready");
      } catch {
        setState("unavailable");
      }
    }

    start();

    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    };
  }, []);

  function handleCapture() {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) return;

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(
      (blob) => {
        if (blob) onCapture(blob);
      },
      "image/jpeg",
      0.92,
    );
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) onCapture(file);
  }

  if (state === "unavailable") {
    return (
      <div className="camera-fallback">
        <p className="body-s camera-fallback-note">{t("camera.unavailable")}</p>
        <label className="btn btn-primary camera-fallback-label">
          <input
            type="file"
            accept="image/*"
            capture="environment"
            onChange={handleFileChange}
            className="visually-hidden"
          />
          <span className="btn-icon" aria-hidden="true">
            <CameraIcon />
          </span>
          <span>{t("camera.choosePhoto")}</span>
        </label>
      </div>
    );
  }

  return (
    <div className="camera-screen">
      <video ref={videoRef} autoPlay playsInline muted className="camera-video" />
      <div className="camera-scrim" />
      <button
        type="button"
        className="camera-capture-button"
        onClick={handleCapture}
        disabled={state !== "ready"}
        aria-label={t("camera.capture")}
      />
    </div>
  );
}
