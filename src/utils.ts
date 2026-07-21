export function randomId(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}
