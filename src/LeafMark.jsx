/**
 * The Tupande leaf, drawn as vector.
 *
 * This replaces a CSS approximation built from rotated rounded borders, which could never
 * look right: it was a rotated rectangle pretending to be a leaf, so it read as skewed at
 * every size. A path scales cleanly, stays centred in its box and needs no image file.
 *
 * It is used whenever the logo bitmap is missing or fails to load. Drop a real
 * tupande-logo.png into src/assets and that takes precedence automatically.
 */
export default function LeafMark({ size = 26, color = '#2f8f6f', className = '' }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      role="img"
      aria-label="Tupande"
    >
      {/* Right leaf — the larger of the pair, sweeping up and out. */}
      <path
        d="M24.5 31.5C25.8 20.5 32 11 44.5 7c1.2 12.5-4.5 22.5-20 24.5Z"
        fill={color}
      />
      {/* Left leaf, lower and smaller, so the pair reads as a growing shoot. */}
      <path
        d="M23.5 31.5C21.8 23 15.5 17 4.5 16c.5 9.5 7 15.5 19 15.5Z"
        fill={color}
      />
      {/* Stem, curving slightly right to match the mark's balance. */}
      <path
        d="M24 31c-.8 3.5-.6 6.8.8 10.2"
        stroke={color}
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}
