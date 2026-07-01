import { useEffect } from "react";
import { createPortal } from "react-dom";

// Shared full-text prompt/assistant modal for the skin cards (the instrument
// card has its own). Styled via palette props so it matches the active look.
export interface PromptPopupProps {
  text: string;
  label?: string;
  onClose: () => void;
  bg: string;
  border: string;
  ink: string;
  muted: string;
  fontBody: string;
  italic?: boolean;
}

export function PromptPopup({ text, label = "Last prompt", onClose, bg, border, ink, muted, fontBody, italic }: PromptPopupProps) {
  useEffect(() => {
    const h = () => onClose();
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [onClose]);

  return createPortal(
    <div style={{ position: "fixed", inset: 0, zIndex: 99999, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.35)", backdropFilter: "blur(4px)", WebkitBackdropFilter: "blur(4px)" }}>
      <div
        // Stop mousedown (not just click) from reaching the document-level
        // outside-close handler: without this, starting a text selection of the
        // prompt or grabbing the scrollbar fires a mousedown inside the content
        // that bubbles to document and instantly dismisses the popup. A genuine
        // mousedown on the backdrop still bubbles through and closes it.
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        style={{
          background: bg,
          border: `1px solid ${border}`,
          borderRadius: 12,
          padding: "18px 22px",
          maxWidth: text.length > 300 ? 640 : 440,
          width: "calc(100% - 48px)",
          maxHeight: "70vh",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 24px 64px rgba(0,0,0,0.4), 0 4px 16px rgba(0,0,0,0.3)",
          fontFamily: fontBody,
          animation: "prompt-popup-in 0.15s cubic-bezier(0.34, 1.4, 0.64, 1) forwards",
        }}
      >
        <div style={{ fontSize: "0.62rem", fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: muted, marginBottom: 8, flexShrink: 0 }}>{label}</div>
        <div style={{ fontSize: "0.85rem", lineHeight: 1.6, color: ink, fontStyle: italic ? "italic" : "normal", wordBreak: "break-word", overflowY: "auto", whiteSpace: "pre-wrap" }}>{text}</div>
      </div>
    </div>,
    document.body,
  );
}
