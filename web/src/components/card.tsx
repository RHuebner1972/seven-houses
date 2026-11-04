"use client";

import { useState } from "react";
import { BACK_URL, cardAlt, cardById, imageUrl } from "@/lib/cards";

const SIZES = {
  sm: { width: 72, height: 108 },
  md: { width: 160, height: 240 },
  lg: { width: 240, height: 360 },
} as const;

type CardProps = {
  id: string;
  reversed?: boolean;
  faceUp: boolean;
  onFlip?: () => void;
  size?: keyof typeof SIZES;
  className?: string;
};

const FACE = "absolute inset-0 h-full w-full [backface-visibility:hidden]";

export function Card({
  id,
  reversed = false,
  faceUp,
  onFlip,
  size = "md",
  className = "",
}: CardProps) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const dims = SIZES[size];
  const failed = failedSrc === imageUrl(id);
  const style = { width: dims.width, height: dims.height, perspective: 1000 };
  const interactive = onFlip !== undefined && !faceUp;

  const inner = (
    <div
      className="relative h-full w-full transition-transform duration-[600ms] motion-reduce:transition-none"
      style={{
        transformStyle: "preserve-3d",
        transform: faceUp ? "rotateY(180deg)" : "rotateY(0deg)",
      }}
    >
      <div className={FACE} aria-hidden={faceUp}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={BACK_URL} alt="" draggable={false} className="h-full w-full rounded-[4%] object-cover" />
      </div>
      <div className={FACE} aria-hidden={!faceUp} style={{ transform: "rotateY(180deg)" }}>
        {failed ? (
          <div className="flex h-full w-full items-center justify-center rounded-[4%] border-2 border-gold bg-bg p-2 text-center font-display text-gold-hi">
            <span className="inline-block" style={{ transform: reversed ? "rotate(180deg)" : undefined }}>
              {cardById(id).name}
            </span>
          </div>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={imageUrl(id)}
            alt={cardAlt(id, reversed)}
            draggable={false}
            onError={() => setFailedSrc(imageUrl(id))}
            className="h-full w-full rounded-[4%] object-cover"
            style={{ transform: reversed ? "rotate(180deg)" : undefined }}
          />
        )}
      </div>
    </div>
  );

  if (interactive) {
    return (
      <button
        type="button"
        aria-label="Reveal card"
        onClick={onFlip}
        className={`block cursor-pointer rounded-[4%] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold ${className}`}
        style={style}
      >
        {inner}
      </button>
    );
  }
  return (
    <div className={className} style={style}>
      {inner}
    </div>
  );
}
