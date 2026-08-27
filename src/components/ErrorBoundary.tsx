import { Component, type ReactNode } from "react";
import "./ErrorBoundary.css";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: unknown, info: unknown) {
    console.error("Unhandled error", error, info);
  }

  render() {
    if (this.state.hasError) {
      const isHindi = document.documentElement.lang === "hi";
      return (
        <div className="error-boundary">
          <h1>{isHindi ? "कुछ गलत हो गया" : "Something went wrong"}</h1>
          <p className="body-s">
            {isHindi ? "कृपया पेज को फिर से लोड करें।" : "Please reload the page and try again."}
          </p>
          <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
            {isHindi ? "फिर से लोड करें" : "Reload"}
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
