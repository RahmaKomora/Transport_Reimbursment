import { useEffect, useRef, useState } from 'react';

/**
 * Google's own sign-in button.
 *
 * The library is loaded on demand rather than bundled, because Google requires it to be
 * served from their origin and it is only needed on this one screen.
 *
 * The button hands back an ID token, which the browser cannot usefully inspect or forge:
 * the server verifies it against Google's keys, so nothing here decides who gets in.
 */
const SRC = 'https://accounts.google.com/gsi/client';

function loadLibrary() {
  if (window.google?.accounts?.id) return Promise.resolve();
  const existing = document.querySelector(`script[src="${SRC}"]`);
  if (existing) return new Promise((resolve, reject) => {
    existing.addEventListener('load', resolve);
    existing.addEventListener('error', () => reject(new Error('blocked')));
  });
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SRC;
    script.async = true;
    script.onload = resolve;
    script.onerror = () => reject(new Error('blocked'));
    document.head.appendChild(script);
  });
}

export default function GoogleSignIn({ clientId, domain, onCredential, disabled }) {
  const slot = useRef(null);
  const [failed, setFailed] = useState('');

  useEffect(() => {
    let cancelled = false;
    loadLibrary()
      .then(() => {
        if (cancelled || !slot.current) return;
        window.google.accounts.id.initialize({
          client_id: clientId,
          callback: (response) => onCredential(response.credential),
          // Narrows the account chooser to the organisation. The server checks this
          // again, because a hint in the browser is a convenience, not a control.
          hosted_domain: domain || undefined,
          cancel_on_tap_outside: true,
        });
        window.google.accounts.id.renderButton(slot.current, {
          theme: 'outline', size: 'large', width: 320, text: 'signin_with', shape: 'pill',
        });
      })
      .catch(() => { if (!cancelled) setFailed('Google sign-in could not load. Check your connection and refresh.'); });
    return () => { cancelled = true; };
  }, [clientId, domain, onCredential]);

  if (failed) return <p className="login-error">{failed}</p>;

  return <div className={`google-signin ${disabled ? 'busy' : ''}`}>
    <div ref={slot} />
  </div>;
}
