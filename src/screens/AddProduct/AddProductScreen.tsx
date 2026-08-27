import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { LiveCameraCapture } from "./LiveCameraCapture";
import { PhotoReviewFlow } from "./PhotoReviewFlow";

export function AddProductScreen() {
  const navigate = useNavigate();
  const [capturedBlob, setCapturedBlob] = useState<Blob | null>(null);

  function handleRetake() {
    setCapturedBlob(null);
  }

  function handleDone() {
    console.info("proceeding to next step");
    navigate("/add-product/describe");
  }

  if (!capturedBlob) {
    return <LiveCameraCapture onCapture={setCapturedBlob} />;
  }

  return <PhotoReviewFlow blob={capturedBlob} onRetake={handleRetake} onDone={handleDone} />;
}
