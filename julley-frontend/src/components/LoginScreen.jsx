import { useState } from 'react';
import { useSession } from '../store/session.js';
import { LoginShowcase } from './LoginShowcase.jsx';

const DEMO_USERS = [
  ['alice@acme.test', 'Org admin, Acme'],
  ['ben@acme.test', 'Branch admin, Mumbai'],
  ['cara@acme.test', 'Member, Mumbai + Berlin'],
  ['dan@acme.test', 'Branch admin, Berlin'],
  ['gina@globex.test', 'Org admin, Globex'],
  ['hank@globex.test', 'Member, Austin'],
];

export function LoginScreen() {
  const signIn = useSession((state) => state.signIn);
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ email: '', password: '', name: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const isRegister = mode === 'register';

  const update = (field) => (event) => setForm({ ...form, [field]: event.target.value });

  const submit = async (credentials) => {
    setBusy(true);
    setError(null);
    try {
      await signIn(isRegister ? 'register' : 'login', credentials);
    } catch (err) {
      setError(err.network ? "Can't reach the server. Is the API running?" : err.message);
      setBusy(false);
    }
  };

  return (
    <main className="login">
      <section className="login-intro">
        <div className="brand brand-large">Tenant Flow</div>
        <p className="login-lede">Every branch sees its own board change, live. Nobody else sees anything.</p>
        <LoginShowcase />
      </section>

      <section className="login-panel">
        <h1>{isRegister ? 'Create your account' : 'Sign in'}</h1>
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            submit(isRegister ? form : { email: form.email, password: form.password });
          }}
        >
          {isRegister && (
            <label className="field">
              <span className="field-label">Name</span>
              <input required autoComplete="name" value={form.name} onChange={update('name')} />
            </label>
          )}
          <label className="field">
            <span className="field-label">Email</span>
            <input required type="email" autoComplete="email" value={form.email} onChange={update('email')} />
          </label>
          <label className="field">
            <span className="field-label">Password</span>
            <input
              required
              type="password"
              minLength={isRegister ? 8 : undefined}
              autoComplete={isRegister ? 'new-password' : 'current-password'}
              value={form.password}
              onChange={update('password')}
            />
          </label>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button type="submit" className="button button-primary button-wide" disabled={busy}>
            {isRegister ? 'Create account' : 'Sign in'}
          </button>
        </form>
        <button
          type="button"
          className="link-button"
          onClick={() => {
            setMode(isRegister ? 'login' : 'register');
            setError(null);
          }}
        >
          {isRegister ? 'I already have an account' : 'Create an account'}
        </button>

        {import.meta.env.DEV && !isRegister && (
          <div className="demo-users">
            <h2>Demo accounts</h2>
            <p>Password for all: password123</p>
            <ul>
              {DEMO_USERS.map(([email, role]) => (
                <li key={email}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setForm({ ...form, email, password: 'password123' });
                      submit({ email, password: 'password123' });
                    }}
                  >
                    <span>{email}</span>
                    <small>{role}</small>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </main>
  );
}
