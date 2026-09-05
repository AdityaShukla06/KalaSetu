import type { CSSProperties } from "react";
import "./Skeleton.css";

interface SkeletonProps {
  width?: string | number;
  height?: string | number;
  borderRadius?: string;
  className?: string;
}

export function Skeleton({ width = "100%", height = "1em", borderRadius, className }: SkeletonProps) {
  const style: CSSProperties = { width, height };
  if (borderRadius) style.borderRadius = borderRadius;

  return <span className={["skeleton", className].filter(Boolean).join(" ")} style={style} aria-hidden="true" />;
}
