import { useEffect, useRef } from "react";
import { X } from "lucide-react";

export default function Dialog({ open, onClose, title, children }) {
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open) {
      if (!el.open) el.showModal();
    } else if (el.open) {
      el.close();
    }
  }, [open]);

  if (!open) return null;

  return (
    <dialog
      ref={ref}
      className="dialog"
      onCancel={(e) => {
        e.preventDefault();
        onClose?.();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose?.();
      }}
    >
      <div className="dialog-head">
        <h3 className="dialog-title">{title}</h3>
        <button type="button" className="button button-ghost button-icon" aria-label="Close" onClick={onClose}>
          <X />
        </button>
      </div>
      <div className="dialog-body">{children}</div>
    </dialog>
  );
}
