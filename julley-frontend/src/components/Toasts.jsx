import { useToasts } from '../store/toasts.js';
import { Icon } from './ui.jsx';

export function Toasts() {
  const toasts = useToasts((state) => state.toasts);
  const dismiss = useToasts((state) => state.dismiss);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast-${toast.tone}`} data-testid="toast">
          <p>{toast.message}</p>
          <button type="button" className="icon-button" onClick={() => dismiss(toast.id)} aria-label="Dismiss">
            <Icon name="close" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
