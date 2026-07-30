export function randomId(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}

/**
 * Product timestamps are persisted as plain China Standard Time (UTC+8)
 * strings.  They deliberately carry no offset: consumers must display and
 * filter the stored wall-clock time as-is, without performing timezone
 * conversion.
 */
export function localTimestamp(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23"
    }).formatToParts(date).map((part) => [part.type, part.value])
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}
