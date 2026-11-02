import { useCallback, useEffect, useRef, useState } from 'react';
import { initialsOf } from '../lib/format.js';

const ICONS = {
  chevron: 'M6 9l6 6 6-6',
  undo: 'M9 14L4 9l5-5M4 9h10a6 6 0 010 12h-3',
  redo: 'M15 14l5-5-5-5M20 9H10a6 6 0 000 12h3',
  activity: 'M3 12h4l3 8 4-16 3 8h4',
  settings: 'M4 7h10M18 7h2M4 17h2M10 17h10M14 5v4M6 15v4',
  plus: 'M12 5v14M5 12h14',
  close: 'M6 6l12 12M18 6L6 18',
  clock: 'M12 7v5l3 2M12 3a9 9 0 110 18 9 9 0 010-18z',
  play: 'M7 5l12 7-12 7V5z',
  pause: 'M8 5v14M16 5v14',
  dots: 'M5 12h.01M12 12h.01M19 12h.01',
  grip: 'M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01',
  check: 'M5 12l5 5L20 7',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  calendar: 'M4 9h16M7 3v4M17 3v4M5 5h14a1 1 0 011 1v13a1 1 0 01-1 1H5a1 1 0 01-1-1V6a1 1 0 011-1z',
};

export function Icon({ name, size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  );
}

export function Avatar({ name, color, size = 'md', title, ring }) {
  return (
    <span
      className={`avatar avatar-${size}${ring ? ' avatar-ring' : ''}`}
      style={{ background: color ?? 'var(--muted)' }}
      title={title ?? name}
      aria-label={title ?? name}
      role="img"
    >
      {initialsOf(name)}
    </span>
  );
}

function useDismiss(open, close, ref) {
  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event) => {
      if (!ref.current?.contains(event.target)) close();
    };
    const onKey = (event) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close, ref]);
}

/** A button that opens a popover. `children` receives `close`. */
export function Popover({ trigger, label, children, align = 'start', className = '', onOpen }) {
  const [open, setOpen] = useState(false);
  const root = useRef(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, close, root);
  return (
    <div className={`popover-root ${className}`} ref={root}>
      <button
        type="button"
        className="popover-trigger"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={label}
        onClick={() => {
          if (!open) onOpen?.();
          setOpen(!open);
        }}
      >
        {trigger}
      </button>
      {open && <div className={`popover popover-${align}`}>{children(close)}</div>}
    </div>
  );
}

export function MenuItem({ children, onClick, active, danger, disabled }) {
  return (
    <button
      type="button"
      className={`menu-item${active ? ' is-active' : ''}${danger ? ' is-danger' : ''}`}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

/** A native modal dialog: focus trapping and Escape come with it. */
export function Dialog({ title, onClose, children, width = 520 }) {
  const ref = useRef(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog.open) dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="dialog"
      style={{ width: `min(${width}px, calc(100vw - 32px))` }}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
    >
      <div className="dialog-body">
        <header className="dialog-head">
          <h2>{title}</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </header>
        {children}
      </div>
    </dialog>
  );
}

/** A one-field form, for "new branch", "rename board" and the like. */
export function NameForm({ label, initial = '', submitLabel, onSubmit, onCancel, placeholder }) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="name-form"
      onSubmit={async (event) => {
        event.preventDefault();
        const name = value.trim();
        if (!name) return;
        setBusy(true);
        setError(null);
        try {
          await onSubmit(name);
          setValue('');
        } catch (err) {
          setError(err.message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="field">
        <span className="field-label">{label}</span>
        <input autoFocus value={value} placeholder={placeholder} maxLength={120} onChange={(e) => setValue(e.target.value)} />
      </label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="form-actions">
        {onCancel && (
          <button type="button" className="button" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button type="submit" className="button button-primary" disabled={busy || !value.trim()}>
          {submitLabel}
        </button>
      </div>
    </form>
  );
}
