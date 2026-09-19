// The v1 "we moved!" banner. Removed from App in the redesign, file left behind.
export function LegacyBanner({ message }: { message: string }) {
  return (
    <div className="legacy-banner" role="status">
      <strong>Heads up:</strong> {message}
    </div>
  );
}
