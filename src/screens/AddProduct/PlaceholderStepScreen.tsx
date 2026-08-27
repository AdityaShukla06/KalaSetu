import { useNavigate } from "react-router-dom";
import { Button } from "../../components/Button";

interface PlaceholderStepScreenProps {
  title: string;
  message: string;
}

function BackIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M19 12H5M11 6l-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function PlaceholderStepScreen({ title, message }: PlaceholderStepScreenProps) {
  const navigate = useNavigate();

  return (
    <div className="screen">
      <div style={{ paddingTop: "var(--space-6)", display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
        <h1>{title}</h1>
        <p className="body-s" style={{ color: "var(--color-text-muted)" }}>
          {message}
        </p>
        <Button variant="secondary" icon={<BackIcon />} onClick={() => navigate("/")}>
          Back to My Shop
        </Button>
      </div>
    </div>
  );
}
