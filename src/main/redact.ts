/** Strip anything that looks like an API key from error text before it crosses the bridge or hits a log. */
export function redactSecrets(msg: string): string {
  return msg.replace(/\b(sk-[A-Za-z0-9_-]{8,}|[A-Za-z0-9_-]{32,})\b/g, '[redacted]');
}
