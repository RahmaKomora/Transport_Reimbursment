import { useEffect, useRef, useState } from 'react';

/**
 * A definition kept off the page until somebody asks for it: an ⓘ that opens one short
 * line on tap.
 *
 * Tap rather than hover, because the people reading budgets are as often on a phone as at
 * a desk, and a phone has no hover. The popover is positioned against the screen rather
 * than its parent, so a table that scrolls sideways cannot clip it, and it is kept inside
 * the screen edges on a narrow phone.
 */
export default function Hint({ label, children }) {
  const [place, setPlace] = useState(null);
  const button = useRef(null);
  const WIDTH = 240;

  const toggle = (event) => {
    event.stopPropagation();
    if (place) { setPlace(null); return; }
    const box = button.current.getBoundingClientRect();
    const left = Math.min(Math.max(8, box.left + box.width / 2 - WIDTH / 2), window.innerWidth - WIDTH - 8);
    setPlace({ top: box.bottom + 6, left });
  };

  useEffect(() => {
    if (!place) return undefined;
    const close = () => setPlace(null);
    const onKey = (event) => { if (event.key === 'Escape') close(); };
    // Scrolling moves the ⓘ away from its popover, so it closes. But tapping an ⓘ in a
    // table that scrolls sideways nudges that table as the button takes focus, and that
    // scroll must not shut the popover the moment it opens.
    const openedAt = Date.now();
    const onScroll = () => { if (Date.now() - openedAt > 400) close(); };
    document.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', close);
    };
  }, [place]);

  return <span className="hint">
    <button ref={button} type="button" className="hint-button" onClick={toggle} aria-label={`What is ${label}?`} aria-expanded={Boolean(place)}>ⓘ</button>
    {place && <span className="hint-pop" role="tooltip" style={{ top: place.top, left: place.left, width: WIDTH }} onClick={(event) => event.stopPropagation()}>{children}</span>}
  </span>;
}
